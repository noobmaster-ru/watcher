// Листы-витрины: то, на что смотрят глазами.
//
// Листы «Товары», «Продавцы», «Ключевые слова» — служебные: туда история
// дописывается строками и оттуда её удобно тянуть формулами. Витрины устроены
// наоборот: метрики идут строками, а дни — колонками вправо, так что таблица
// растёт горизонтально по мере накопления истории. Слева от дней — спарклайн,
// минимум, максимум и последнее значение, чтобы картина читалась без прокрутки.
//
// Витрины не дописываются, а пересчитываются целиком: это производная от
// истории, и хранить в них курсор было бы лишней сущностью.

import { sql } from "drizzle-orm";
import { imageUrl, productUrl } from "@watcher/wb-core";
import { db, rowsOf } from "../db/client.js";
import type { GoogleApi } from "./google.js";

export const SHEET_SUMMARY = "Сводка";

/** Сколько дней показывать в витринах. Год истории — предел читаемости. */
const DAYS = 60;
/**
 * Для скольких товаров заводить личные листы. Подписка на продавца приносит
 * сотни артикулов, и лист на каждый превратил бы таблицу в нечитаемую и
 * упёрся бы в квоты Google, поэтому личные листы — только у товаров, которые
 * пользователь добавил сам.
 */
const MAX_PRODUCT_SHEETS = 20;

export interface DayValue {
  day: string;
  price: number | null;
  inStock: boolean;
  quantity: number | null;
}

export interface ProductSeries {
  nm: number;
  name: string;
  brand: string;
  supplier: string;
  rating: number | null;
  reviews: number | null;
  lastPrice: number | null;
  lastBasic: number | null;
  own: boolean;
  days: DayValue[];
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Последние DAYS дат, включая сегодняшнюю. */
export function dayRange(today = new Date()): string[] {
  const days: string[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    days.push(isoDay(new Date(today.getTime() - i * 86_400_000)));
  }
  return days;
}

/**
 * Раскладывает историю по дням. В дни без наблюдений цена не пустая, а
 * перенесённая с предыдущего дня: цена держится, пока её не изменили, и дырка
 * в графике означала бы «товар пропал», чего на самом деле не было.
 */
export function buildSeries(
  points: Array<{ day: string; price: number | null; inStock: boolean; quantity: number | null }>,
  days: string[],
  before: { price: number | null; inStock: boolean } | null,
): DayValue[] {
  const byDay = new Map(points.map((p) => [p.day, p]));
  let carriedPrice = before?.price ?? null;
  let carriedStock = before?.inStock ?? false;
  let started = before !== null;

  return days.map((day) => {
    const point = byDay.get(day);
    if (point) {
      carriedPrice = point.price;
      carriedStock = point.inStock;
      started = true;
      return { day, price: point.price, inStock: point.inStock, quantity: point.quantity };
    }
    // до первого наблюдения показывать нечего
    return { day, price: started ? carriedPrice : null, inStock: started ? carriedStock : false, quantity: null };
  });
}

/** Средние цены по дням для всех товаров пользователя. */
export async function loadSeries(userId: number, days: string[]): Promise<ProductSeries[]> {
  const from = days[0];

  const productRows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select p.nm, p.name, p.brand, p.supplier_name, p.rating, p.reviews,
             p.last_price, p.last_basic,
             bool_or(w.nm is not null) as own
        from products p
        join watches w on w.is_active and w.user_id = ${userId}
                      and (w.nm = p.nm or (w.supplier_id is not null and w.supplier_id = p.supplier_id))
       group by p.nm
       order by bool_or(w.nm is not null) desc, p.name
    `),
  );
  if (productRows.length === 0) return [];

  const nms = productRows.map((r) => Number(r.nm));

  // среднее по дню: за сутки цена могла меняться несколько раз
  const daily = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select nm,
             to_char(checked_at at time zone 'UTC', 'YYYY-MM-DD') as day,
             round(avg(price))::int as price,
             bool_or(in_stock) as in_stock,
             max(quantity)::int as quantity
        from price_points
       where nm = any(${sql.raw(`array[${nms.join(",")}]::bigint[]`)})
         and checked_at >= ${from}::date
       group by nm, 2
       order by nm, 2
    `),
  );

  // последнее значение до окна: с него начинается перенос цены вперёд
  const earlier = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select distinct on (nm) nm, price, in_stock
        from price_points
       where nm = any(${sql.raw(`array[${nms.join(",")}]::bigint[]`)})
         and checked_at < ${from}::date
       order by nm, checked_at desc
    `),
  );
  const beforeByNm = new Map(
    earlier.map((r) => [Number(r.nm), { price: r.price === null ? null : Number(r.price), inStock: Boolean(r.in_stock) }]),
  );

  const pointsByNm = new Map<number, Array<{ day: string; price: number | null; inStock: boolean; quantity: number | null }>>();
  for (const row of daily) {
    const nm = Number(row.nm);
    const list = pointsByNm.get(nm) ?? [];
    list.push({
      day: String(row.day),
      price: row.price === null ? null : Number(row.price),
      inStock: Boolean(row.in_stock),
      quantity: row.quantity === null ? null : Number(row.quantity),
    });
    pointsByNm.set(nm, list);
  }

  return productRows.map((row) => {
    const nm = Number(row.nm);
    return {
      nm,
      name: String(row.name ?? ""),
      brand: String(row.brand ?? ""),
      supplier: String(row.supplier_name ?? ""),
      rating: row.rating === null ? null : Number(row.rating),
      reviews: row.reviews === null ? null : Number(row.reviews),
      lastPrice: row.last_price === null ? null : Number(row.last_price),
      lastBasic: row.last_basic === null ? null : Number(row.last_basic),
      own: Boolean(row.own),
      days: buildSeries(pointsByNm.get(nm) ?? [], days, beforeByNm.get(nm) ?? null),
    };
  });
}

// ── формулы ──────────────────────────────────────────────────────────────────
// Только односоставные формы: у формул с несколькими аргументами разделитель
// зависит от локали таблицы (в русской это «;», в английской «,»), и угадывать
// его — надёжный способ получить #ERROR у половины пользователей.
const image = (nm: number) => `=IMAGE("${imageUrl(nm)}")`;
const sparkline = (row: number, firstCol: string, lastCol: string) => `=SPARKLINE(${firstCol}${row}:${lastCol}${row})`;
const link = (nm: number) => `=HYPERLINK("${productUrl(nm)}")`;

/** Буквенное имя колонки: 1 → A, 27 → AA. */
export function columnName(index: number): string {
  let value = index;
  let name = "";
  while (value > 0) {
    const rest = (value - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/**
 * Заголовок дня остаётся настоящей датой, а не строкой «01.08»: такую строку
 * Google в русской локали всё равно распознаёт как дату и показывает порядковым
 * числом вроде 46188. Поэтому пишем дату как есть, а вид «01.08» задаём
 * форматом ячейки — заодно по этим заголовкам можно строить графики и сортировать.
 */
const shortDay = (day: string): string => day;

// ── сводный лист ─────────────────────────────────────────────────────────────
/** Одна строка на товар: фото, артикул, цена, спарклайн и колонки по дням. */
export function buildSummaryGrid(series: ProductSeries[], days: string[]): Array<Array<string | number | null>> {
  const FIXED = 9; // столбцы до дней
  const firstDayCol = columnName(FIXED + 1);
  const lastDayCol = columnName(FIXED + days.length);

  const header = [
    "Фото",
    "Артикул",
    "Название",
    "Бренд",
    "Продавец",
    "Цена сейчас",
    "Минимум",
    "Максимум",
    "График цены",
    ...days.map(shortDay),
  ];

  const rows = series.map((product, index) => {
    const prices = product.days.map((d) => d.price).filter((p): p is number => p !== null);
    const row = index + 2; // первая строка — шапка
    return [
      image(product.nm),
      product.nm,
      product.name,
      product.brand,
      product.supplier,
      product.lastPrice ?? "нет в продаже",
      prices.length > 0 ? Math.min(...prices) : "",
      prices.length > 0 ? Math.max(...prices) : "",
      sparkline(row, firstDayCol, lastDayCol),
      ...product.days.map((d) => d.price ?? ""),
    ];
  });

  return [header, ...rows];
}

// ── лист одного товара ───────────────────────────────────────────────────────
/**
 * Метрики строками, дни колонками — как в образце: слева спарклайн, минимум,
 * максимум и последнее значение, дальше вправо растут дни.
 */
export function buildProductGrid(product: ProductSeries, days: string[]): Array<Array<string | number | null>> {
  const FIXED = 6;
  const firstDayCol = columnName(FIXED + 1);
  const lastDayCol = columnName(FIXED + days.length);

  const metrics: Array<{ title: string; values: Array<number | string> }> = [];
  const add = (title: string, values: Array<number | string>) => metrics.push({ title, values });

  add("Цена, ₽", product.days.map((d) => d.price ?? ""));
  add(
    "Цена с WB Кошельком, ₽",
    product.days.map((d) => (d.price === null ? "" : Math.round(d.price * 0.98))),
  );
  add("Остаток, шт", product.days.map((d) => d.quantity ?? ""));
  add("В наличии", product.days.map((d) => (d.price === null ? "" : d.inStock ? 1 : 0)));

  // строки: 1 фото/название, 2 продавец, 3 пусто, 4 шапка, дальше метрики
  const headerRow = 4;
  const grid: Array<Array<string | number | null>> = [
    [image(product.nm), product.name, "", "", "", "", ...days.map(() => "")],
    ["", `Артикул ${product.nm}`, link(product.nm), "", "", "", ...days.map(() => "")],
    [
      "",
      product.supplier,
      product.brand,
      product.rating === null ? "" : `★ ${product.rating}`,
      product.reviews === null ? "" : `${product.reviews} отзывов`,
      "",
      ...days.map(() => ""),
    ],
    ["Метрика", "График", "Минимум", "Максимум", "Последнее", "", ...days.map(shortDay)],
  ];

  metrics.forEach((metric, index) => {
    const row = headerRow + 1 + index;
    // Минимум, максимум и последнее считаем здесь, а не формулами: формулы с
    // несколькими аргументами разделяются то запятой, то точкой с запятой —
    // в зависимости от локали таблицы, и в чужой локали они дают #ERROR.
    const numbers = metric.values.filter((v): v is number => typeof v === "number");
    const last = [...metric.values].reverse().find((v) => v !== "");
    grid.push([
      metric.title,
      sparkline(row, firstDayCol, lastDayCol),
      numbers.length > 0 ? Math.min(...numbers) : "",
      numbers.length > 0 ? Math.max(...numbers) : "",
      last ?? "",
      "",
      ...metric.values,
    ]);
  });

  return grid;
}

/** Товары, которым положен личный лист. */
export function ownProducts(series: ProductSeries[]): ProductSeries[] {
  return series.filter((product) => product.own).slice(0, MAX_PRODUCT_SHEETS);
}

export { DAYS, MAX_PRODUCT_SHEETS };

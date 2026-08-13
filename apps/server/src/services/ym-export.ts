// Выгрузка Яндекс Маркета в отдельную таблицу.
//
// Устроена как выгрузка Wildberries: служебный лист «Товары», куда история
// дописывается строками по курсору, и витрина «Сводка», которая считается
// заново и растёт вправо по дням. Отличий два: у Маркета нет продавцов и
// ключевых слов, а идентификатор товара — sku, поэтому таблицы свои.

import { and, eq, sql } from "drizzle-orm";
import { db, rowsOf } from "../db/client.js";
import { userSheets } from "../db/schema.js";
import type { GoogleApi } from "./google.js";
import { SHEET_PRODUCTS, SheetNotLinkedError, YM_SHEETS } from "./export.js";
import {
  SHEET_SUMMARY,
  buildSeries,
  columnName,
  dayRange,
  type DayValue,
} from "./dashboard.js";

const BATCH = 2000;
const HEADERS = ["Дата", "Номер товара", "Название", "Цена", "В наличии", "Ссылка"];

const asDate = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().replace("T", " ").slice(0, 19);
};

export interface YmExportResult {
  spreadsheetUrl: string;
  products: number;
  dashboards: number;
}

/** Дописывает новые точки истории и перерисовывает витрину. */
export async function exportYm(api: GoogleApi, userId: number): Promise<YmExportResult> {
  const [state] = await db
    .select()
    .from(userSheets)
    .where(and(eq(userSheets.userId, userId), eq(userSheets.marketplace, "ym")))
    .limit(1);
  if (!state) throw new SheetNotLinkedError(api.email);

  try {
    await api.ensureSheets(state.spreadsheetId, YM_SHEETS);

    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select pp.id, pp.checked_at, pp.sku, p.name, pp.price, pp.in_stock, p.url
          from ym_price_points pp
          join ym_products p on p.sku = pp.sku
         where pp.id > ${state.cursorPricePoint}
           and exists (
             select 1 from ym_watches w
              where w.user_id = ${userId} and w.is_active and w.sku = pp.sku
           )
         order by pp.id
         limit ${BATCH}
      `),
    );

    if (rows.length > 0) {
      await api.appendRows(
        state.spreadsheetId,
        SHEET_PRODUCTS,
        rows.map((r) => [
          asDate(r.checked_at),
          String(r.sku ?? ""),
          String(r.name ?? ""),
          r.price === null ? "" : Number(r.price),
          r.in_stock ? "да" : "нет",
          String(r.url ?? ""),
        ]),
      );
    }

    const dashboards = await refreshYmDashboard(api, userId, state.spreadsheetId);

    await db
      .update(userSheets)
      .set({
        cursorPricePoint: rows.length > 0 ? Number(rows[rows.length - 1]?.id) : state.cursorPricePoint,
        lastExportAt: new Date(),
        lastError: null,
      })
      .where(and(eq(userSheets.userId, userId), eq(userSheets.marketplace, "ym")));

    return { spreadsheetUrl: state.spreadsheetUrl, products: rows.length, dashboards };
  } catch (error) {
    await db
      .update(userSheets)
      .set({ lastError: (error as Error).message })
      .where(and(eq(userSheets.userId, userId), eq(userSheets.marketplace, "ym")));
    throw error;
  }
}

interface YmSeries {
  sku: string;
  name: string;
  image: string | null;
  url: string | null;
  lastPrice: number | null;
  days: DayValue[];
}

/** Дневные ряды по товарам Маркета, которые отслеживает пользователь. */
async function loadYmSeries(userId: number, days: string[]): Promise<YmSeries[]> {
  const products = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select p.sku, p.name, p.image, p.url, p.last_price
        from ym_products p
        join ym_watches w on w.sku = p.sku and w.is_active and w.user_id = ${userId}
       group by p.sku
       order by p.name
    `),
  );
  if (products.length === 0) return [];

  const from = days[0];
  const daily = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select pp.sku,
             to_char(pp.checked_at at time zone 'UTC', 'YYYY-MM-DD') as day,
             round(avg(pp.price))::int as price,
             bool_or(pp.in_stock) as in_stock
        from ym_price_points pp
        join ym_watches w on w.sku = pp.sku and w.is_active and w.user_id = ${userId}
       where pp.checked_at >= ${from}::date
       group by pp.sku, 2
       order by pp.sku, 2
    `),
  );

  const bySku = new Map<string, Array<{ day: string; price: number | null; inStock: boolean; quantity: null }>>();
  for (const row of daily) {
    const sku = String(row.sku);
    const list = bySku.get(sku) ?? [];
    list.push({
      day: String(row.day),
      price: row.price === null ? null : Number(row.price),
      inStock: Boolean(row.in_stock),
      quantity: null,
    });
    bySku.set(sku, list);
  }

  return products.map((row) => {
    const sku = String(row.sku);
    return {
      sku,
      name: String(row.name ?? ""),
      image: row.image ? String(row.image) : null,
      url: row.url ? String(row.url) : null,
      lastPrice: row.last_price === null ? null : Number(row.last_price),
      days: buildSeries(bySku.get(sku) ?? [], days, null),
    };
  });
}

/** Витрина Маркета: строка на товар, дни колонками вправо. */
export function buildYmSummary(series: YmSeries[], days: string[]): Array<Array<string | number | null>> {
  const FIXED = 7;
  const firstDayCol = columnName(FIXED + 1);
  const lastDayCol = columnName(FIXED + days.length);

  const header = ["Фото", "Номер товара", "Название", "Цена сейчас", "Минимум", "Максимум", "График цены", ...days];

  const rows = series.map((product, index) => {
    const prices = product.days.map((d) => d.price).filter((p): p is number => p !== null);
    const row = index + 2;
    return [
      product.image ? `=IMAGE("${product.image}")` : "",
      product.sku,
      product.name,
      product.lastPrice ?? "нет в продаже",
      prices.length > 0 ? Math.min(...prices) : "",
      prices.length > 0 ? Math.max(...prices) : "",
      `=SPARKLINE(${firstDayCol}${row}:${lastDayCol}${row})`,
      ...product.days.map((d) => d.price ?? ""),
    ];
  });

  return [header, ...rows];
}

async function refreshYmDashboard(api: GoogleApi, userId: number, spreadsheetId: string): Promise<number> {
  const first = rowsOf<{ first: string | null }>(
    await db.execute(sql`
      select min(pp.checked_at) as first
        from ym_price_points pp
        join ym_watches w on w.sku = pp.sku and w.is_active and w.user_id = ${userId}
    `),
  )[0]?.first;

  const days = dayRange(new Date(), first ? new Date(first) : null);
  const series = await loadYmSeries(userId, days);
  if (series.length === 0) return 0;

  await api.ensureSheets(spreadsheetId, [SHEET_SUMMARY]);
  await api.clearSheet(spreadsheetId, SHEET_SUMMARY);
  await api.writeRange(spreadsheetId, `${SHEET_SUMMARY}!A1`, buildYmSummary(series, days));

  const meta = await api.describe(spreadsheetId);
  const sheetId = meta.sheets.find((sheet) => sheet.title === SHEET_SUMMARY)?.id;
  if (sheetId !== undefined) {
    await api.formatSheet(spreadsheetId, [
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 3 } },
          fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 1, green: 0.95, blue: 0.8 } } },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 7, endColumnIndex: 7 + days.length },
          cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd.MM" }, horizontalAlignment: "CENTER" } },
          fields: "userEnteredFormat(numberFormat,horizontalAlignment)",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 400 },
          properties: { pixelSize: 72 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 70 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
          properties: { pixelSize: 240 },
          fields: "pixelSize",
        },
      },
    ]);
  }
  return 1;
}

/** Пользователи, у которых есть что выгружать с Маркета. */
export async function ymUsersToExport(): Promise<number[]> {
  const rows = rowsOf<{ user_id: number }>(
    await db.execute(sql`select distinct user_id from ym_watches where is_active`),
  );
  return rows.map((r) => Number(r.user_id));
}

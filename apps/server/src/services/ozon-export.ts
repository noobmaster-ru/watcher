// Выгрузка Озона в отдельную (третью) Гугл-таблицу. Устройство — как у
// Маркета: служебный лист «Товары» дописывается по курсору, витрина «Сводка»
// пересчитывается и растёт вправо по дням. Дополнительно к обычной цене в
// историю пишется цена с Ozon Картой.

import { and, eq, sql } from "drizzle-orm";
import { db, rowsOf } from "../db/client.js";
import { userSheets } from "../db/schema.js";
import type { GoogleApi } from "./google.js";
import { SHEET_PRODUCTS, SheetNotLinkedError } from "./export.js";
import { SHEET_SUMMARY, buildSeries, columnName, dayRange, type DayValue } from "./dashboard.js";

const BATCH = 2000;
export const OZON_SHEETS = [SHEET_PRODUCTS];
const HEADERS = ["Дата", "Номер товара", "Название", "Цена", "Цена с Ozon Картой", "В наличии", "Ссылка"];

const asDate = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().replace("T", " ").slice(0, 19);
};

export interface OzonExportResult {
  spreadsheetUrl: string;
  products: number;
  dashboards: number;
}

export async function exportOzon(api: GoogleApi, userId: number): Promise<OzonExportResult> {
  const [state] = await db
    .select()
    .from(userSheets)
    .where(and(eq(userSheets.userId, userId), eq(userSheets.marketplace, "ozon")))
    .limit(1);
  if (!state) throw new SheetNotLinkedError(api.email);

  try {
    await api.ensureSheets(state.spreadsheetId, OZON_SHEETS);
    const header = await api.firstRow(state.spreadsheetId, SHEET_PRODUCTS);
    if (header.length === 0) await api.appendRows(state.spreadsheetId, SHEET_PRODUCTS, [HEADERS]);

    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select pp.id, pp.checked_at, pp.sku, p.name, pp.price, pp.card_price, pp.in_stock, p.url
          from ozon_price_points pp
          join ozon_products p on p.sku = pp.sku
         where pp.id > ${state.cursorPricePoint}
           and exists (
             select 1 from ozon_watches w
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
          r.card_price === null ? "" : Number(r.card_price),
          r.in_stock ? "да" : "нет",
          String(r.url ?? ""),
        ]),
      );
    }

    const dashboards = await refreshOzonDashboard(api, userId, state.spreadsheetId);

    await db
      .update(userSheets)
      .set({
        cursorPricePoint: rows.length > 0 ? Number(rows[rows.length - 1]?.id) : state.cursorPricePoint,
        lastExportAt: new Date(),
        lastError: null,
      })
      .where(and(eq(userSheets.userId, userId), eq(userSheets.marketplace, "ozon")));

    return { spreadsheetUrl: state.spreadsheetUrl, products: rows.length, dashboards };
  } catch (error) {
    await db
      .update(userSheets)
      .set({ lastError: (error as Error).message })
      .where(and(eq(userSheets.userId, userId), eq(userSheets.marketplace, "ozon")));
    throw error;
  }
}

interface OzonSeries {
  sku: string;
  name: string;
  image: string | null;
  lastPrice: number | null;
  lastCardPrice: number | null;
  days: DayValue[];
}

async function loadOzonSeries(userId: number, days: string[]): Promise<OzonSeries[]> {
  const products = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select p.sku, p.name, p.image, p.last_price, p.last_card_price
        from ozon_products p
        join ozon_watches w on w.sku = p.sku and w.is_active and w.user_id = ${userId}
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
        from ozon_price_points pp
        join ozon_watches w on w.sku = pp.sku and w.is_active and w.user_id = ${userId}
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
      lastPrice: row.last_price === null ? null : Number(row.last_price),
      lastCardPrice: row.last_card_price === null ? null : Number(row.last_card_price),
      days: buildSeries(bySku.get(sku) ?? [], days, null),
    };
  });
}

export function buildOzonSummary(series: OzonSeries[], days: string[]): Array<Array<string | number | null>> {
  const FIXED = 8;
  const firstDayCol = columnName(FIXED + 1);
  const lastDayCol = columnName(FIXED + days.length);

  const header = [
    "Фото", "Номер товара", "Название", "Цена сейчас", "С Ozon Картой", "Минимум", "Максимум", "График цены",
    ...days,
  ];

  const rows = series.map((product, index) => {
    const prices = product.days.map((d) => d.price).filter((p): p is number => p !== null);
    const row = index + 2;
    return [
      product.image ? `=IMAGE("${product.image}")` : "",
      product.sku,
      product.name,
      product.lastPrice ?? "нет в продаже",
      product.lastCardPrice ?? "",
      prices.length > 0 ? Math.min(...prices) : "",
      prices.length > 0 ? Math.max(...prices) : "",
      `=SPARKLINE(${firstDayCol}${row}:${lastDayCol}${row})`,
      ...product.days.map((d) => d.price ?? ""),
    ];
  });

  return [header, ...rows];
}

async function refreshOzonDashboard(api: GoogleApi, userId: number, spreadsheetId: string): Promise<number> {
  const first = rowsOf<{ first: string | null }>(
    await db.execute(sql`
      select min(pp.checked_at) as first
        from ozon_price_points pp
        join ozon_watches w on w.sku = pp.sku and w.is_active and w.user_id = ${userId}
    `),
  )[0]?.first;

  const days = dayRange(new Date(), first ? new Date(first) : null);
  const series = await loadOzonSeries(userId, days);
  if (series.length === 0) return 0;

  await api.ensureSheets(spreadsheetId, [SHEET_SUMMARY]);
  await api.clearSheet(spreadsheetId, SHEET_SUMMARY);
  await api.writeRange(spreadsheetId, `${SHEET_SUMMARY}!A1`, buildOzonSummary(series, days));

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
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.92, blue: 1 } } },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 8, endColumnIndex: 8 + days.length },
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

export async function ozonUsersToExport(): Promise<number[]> {
  const rows = rowsOf<{ user_id: number }>(
    await db.execute(sql`select distinct user_id from ozon_watches where is_active`),
  );
  return rows.map((r) => Number(r.user_id));
}

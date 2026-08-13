// Выгрузка истории в Google Таблицу пользователя.
//
// Три листа: товары, продавцы, ключевые слова. Каждый прогон дописывает только
// новые строки — курсоры хранят, до какого id данные уже уехали. Переписывать
// таблицу целиком нельзя: история растёт непрерывно, и уже через месяц каждый
// прогон гонял бы десятки тысяч строк, упираясь в квоты Google.

import { eq, sql } from "drizzle-orm";
import { db, rowsOf } from "../db/client.js";
import { userSheets } from "../db/schema.js";
import type { GoogleApi } from "./google.js";
import {
  SHEET_SUMMARY,
  buildProductGrid,
  buildSummaryGrid,
  columnName,
  dayRange,
  loadSeries,
  ownProducts,
} from "./dashboard.js";

export const SHEET_PRODUCTS = "Товары";
export const SHEET_SELLERS = "Продавцы";
export const SHEET_KEYWORDS = "Ключевые слова";
/** Служебные листы: сюда история дописывается строками. */
export const SHEETS = [SHEET_PRODUCTS, SHEET_SELLERS, SHEET_KEYWORDS];

const HEADERS: Record<string, string[]> = {
  [SHEET_PRODUCTS]: [
    "Дата", "Артикул", "Название", "Бренд", "Продавец",
    "Цена", "Цена до скидки", "В наличии", "Остаток", "Регион",
  ],
  [SHEET_SELLERS]: [
    "Дата", "ID продавца", "Продавец", "ИНН",
    "Товаров", "В наличии", "Мин. цена", "Макс. цена", "Средняя цена",
  ],
  [SHEET_KEYWORDS]: ["Дата", "Ключевое слово", "Артикул", "Название", "Позиция", "Страница", "Найдено всего"],
};

/** Сколько строк отдаём за один прогон: остальное уедет следующим. */
const BATCH = 2000;

const asDate = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().replace("T", " ").slice(0, 19);
};

export interface ExportResult {
  spreadsheetUrl: string;
  products: number;
  sellers: number;
  keywords: number;
  /** Сколько листов-витрин перерисовано. */
  dashboards: number;
}

/** Идентификатор таблицы из ссылки вида docs.google.com/spreadsheets/d/<id>/edit. */
export function parseSpreadsheetId(input: string): string {
  const raw = input.trim();
  const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match?.[1]) return match[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;
  throw new Error("Не похоже на ссылку или идентификатор Гугл-таблицы");
}

export class SheetNotLinkedError extends Error {
  constructor(serviceAccountEmail: string) {
    super(
      `Таблица не подключена. Создайте её в своём Google Диске, откройте доступ на редактирование ` +
        `для ${serviceAccountEmail} и вставьте ссылку в настройках.`,
    );
    this.name = "SheetNotLinkedError";
  }
}

/**
 * Подключает таблицу, созданную пользователем.
 *
 * Приложение не создаёт таблицы само, и это не упрощение: у сервисных аккаунтов
 * Google больше нет собственного места на Диске, и любая попытка создать файл
 * упирается в «storage quota exceeded». Поэтому владельцем таблицы остаётся
 * человек, а сервисному аккаунту он выдаёт доступ на редактирование — заодно
 * данные остаются на его Диске, а не на чужом.
 */
export async function linkSpreadsheet(
  api: GoogleApi,
  userId: number,
  input: string,
): Promise<{ spreadsheetId: string; spreadsheetUrl: string; title: string }> {
  const spreadsheetId = parseSpreadsheetId(input);

  // Читаем таблицу: это одновременно и проверка, что доступ действительно выдан.
  const meta = await api.describe(spreadsheetId);
  await api.ensureSheets(spreadsheetId, SHEETS);

  // Заголовки проставляем только в пустые листы, чтобы не портить чужую разметку.
  for (const sheet of SHEETS) {
    const header = await api.firstRow(spreadsheetId, sheet);
    if (header.length === 0) await api.appendRows(spreadsheetId, sheet, [HEADERS[sheet] as string[]]);
  }

  await db
    .insert(userSheets)
    .values({ userId, spreadsheetId, spreadsheetUrl: meta.url })
    .onConflictDoUpdate({
      target: userSheets.userId,
      set: {
        spreadsheetId,
        spreadsheetUrl: meta.url,
        // курсоры сбрасываем: таблица другая, и вся история должна уехать заново
        cursorPricePoint: 0,
        cursorKeywordPosition: 0,
        cursorSellerSnapshot: 0,
        lastError: null,
      },
    });

  return { spreadsheetId, spreadsheetUrl: meta.url, title: meta.title };
}

/** Проверяет, что таблица подключена, и что листы на месте. */
export async function ensureSpreadsheet(
  api: GoogleApi,
  userId: number,
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const [existing] = await db.select().from(userSheets).where(eq(userSheets.userId, userId)).limit(1);
  if (!existing) throw new SheetNotLinkedError(api.email);

  await api.ensureSheets(existing.spreadsheetId, SHEETS);
  return { spreadsheetId: existing.spreadsheetId, spreadsheetUrl: existing.spreadsheetUrl };
}

/** Дописывает всё, что появилось с прошлого прогона. */
export async function exportUser(api: GoogleApi, userId: number): Promise<ExportResult> {
  // Подготовка таблицы тоже внутри try: если Google недоступен, отказ случится
  // именно здесь, и без записи причины интерфейс не сможет объяснить, почему
  // выгрузка встала.
  try {
    const sheet = await ensureSpreadsheet(api, userId);
    const [state] = await db.select().from(userSheets).where(eq(userSheets.userId, userId)).limit(1);
    if (!state) throw new Error("не удалось получить состояние выгрузки");

    const products = await exportProducts(api, userId, state.spreadsheetId, state.cursorPricePoint);
    const sellers = await exportSellers(api, userId, state.spreadsheetId, state.cursorSellerSnapshot);
    const keywords = await exportKeywords(api, userId, state.spreadsheetId, state.cursorKeywordPosition);

    await db
      .update(userSheets)
      .set({
        cursorPricePoint: products.cursor,
        cursorSellerSnapshot: sellers.cursor,
        cursorKeywordPosition: keywords.cursor,
        lastExportAt: new Date(),
        lastError: null,
      })
      .where(eq(userSheets.userId, userId));

    // Витрины считаются от всей истории, поэтому рисуются после дописывания.
    const dashboards = await refreshDashboards(api, userId, state.spreadsheetId);

    return {
      spreadsheetUrl: sheet.spreadsheetUrl,
      products: products.rows,
      sellers: sellers.rows,
      keywords: keywords.rows,
      dashboards,
    };
  } catch (error) {
    // Если таблицы ещё нет, обновлять нечего — запрос просто ничего не тронет.
    await db
      .update(userSheets)
      .set({ lastError: (error as Error).message })
      .where(eq(userSheets.userId, userId));
    throw error;
  }
}

/**
 * Точки истории цен по товарам, которые отслеживает пользователь: свои артикулы
 * плюс каталоги его продавцов.
 */
async function exportProducts(api: GoogleApi, userId: number, spreadsheetId: string, cursor: number) {
  const result = await db.execute(sql`
    select pp.id, pp.checked_at, pp.nm, p.name, p.brand, p.supplier_name,
           pp.price, pp.basic, pp.in_stock, pp.quantity, pp.dest
      from price_points pp
      join products p on p.nm = pp.nm
     where pp.id > ${cursor}
       and exists (
         select 1 from watches w
          where w.user_id = ${userId} and w.is_active
            and (w.nm = pp.nm or (w.supplier_id is not null and w.supplier_id = p.supplier_id))
       )
     order by pp.id
     limit ${BATCH}
  `);
  const rows = rowsOf<Record<string, unknown>>(result);
  if (rows.length === 0) return { rows: 0, cursor };

  await api.appendRows(
    spreadsheetId,
    SHEET_PRODUCTS,
    rows.map((r) => [
      asDate(r.checked_at),
      Number(r.nm),
      String(r.name ?? ""),
      String(r.brand ?? ""),
      String(r.supplier_name ?? ""),
      r.price === null ? "" : Number(r.price),
      r.basic === null ? "" : Number(r.basic),
      r.in_stock ? "да" : "нет",
      r.quantity === null ? "" : Number(r.quantity),
      String(r.dest ?? ""),
    ]),
  );
  return { rows: rows.length, cursor: Number(rows[rows.length - 1]?.id ?? cursor) };
}

/** Ежедневные срезы по продавцам, на которых подписан пользователь. */
async function exportSellers(api: GoogleApi, userId: number, spreadsheetId: string, cursor: number) {
  const result = await db.execute(sql`
    select ss.id, ss.captured_at, ss.supplier_id, s.name, s.inn,
           ss.product_count, ss.in_stock_count, ss.min_price, ss.max_price, ss.avg_price
      from seller_snapshots ss
      left join sellers s on s.supplier_id = ss.supplier_id
     where ss.id > ${cursor}
       and exists (
         select 1 from watches w
          where w.user_id = ${userId} and w.is_active and w.supplier_id = ss.supplier_id
       )
     order by ss.id
     limit ${BATCH}
  `);
  const rows = rowsOf<Record<string, unknown>>(result);
  if (rows.length === 0) return { rows: 0, cursor };

  await api.appendRows(
    spreadsheetId,
    SHEET_SELLERS,
    rows.map((r) => [
      asDate(r.captured_at),
      Number(r.supplier_id),
      String(r.name ?? ""),
      String(r.inn ?? ""),
      Number(r.product_count ?? 0),
      Number(r.in_stock_count ?? 0),
      r.min_price === null ? "" : Number(r.min_price),
      r.max_price === null ? "" : Number(r.max_price),
      r.avg_price === null ? "" : Number(r.avg_price),
    ]),
  );
  return { rows: rows.length, cursor: Number(rows[rows.length - 1]?.id ?? cursor) };
}

/** История позиций в выдаче по ключевым словам пользователя. */
async function exportKeywords(api: GoogleApi, userId: number, spreadsheetId: string, cursor: number) {
  const result = await db.execute(sql`
    select kp.id, kp.checked_at, k.phrase, kp.nm, p.name, kp.position, kp.page, k.last_total
      from keyword_positions kp
      join keywords k on k.id = kp.keyword_id
      left join products p on p.nm = kp.nm
     where kp.id > ${cursor} and k.user_id = ${userId}
     order by kp.id
     limit ${BATCH}
  `);
  const rows = rowsOf<Record<string, unknown>>(result);
  if (rows.length === 0) return { rows: 0, cursor };

  await api.appendRows(
    spreadsheetId,
    SHEET_KEYWORDS,
    rows.map((r) => [
      asDate(r.checked_at),
      String(r.phrase ?? ""),
      Number(r.nm),
      String(r.name ?? ""),
      // пустая позиция означает, что товар выпал из просмотренной выдачи
      r.position === null ? "выпал" : Number(r.position),
      r.page === null ? "" : Number(r.page),
      r.last_total === null ? "" : Number(r.last_total),
    ]),
  );
  return { rows: rows.length, cursor: Number(rows[rows.length - 1]?.id ?? cursor) };
}

/** Пользователи, у которых есть что выгружать (есть подписки или ключевые слова). */
export async function usersToExport(): Promise<number[]> {
  const result = await db.execute(sql`
    select distinct u.id
      from users u
     where exists (select 1 from watches w where w.user_id = u.id and w.is_active)
        or exists (select 1 from keywords k where k.user_id = u.id and k.is_active)
  `);
  return rowsOf<{ id: number }>(result).map((r) => Number(r.id));
}

// ── листы-витрины ────────────────────────────────────────────────────────────
/** Ширина колонки, пикселей. */
const COL = { photo: 70, wide: 240, normal: 110, day: 58 };

/**
 * Оформление витрины: шапка закреплена и выделена, левые колонки закреплены
 * (иначе при росте вправо непонятно, чей это ряд), строки повыше — под фото.
 */
function layoutRequests(sheetId: number, frozenColumns: number, headerRow: number, rowHeight: number): unknown[] {
  return [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: headerRow, frozenColumnCount: frozenColumns } },
        fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: headerRow - 1, endRowIndex: headerRow },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.95, green: 0.94, blue: 0.98 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: headerRow, endIndex: headerRow + 400 },
        properties: { pixelSize: rowHeight },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: COL.photo },
        fields: "pixelSize",
      },
    },
  ];
}

/** Перерисовывает сводку и личные листы товаров. */
export async function refreshDashboards(api: GoogleApi, userId: number, spreadsheetId: string): Promise<number> {
  const days = dayRange();
  const series = await loadSeries(userId, days);
  if (series.length === 0) return 0;

  const own = ownProducts(series);
  const sheetNames = [SHEET_SUMMARY, ...own.map((product) => String(product.nm))];
  await api.ensureSheets(spreadsheetId, sheetNames);

  const meta = await api.describe(spreadsheetId);
  const idByTitle = new Map(meta.sheets.map((sheet) => [sheet.title, sheet.id]));

  // ── сводка ──
  const summary = buildSummaryGrid(series, days);
  await api.clearSheet(spreadsheetId, SHEET_SUMMARY);
  await api.writeRange(spreadsheetId, `${SHEET_SUMMARY}!A1`, summary);
  const summaryId = idByTitle.get(SHEET_SUMMARY);
  if (summaryId !== undefined) {
    await api.formatSheet(spreadsheetId, [
      ...layoutRequests(summaryId, 5, 1, 72),
      {
        updateDimensionProperties: {
          range: { sheetId: summaryId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
          properties: { pixelSize: COL.wide },
          fields: "pixelSize",
        },
      },
    ]);
  }

  // ── личные листы товаров ──
  for (const product of own) {
    const title = String(product.nm);
    await api.clearSheet(spreadsheetId, title);
    await api.writeRange(spreadsheetId, `${title}!A1`, buildProductGrid(product, days));
    const sheetId = idByTitle.get(title);
    if (sheetId !== undefined) {
      await api.formatSheet(spreadsheetId, [
        ...layoutRequests(sheetId, 6, 4, 24),
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 3 },
            properties: { pixelSize: 34 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
            properties: { pixelSize: COL.wide },
            fields: "pixelSize",
          },
        },
      ]);
    }
  }

  return 1 + own.length;
}

export { columnName };

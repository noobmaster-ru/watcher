// Выгрузка истории в Google Таблицу пользователя.
//
// Три листа: товары, продавцы, ключевые слова. Каждый прогон дописывает только
// новые строки — курсоры хранят, до какого id данные уже уехали. Переписывать
// таблицу целиком нельзя: история растёт непрерывно, и уже через месяц каждый
// прогон гонял бы десятки тысяч строк, упираясь в квоты Google.

import { eq, sql } from "drizzle-orm";
import { db, rowsOf } from "../db/client.js";
import { userSheets, users } from "../db/schema.js";
import type { GoogleApi } from "./google.js";

export const SHEET_PRODUCTS = "Товары";
export const SHEET_SELLERS = "Продавцы";
export const SHEET_KEYWORDS = "Ключевые слова";
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
}

/**
 * Создаёт таблицу пользователя, если её ещё нет, и открывает ему доступ.
 * Владельцем файла остаётся сервисный аккаунт — иначе выдавать права было бы
 * некому.
 */
export async function ensureSpreadsheet(
  api: GoogleApi,
  userId: number,
): Promise<{ spreadsheetId: string; spreadsheetUrl: string; created: boolean }> {
  const [existing] = await db.select().from(userSheets).where(eq(userSheets.userId, userId)).limit(1);
  if (existing) {
    await api.ensureSheets(existing.spreadsheetId, SHEETS);
    return { spreadsheetId: existing.spreadsheetId, spreadsheetUrl: existing.spreadsheetUrl, created: false };
  }

  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error(`Пользователь ${userId} не найден`);

  const created = await api.createSpreadsheet(`watcher — ${user.email}`, SHEETS);
  await api.shareWithEmail(created.spreadsheetId, user.email);

  // шапки пишем один раз, при создании
  for (const sheet of SHEETS) {
    await api.appendRows(created.spreadsheetId, sheet, [HEADERS[sheet] as string[]]);
  }

  await db.insert(userSheets).values({
    userId,
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl: created.spreadsheetUrl,
  });

  return { ...created, created: true };
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

    return {
      spreadsheetUrl: sheet.spreadsheetUrl,
      products: products.rows,
      sellers: sellers.rows,
      keywords: keywords.rows,
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

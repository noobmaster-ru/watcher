// Позиции товаров в поисковой выдаче Wildberries по ключевым словам.
//
// Дорогая часть — сам поиск: search.wb.ru лимитирует жёстче всех остальных
// эндпоинтов. Поэтому одна проверка запроса берёт не больше нескольких страниц
// (по 100 товаров), интервал по умолчанию — шесть часов, а выпадение из выдачи
// записывается только для тех артикулов, что были найдены в прошлый раз: иначе
// каждая проверка добавляла бы по строке на каждый отслеживаемый товар.

import { and, desc, eq, sql } from "drizzle-orm";
import type { WbClient } from "@watcher/wb-core";
import { db, rowsOf } from "../db/client.js";
import { keywordPositions, keywords, products } from "../db/schema.js";
import { nextCheckTime } from "./products.js";

/** Артикулы, которые отслеживает пользователь: свои товары плюс каталоги его продавцов. */
export async function trackedNms(userId: number): Promise<number[]> {
  const result = await db.execute(sql`
    select distinct nm from (
      select w.nm as nm from watches w where w.user_id = ${userId} and w.is_active and w.nm is not null
      union
      select sp.nm as nm from watches w
        join seller_products sp on sp.supplier_id = w.supplier_id and sp.is_active
       where w.user_id = ${userId} and w.is_active and w.supplier_id is not null
    ) t
  `);
  return rowsOf<{ nm: number | string }>(result).map((r) => Number(r.nm));
}

export interface KeywordCheckResult {
  phrase: string;
  scanned: number;
  found: number;
  dropped: number;
}

/**
 * Проверяет один запрос: забирает выдачу, находит в ней артикулы пользователя и
 * записывает их позиции.
 */
export async function checkKeyword(
  wb: WbClient,
  keyword: { id: number; userId: number; phrase: string; maxPages: number; intervalMin: number },
): Promise<KeywordCheckResult> {
  const limit = Math.min(Math.max(keyword.maxPages, 1), 3) * 100;
  const items = await wb.search(keyword.phrase, limit, "background");

  // позиция — это место в общей выдаче, начиная с единицы
  const positionByNm = new Map<number, number>();
  items.forEach((item, index) => {
    const nm = Number(item.nm);
    if (!positionByNm.has(nm)) positionByNm.set(nm, index + 1);
  });

  const mine = await trackedNms(keyword.userId);
  const now = new Date();
  const rows: Array<typeof keywordPositions.$inferInsert> = [];

  for (const nm of mine) {
    const position = positionByNm.get(nm);
    if (position === undefined) continue;
    rows.push({
      keywordId: keyword.id,
      nm,
      position,
      page: Math.ceil(position / 100),
      checkedAt: now,
    });
  }

  // Выпадение из выдачи фиксируем только для тех, кто в прошлый раз там был:
  // так в истории видно «был 34-м, выпал», но не растёт мусор по товарам,
  // которые к запросу вообще не относятся.
  const foundNow = new Set(rows.map((r) => r.nm));
  const previous = await lastFoundNms(keyword.id);
  let dropped = 0;
  for (const nm of previous) {
    if (foundNow.has(nm) || !mine.includes(nm)) continue;
    rows.push({ keywordId: keyword.id, nm, position: null, page: null, checkedAt: now });
    dropped += 1;
  }

  if (rows.length > 0) await db.insert(keywordPositions).values(rows);

  await db
    .update(keywords)
    .set({
      lastCheckedAt: now,
      lastTotal: items.length,
      errorCount: 0,
      nextCheckAt: nextCheckTime(keyword.intervalMin),
    })
    .where(eq(keywords.id, keyword.id));

  return { phrase: keyword.phrase, scanned: items.length, found: rows.length - dropped, dropped };
}

/** Артикулы, найденные в предыдущую проверку этого запроса. */
async function lastFoundNms(keywordId: number): Promise<number[]> {
  const result = await db.execute(sql`
    select nm from keyword_positions
    where keyword_id = ${keywordId}
      and position is not null
      and checked_at = (select max(checked_at) from keyword_positions where keyword_id = ${keywordId})
  `);
  return rowsOf<{ nm: number | string }>(result).map((r) => Number(r.nm));
}

/** Пауза перед повтором после отказа, минут. Вынесена отдельно ради проверяемости. */
export function retryDelayMin(errorCount: number, intervalMin: number): number {
  // Повторяем РАНЬШЕ обычного срока, а не позже: данных мы не получили, а
  // обычный интервал у ключевых слов измеряется часами. Ждать его целиком
  // значит оставить пользователя без позиций на полдня из-за одного отказа WB.
  // Пауза растёт с каждой неудачей, но никогда не превышает обычный интервал.
  return Math.min(intervalMin, 10 * 2 ** Math.max(errorCount - 1, 0));
}

/** Запрос не проверился: повторяем скорее обычного, с растущей паузой. */
export async function markKeywordError(keywordId: number, intervalMin: number): Promise<void> {
  const [row] = await db
    .select({ errorCount: keywords.errorCount })
    .from(keywords)
    .where(eq(keywords.id, keywordId))
    .limit(1);
  const errorCount = (row?.errorCount ?? 0) + 1;
  await db
    .update(keywords)
    .set({ errorCount, nextCheckAt: nextCheckTime(retryDelayMin(errorCount, intervalMin)) })
    .where(eq(keywords.id, keywordId));
}

/** Список запросов пользователя с последними позициями. */
export async function listKeywords(userId: number): Promise<Record<string, unknown>[]> {
  const result = await db.execute(sql`
    select
      k.id, k.phrase, k.is_active as "isActive", k.max_pages as "maxPages",
      k.interval_min as "intervalMin", k.last_checked_at as "lastCheckedAt",
      k.last_total as "lastTotal", k.created_at as "createdAt",
      coalesce((
        select json_agg(row_to_json(p) order by p.position nulls last)
        from (
          select kp.nm, kp.position, kp.page, kp.checked_at as "checkedAt", pr.name
          from keyword_positions kp
          left join products pr on pr.nm = kp.nm
          where kp.keyword_id = k.id
            and kp.checked_at = (select max(checked_at) from keyword_positions where keyword_id = k.id)
        ) p
      ), '[]'::json) as positions
    from keywords k
    where k.user_id = ${userId}
    order by k.created_at desc
  `);
  return rowsOf<Record<string, unknown>>(result);
}

/** История позиций одного артикула по запросу. */
export async function keywordHistory(userId: number, keywordId: number) {
  const [owned] = await db
    .select({ id: keywords.id })
    .from(keywords)
    .where(and(eq(keywords.id, keywordId), eq(keywords.userId, userId)))
    .limit(1);
  if (!owned) return null;

  return db
    .select({
      nm: keywordPositions.nm,
      position: keywordPositions.position,
      page: keywordPositions.page,
      checkedAt: keywordPositions.checkedAt,
      name: products.name,
    })
    .from(keywordPositions)
    .leftJoin(products, eq(products.nm, keywordPositions.nm))
    .where(eq(keywordPositions.keywordId, keywordId))
    .orderBy(desc(keywordPositions.checkedAt))
    .limit(1000);
}

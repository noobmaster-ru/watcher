// Цикл проверки позиций по ключевым словам.
//
// Идёт медленно и по одному запросу за раз: search.wb.ru — самый лимитируемый
// эндпоинт Wildberries, и жадный обход здесь стоил бы блокировки всего поиска,
// включая тот, которым пользуются люди в интерфейсе.

import { sql } from "drizzle-orm";
import { WbUnavailableError, type WbClient } from "@watcher/wb-core";
import { db, rowsOf } from "../db/client.js";
import { checkKeyword, markKeywordError } from "../services/keywords.js";

interface DueKeyword {
  id: number;
  user_id: number;
  phrase: string;
  max_pages: number;
  interval_min: number;
}

/** Забирает просроченные запросы и сразу отодвигает их, чтобы не взять повторно. */
async function claimDue(limit: number): Promise<DueKeyword[]> {
  const result = await db.execute(sql`
    with due as (
      select id from keywords
      where is_active and next_check_at <= now()
      order by next_check_at
      limit ${limit}
      for update skip locked
    )
    update keywords k
       set next_check_at = now() + interval '10 minutes'
      from due
     where k.id = due.id
    returning k.id, k.user_id, k.phrase, k.max_pages, k.interval_min
  `);
  return rowsOf<DueKeyword>(result);
}

export interface KeywordTickResult {
  checked: number;
  positions: number;
  degraded: boolean;
}

export async function runKeywordTick(wb: WbClient, limit = 1): Promise<KeywordTickResult> {
  const due = await claimDue(limit);
  const result: KeywordTickResult = { checked: 0, positions: 0, degraded: false };

  for (const keyword of due) {
    try {
      const checked = await checkKeyword(wb, {
        id: keyword.id,
        userId: Number(keyword.user_id),
        phrase: keyword.phrase,
        maxPages: Number(keyword.max_pages),
        intervalMin: Number(keyword.interval_min),
      });
      result.checked += 1;
      result.positions += checked.found;
    } catch (error) {
      result.degraded = result.degraded || error instanceof WbUnavailableError;
      await markKeywordError(keyword.id, Number(keyword.interval_min));
      console.error(`[keywords] «${keyword.phrase}»: ${(error as Error).message}`);
    }
  }
  return result;
}

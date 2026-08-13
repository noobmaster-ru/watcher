// Цикл проверки цен Яндекс Маркета.
//
// Пакетных запросов у Маркета нет: цена снимается по одному товару, каждый —
// отдельная страница поиска. Поэтому за тик берётся небольшая горсть, а не
// сотня, как на Wildberries.

import { sql } from "drizzle-orm";
import { YmUnavailableError, type YmClient } from "@watcher/ym-core";
import { db, rowsOf } from "../db/client.js";
import { applyYmSnapshot, fanOutYmEvents, markYmError } from "../services/ym.js";

/** Сколько товаров берём за раз: каждый стоит отдельного запроса. */
const BATCH = 5;
const LEASE_MINUTES = 10;

async function claimDue(limit: number): Promise<string[]> {
  const result = await db.execute(sql`
    with due as (
      select sku from ym_products
      where is_tracked and next_check_at <= now()
      order by next_check_at
      limit ${limit}
      for update skip locked
    )
    update ym_products p
       set next_check_at = now() + interval '${sql.raw(String(LEASE_MINUTES))} minutes'
      from due
     where p.sku = due.sku
    returning p.sku
  `);
  return rowsOf<{ sku: string }>(result).map((r) => String(r.sku));
}

export interface YmTickResult {
  checked: number;
  events: number;
  missing: number;
  degraded: boolean;
}

export async function runYmTick(client: YmClient, limit = BATCH): Promise<YmTickResult> {
  const due = await claimDue(limit);
  const result: YmTickResult = { checked: 0, events: 0, missing: 0, degraded: false };

  for (const sku of due) {
    try {
      const product = await client.bySku(sku);
      if (!product) {
        // товар исчез из выдачи — отодвигаем, но историю не трогаем
        result.missing += 1;
        await markYmError(sku);
        continue;
      }
      // Рассылаем сразу по товару: applyYmSnapshot уже сдвинул последнюю цену,
      // и событие, не разосланное сейчас, восстановить будет неоткуда.
      const events = await applyYmSnapshot(product);
      if (events.length > 0) result.events += await fanOutYmEvents(sku, events);
      result.checked += 1;
    } catch (error) {
      if (error instanceof YmUnavailableError) {
        result.degraded = true;
        break; // лимит общий на площадку — остальные товары ждут следующего тика
      }
      console.error(`[ym] товар ${sku}: ${(error as Error).message}`);
      await markYmError(sku);
    }
  }
  return result;
}

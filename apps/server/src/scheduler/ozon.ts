// Цикл проверки цен Озона. Как у Маркета: по одному товару за запрос, горсть за
// тик. Каждый запрос идёт через браузер в контейнере агента, поэтому спешить
// некуда — холодный старт агента и так занимает ~15 секунд раз в час.

import { sql } from "drizzle-orm";
import { OzonUnavailableError, type OzonClient } from "@watcher/ozon-core";
import { db, rowsOf } from "../db/client.js";
import { applyOzonSnapshot, fanOutOzonEvents, markOzonError } from "../services/ozon.js";

const BATCH = 5;
const LEASE_MINUTES = 10;

async function claimDue(limit: number): Promise<string[]> {
  const result = await db.execute(sql`
    with due as (
      select sku from ozon_products
      where is_tracked and next_check_at <= now()
      order by next_check_at
      limit ${limit}
      for update skip locked
    )
    update ozon_products p
       set next_check_at = now() + interval '${sql.raw(String(LEASE_MINUTES))} minutes'
      from due
     where p.sku = due.sku
    returning p.sku
  `);
  return rowsOf<{ sku: string }>(result).map((r) => String(r.sku));
}

export interface OzonTickResult {
  checked: number;
  events: number;
  missing: number;
  degraded: boolean;
}

export async function runOzonTick(client: OzonClient, limit = BATCH): Promise<OzonTickResult> {
  const due = await claimDue(limit);
  const result: OzonTickResult = { checked: 0, events: 0, missing: 0, degraded: false };

  for (const sku of due) {
    try {
      const product = await client.bySku(sku);
      if (!product) {
        result.missing += 1;
        await markOzonError(sku);
        continue;
      }
      const events = await applyOzonSnapshot(product);
      if (events.length > 0) result.events += await fanOutOzonEvents(sku, events);
      result.checked += 1;
    } catch (error) {
      if (error instanceof OzonUnavailableError) {
        result.degraded = true;
        break; // агент лежит или Озон закрылся — остальные подождут следующего тика
      }
      console.error(`[ozon] товар ${sku}: ${(error as Error).message}`);
      await markOzonError(sku);
    }
  }
  return result;
}

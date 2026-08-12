// Цикл обхода цен.
//
// Товары забираются пачкой по 100 — ровно столько принимает card.wb.ru за один
// запрос. Тысяча отслеживаемых артикулов стоит десяти обращений к WB, поэтому
// узкое место здесь не сеть, а лимиты, и цикл намеренно неспешный.

import { inArray, sql } from "drizzle-orm";
import { DETAIL_BATCH_SIZE, WbUnavailableError, type WbClient } from "@watcher/wb-core";
import { db, rowsOf } from "../db/client.js";
import { products } from "../db/schema.js";
import { applySnapshot, fanOutEvents, markProductError, type PriceEvent } from "../services/products.js";

/** На сколько «арендуется» товар, взятый в обработку: страховка от падения процесса. */
const LEASE_MINUTES = 5;

/**
 * Забирает партию просроченных товаров и сразу отодвигает им next_check_at.
 * SKIP LOCKED — чтобы второй процесс (если он когда-нибудь появится) не взял ту
 * же партию.
 */
async function claimDue(limit: number): Promise<number[]> {
  const result = await db.execute(sql`
    with due as (
      select nm from products
      where is_tracked and next_check_at <= now()
      order by next_check_at
      limit ${limit}
      for update skip locked
    )
    update products p
       set next_check_at = now() + interval '${sql.raw(String(LEASE_MINUTES))} minutes'
      from due
     where p.nm = due.nm
    returning p.nm
  `);
  return rowsOf<{ nm: number | string }>(result).map((r) => Number(r.nm));
}

export interface PriceTickResult {
  checked: number;
  events: number;
  missing: number;
  degraded: boolean;
}

/** Один проход цикла цен. */
export async function runPriceTick(wb: WbClient, batchSize = DETAIL_BATCH_SIZE): Promise<PriceTickResult> {
  const due = await claimDue(batchSize);
  if (due.length === 0) return { checked: 0, events: 0, missing: 0, degraded: false };

  let snapshots;
  try {
    snapshots = await wb.detailBatch(due, "background");
  } catch (error) {
    if (error instanceof WbUnavailableError) {
      // лимит WB: возвращаем партию в очередь и ждём следующего тика
      await db
        .update(products)
        .set({ nextCheckAt: sql`now() + interval '2 minutes'` })
        .where(inArray(products.nm, due));
      return { checked: 0, events: 0, missing: 0, degraded: true };
    }
    throw error;
  }

  const seen = new Set<number>();
  let created = 0;

  for (const snapshot of snapshots) {
    seen.add(Number(snapshot.nm));
    try {
      // Рассылаем сразу по товару, а не копим до конца пачки. applySnapshot уже
      // сдвинул lastPrice, поэтому событие, не разосланное сейчас, восстановить
      // будет неоткуда: следующий тик разницы не увидит. Один сбойный товар не
      // должен уносить с собой уведомления по остальным девяноста девяти.
      const events: PriceEvent[] = await applySnapshot(snapshot);
      if (events.length > 0) created += await fanOutEvents(events);
    } catch (error) {
      console.error(`[prices] товар ${snapshot.nm}: ${(error as Error).message}`);
    }
  }

  // WB не вернул часть артикулов: товар скрыт или удалён — отодвигаем проверку
  const missing = due.filter((nm) => !seen.has(nm));
  for (const nm of missing) await markProductError(nm);

  return { checked: snapshots.length, events: created, missing: missing.length, degraded: false };
}

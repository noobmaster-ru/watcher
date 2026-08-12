// Пересинхронизация каталогов отслеживаемых продавцов. Идёт медленно и редко:
// каталог меняется куда неспешнее цен, а catalog.wb.ru лимитирует жёстче всех.

import { sql } from "drizzle-orm";
import { WbUnavailableError, type WbClient } from "@watcher/wb-core";
import { db, rowsOf } from "../db/client.js";
import { syncSellerCatalog } from "../services/watches.js";
import { config } from "../config.js";

/** Продавцы, у которых есть активная подписка и подошёл срок обхода. */
async function claimDueSellers(limit: number): Promise<number[]> {
  const result = await db.execute(sql`
    with due as (
      select s.supplier_id from sellers s
      where exists (
        select 1 from watches w
        where w.is_active and w.kind = 'seller' and w.supplier_id = s.supplier_id
      )
      and (s.next_sync_at is null or s.next_sync_at <= now())
      order by s.next_sync_at nulls first
      limit ${limit}
      for update skip locked
    )
    update sellers s
       set next_sync_at = now() + interval '30 minutes'
      from due
     where s.supplier_id = due.supplier_id
    returning s.supplier_id
  `);
  return rowsOf<{ supplier_id: number | string }>(result).map((r) => Number(r.supplier_id));
}

export interface SellerTickResult {
  sellers: number;
  products: number;
  added: number;
  degraded: boolean;
}

export async function runSellerTick(wb: WbClient, limit = 1): Promise<SellerTickResult> {
  const due = await claimDueSellers(limit);
  const result: SellerTickResult = { sellers: 0, products: 0, added: 0, degraded: false };

  for (const supplierId of due) {
    try {
      const sync = await syncSellerCatalog(wb, supplierId, { announceNew: true });
      result.sellers += 1;
      result.products += sync.total;
      result.added += sync.added;
      if (sync.truncated) {
        console.error(
          `[scheduler] каталог продавца ${supplierId} обрезан на ${config.limits.maxSellerProducts} товарах`,
        );
      }
    } catch (error) {
      result.degraded = result.degraded || error instanceof WbUnavailableError;
      console.error(`[scheduler] продавец ${supplierId}: ${(error as Error).message}`);
    }
  }
  return result;
}

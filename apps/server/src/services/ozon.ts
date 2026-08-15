// Отслеживание цен Озона. Логика — зеркало Яндекс Маркета: цены снимаются по
// одному товару через агента, правило «нет цены = нет в продаже, а не ноль»
// действует и здесь. Отличие одно: рядом с обычной ценой живёт цена с Ozon
// Картой — их разница и есть главный вопрос покупателя на Озоне.

import { and, asc, eq, sql } from "drizzle-orm";
import type { OzonClient, OzonProduct } from "@watcher/ozon-core";
import { parseOzonInput } from "@watcher/ozon-core";
import { db, rowsOf } from "../db/client.js";
import { alerts, ozonPricePoints, ozonProducts, ozonWatches } from "../db/schema.js";
import { nextCheckTime, type PriceEvent } from "./products.js";

const HEARTBEAT_MS = 24 * 60 * 60 * 1000;

export async function upsertOzonProduct(product: OzonProduct): Promise<void> {
  await db
    .insert(ozonProducts)
    .values({ sku: product.sku, name: product.name, image: product.image, url: product.url })
    .onConflictDoUpdate({
      target: ozonProducts.sku,
      set: { name: product.name, image: product.image, url: product.url },
    });
}

/** Применяет снимок: справочник → история → события. */
export async function applyOzonSnapshot(
  product: OzonProduct,
  options: { scheduleNext?: boolean } = {},
): Promise<PriceEvent[]> {
  const [existing] = await db
    .select({
      lastPrice: ozonProducts.lastPrice,
      lastInStock: ozonProducts.lastInStock,
      lastPointAt: ozonProducts.lastPointAt,
      checkIntervalMin: ozonProducts.checkIntervalMin,
    })
    .from(ozonProducts)
    .where(eq(ozonProducts.sku, product.sku))
    .limit(1);

  await upsertOzonProduct(product);

  const events: PriceEvent[] = [];
  const nm = Number(product.sku);
  const previousPrice = existing?.lastPrice ?? null;
  const previousStock = existing?.lastInStock ?? null;
  const first = previousPrice === null && previousStock === null;

  if (!first) {
    if (previousStock === true && !product.inStock) {
      events.push({ nm, type: "out_of_stock", oldPrice: previousPrice, newPrice: null });
    } else {
      if (previousStock === false && product.inStock) {
        events.push({ nm, type: "back_in_stock", oldPrice: previousPrice, newPrice: product.price });
      }
      if (previousPrice !== null && product.price !== null && product.price !== previousPrice) {
        events.push({
          nm,
          type: product.price < previousPrice ? "price_drop" : "price_rise",
          oldPrice: previousPrice,
          newPrice: product.price,
        });
      }
    }
  }

  const now = new Date();
  const changed =
    first ||
    events.length > 0 ||
    previousPrice !== product.price ||
    previousStock !== product.inStock ||
    !existing?.lastPointAt ||
    now.getTime() - existing.lastPointAt.getTime() >= HEARTBEAT_MS;

  if (changed) {
    await db.insert(ozonPricePoints).values({
      sku: product.sku,
      checkedAt: now,
      price: product.price,
      cardPrice: product.cardPrice,
      inStock: product.inStock,
    });
  }

  const update: Record<string, unknown> = {
    lastPrice: product.price,
    lastCardPrice: product.cardPrice,
    lastInStock: product.inStock,
    lastCheckedAt: now,
    errorCount: 0,
  };
  if (changed) update.lastPointAt = now;
  if (options.scheduleNext !== false) {
    update.nextCheckAt = nextCheckTime(existing?.checkIntervalMin ?? 60);
  }
  await db.update(ozonProducts).set(update).where(eq(ozonProducts.sku, product.sku));

  return events;
}

export async function fanOutOzonEvents(sku: string, events: PriceEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  const subscribers = await db
    .select()
    .from(ozonWatches)
    .where(and(eq(ozonWatches.sku, sku), eq(ozonWatches.isActive, true)));
  if (subscribers.length === 0) return 0;

  const rows: Array<typeof alerts.$inferInsert> = [];
  for (const event of events) {
    for (const watch of subscribers) {
      if (event.type === "price_drop" && !watch.onDrop) continue;
      if (event.type === "price_rise" && !watch.onRise) continue;
      if ((event.type === "out_of_stock" || event.type === "back_in_stock") && !watch.onStockChange) continue;

      if (event.oldPrice !== null && event.newPrice !== null) {
        const delta = Math.abs(event.newPrice - event.oldPrice);
        if (delta < watch.minChangeAbs) continue;
        if ((delta / event.oldPrice) * 100 < watch.minChangePct) continue;
      }

      rows.push({
        userId: watch.userId,
        ozonWatchId: watch.id,
        marketplace: "ozon",
        nm: Number(sku),
        type: event.type,
        oldPrice: event.oldPrice,
        newPrice: event.newPrice,
      });
    }
  }

  if (rows.length === 0) return 0;
  await db.insert(alerts).values(rows);
  return rows.length;
}

export async function watchOzonProduct(
  client: OzonClient,
  input: { userId: number; input: string; intervalMin?: number },
): Promise<{ watchId: number; sku: string; product: OzonProduct }> {
  const sku = parseOzonInput(input.input);
  const product = await client.bySku(sku);
  if (!product) throw new Error(`Товар ${sku} на Озоне не найден`);

  await upsertOzonProduct(product);
  await applyOzonSnapshot(product, { scheduleNext: false });

  const interval = Math.min(Math.max(input.intervalMin ?? 60, 30), 1440);
  const [row] = await db
    .insert(ozonWatches)
    .values({ userId: input.userId, sku, title: product.name, intervalMin: interval })
    .onConflictDoUpdate({
      target: [ozonWatches.userId, ozonWatches.sku],
      set: { isActive: true, intervalMin: interval, title: product.name },
    })
    .returning({ id: ozonWatches.id });

  await refreshOzonTracking([sku]);
  return { watchId: row?.id ?? 0, sku, product };
}

export async function refreshOzonTracking(skus: string[]): Promise<void> {
  if (skus.length === 0) return;
  await db.execute(sql`
    update ozon_products p set
      is_tracked = coalesce(w.tracked, false),
      check_interval_min = coalesce(w.interval_min, 60),
      next_check_at = case when coalesce(w.tracked, false) and not p.is_tracked then now() else p.next_check_at end
    from (
      select p2.sku,
             bool_or(ow.is_active) as tracked,
             min(ow.interval_min) filter (where ow.is_active) as interval_min
        from ozon_products p2
        left join ozon_watches ow on ow.sku = p2.sku and ow.is_active
       where p2.sku in (${sql.join(skus.map((s) => sql`${s}`), sql`, `)})
       group by p2.sku
    ) w
    where p.sku = w.sku
  `);
}

export async function removeOzonWatch(userId: number, watchId: number): Promise<boolean> {
  const [row] = await db
    .update(ozonWatches)
    .set({ isActive: false })
    .where(and(eq(ozonWatches.id, watchId), eq(ozonWatches.userId, userId)))
    .returning({ sku: ozonWatches.sku });
  if (!row) return false;
  await refreshOzonTracking([row.sku]);
  return true;
}

export async function listOzonWatches(userId: number): Promise<Record<string, unknown>[]> {
  const result = await db.execute(sql`
    select w.id, w.sku, w.title, w.interval_min as "intervalMin",
           w.created_at as "createdAt",
           p.name, p.image, p.url,
           p.last_price as "lastPrice", p.last_card_price as "lastCardPrice",
           p.last_in_stock as "lastInStock", p.last_checked_at as "lastCheckedAt",
           (select pp.price from ozon_price_points pp
             where pp.sku = w.sku and pp.checked_at <= now() - interval '24 hours'
             order by pp.checked_at desc limit 1) as "priceDayAgo",
           (select pp.price from ozon_price_points pp
             where pp.sku = w.sku and pp.checked_at <= now() - interval '7 days'
             order by pp.checked_at desc limit 1) as "priceWeekAgo"
      from ozon_watches w
      join ozon_products p on p.sku = w.sku
     where w.user_id = ${userId} and w.is_active
     order by w.created_at desc
  `);
  return rowsOf<Record<string, unknown>>(result);
}

export async function ozonHistory(sku: string, interval: string) {
  return db
    .select({
      checkedAt: ozonPricePoints.checkedAt,
      price: ozonPricePoints.price,
      cardPrice: ozonPricePoints.cardPrice,
      inStock: ozonPricePoints.inStock,
    })
    .from(ozonPricePoints)
    .where(and(eq(ozonPricePoints.sku, sku), sql`${ozonPricePoints.checkedAt} >= now() - ${interval}::interval`))
    .orderBy(asc(ozonPricePoints.checkedAt));
}

export async function markOzonError(sku: string): Promise<void> {
  const [row] = await db
    .select({ errorCount: ozonProducts.errorCount, checkIntervalMin: ozonProducts.checkIntervalMin })
    .from(ozonProducts)
    .where(eq(ozonProducts.sku, sku))
    .limit(1);
  const errorCount = (row?.errorCount ?? 0) + 1;
  await db
    .update(ozonProducts)
    .set({ errorCount, nextCheckAt: nextCheckTime((row?.checkIntervalMin ?? 60) * Math.min(2 ** errorCount, 12)) })
    .where(eq(ozonProducts.sku, sku));
}

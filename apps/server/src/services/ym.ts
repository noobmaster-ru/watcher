// Отслеживание цен Яндекс Маркета.
//
// Логика та же, что у Wildberries, но проще: у Маркета нет продавцов, каталогов
// и пакетных запросов — цена снимается по одному товару. Зато и лимиты мягче,
// так что цикл может идти чаще.
//
// Правило про исчезнувшую цену действует и здесь: если товар пропал из выдачи,
// это «нет в продаже», а не падение до нуля.

import { and, asc, eq, sql } from "drizzle-orm";
import type { YmClient, YmProduct } from "@watcher/ym-core";
import { db, rowsOf } from "../db/client.js";
import { alerts, ymPricePoints, ymProducts, ymWatches } from "../db/schema.js";
import { nextCheckTime, type PriceEvent } from "./products.js";

/** Раз в сутки пишем точку, даже если ничего не изменилось: график не должен рваться. */
const HEARTBEAT_MS = 24 * 60 * 60 * 1000;

/** Сохраняет карточку, не трогая расписание. */
export async function upsertYmProduct(product: YmProduct): Promise<void> {
  await db
    .insert(ymProducts)
    .values({
      sku: product.sku,
      name: product.name,
      image: product.image,
      url: product.url,
      description: product.description,
    })
    .onConflictDoUpdate({
      target: ymProducts.sku,
      set: {
        name: product.name,
        image: product.image,
        url: product.url,
        description: product.description,
      },
    });
}

/** Применяет снимок: справочник → история → события. */
export async function applyYmSnapshot(
  product: YmProduct,
  options: { scheduleNext?: boolean } = {},
): Promise<PriceEvent[]> {
  const [existing] = await db
    .select({
      lastPrice: ymProducts.lastPrice,
      lastInStock: ymProducts.lastInStock,
      lastPointAt: ymProducts.lastPointAt,
      checkIntervalMin: ymProducts.checkIntervalMin,
    })
    .from(ymProducts)
    .where(eq(ymProducts.sku, product.sku))
    .limit(1);

  await upsertYmProduct(product);

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
    await db.insert(ymPricePoints).values({
      sku: product.sku,
      checkedAt: now,
      price: product.price,
      inStock: product.inStock,
    });
  }

  const update: Record<string, unknown> = {
    lastPrice: product.price,
    lastInStock: product.inStock,
    lastCheckedAt: now,
    errorCount: 0,
  };
  if (changed) update.lastPointAt = now;
  if (options.scheduleNext !== false) {
    update.nextCheckAt = nextCheckTime(existing?.checkIntervalMin ?? 60);
  }
  await db.update(ymProducts).set(update).where(eq(ymProducts.sku, product.sku));

  return events;
}

/** Рассылает события подписчикам этого товара. */
export async function fanOutYmEvents(sku: string, events: PriceEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  const subscribers = await db
    .select()
    .from(ymWatches)
    .where(and(eq(ymWatches.sku, sku), eq(ymWatches.isActive, true)));
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
        ymWatchId: watch.id,
        marketplace: "ym",
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

/** Ставит товар Маркета на отслеживание, попутно сняв текущую цену. */
export async function watchYmProduct(
  client: YmClient,
  input: { userId: number; input: string; intervalMin?: number },
): Promise<{ watchId: number; sku: string; product: YmProduct }> {
  const sku = await client.resolveSku(input.input);
  const product = await client.bySku(sku);
  if (!product) throw new Error(`Товар ${sku} на Яндекс Маркете не найден`);

  await upsertYmProduct(product);
  await applyYmSnapshot(product, { scheduleNext: false });

  const interval = Math.min(Math.max(input.intervalMin ?? 60, 30), 1440);
  const [row] = await db
    .insert(ymWatches)
    .values({ userId: input.userId, sku, title: product.name, intervalMin: interval })
    .onConflictDoUpdate({
      target: [ymWatches.userId, ymWatches.sku],
      set: { isActive: true, intervalMin: interval, title: product.name },
    })
    .returning({ id: ymWatches.id });

  await refreshYmTracking([sku]);
  return { watchId: row?.id ?? 0, sku, product };
}

/** Пересчитывает, надо ли опрашивать товары и как часто. */
export async function refreshYmTracking(skus: string[]): Promise<void> {
  if (skus.length === 0) return;
  await db.execute(sql`
    update ym_products p set
      is_tracked = coalesce(w.tracked, false),
      check_interval_min = coalesce(w.interval_min, 60),
      next_check_at = case when coalesce(w.tracked, false) and not p.is_tracked then now() else p.next_check_at end
    from (
      select p2.sku,
             bool_or(yw.is_active) as tracked,
             min(yw.interval_min) filter (where yw.is_active) as interval_min
        from ym_products p2
        left join ym_watches yw on yw.sku = p2.sku and yw.is_active
       where p2.sku in (${sql.join(skus.map((s) => sql`${s}`), sql`, `)})
       group by p2.sku
    ) w
    where p.sku = w.sku
  `);
}

/** Отписка. */
export async function removeYmWatch(userId: number, watchId: number): Promise<boolean> {
  const [row] = await db
    .update(ymWatches)
    .set({ isActive: false })
    .where(and(eq(ymWatches.id, watchId), eq(ymWatches.userId, userId)))
    .returning({ sku: ymWatches.sku });
  if (!row) return false;
  await refreshYmTracking([row.sku]);
  return true;
}

/** Подписки пользователя с текущей ценой и дельтами. */
export async function listYmWatches(userId: number): Promise<Record<string, unknown>[]> {
  const result = await db.execute(sql`
    select w.id, w.sku, w.title, w.interval_min as "intervalMin",
           w.min_change_pct as "minChangePct", w.on_drop as "onDrop", w.on_rise as "onRise",
           w.created_at as "createdAt",
           p.name, p.image, p.url,
           p.last_price as "lastPrice", p.last_in_stock as "lastInStock",
           p.last_checked_at as "lastCheckedAt",
           (select pp.price from ym_price_points pp
             where pp.sku = w.sku and pp.checked_at <= now() - interval '24 hours'
             order by pp.checked_at desc limit 1) as "priceDayAgo",
           (select pp.price from ym_price_points pp
             where pp.sku = w.sku and pp.checked_at <= now() - interval '7 days'
             order by pp.checked_at desc limit 1) as "priceWeekAgo"
      from ym_watches w
      join ym_products p on p.sku = w.sku
     where w.user_id = ${userId} and w.is_active
     order by w.created_at desc
  `);
  return rowsOf<Record<string, unknown>>(result);
}

/** История цен одного товара. */
export async function ymHistory(sku: string, interval: string) {
  return db
    .select({
      checkedAt: ymPricePoints.checkedAt,
      price: ymPricePoints.price,
      inStock: ymPricePoints.inStock,
    })
    .from(ymPricePoints)
    .where(and(eq(ymPricePoints.sku, sku), sql`${ymPricePoints.checkedAt} >= now() - ${interval}::interval`))
    .orderBy(asc(ymPricePoints.checkedAt));
}

/** Товар не ответил: отодвигаем проверку тем дальше, чем дольше молчит. */
export async function markYmError(sku: string): Promise<void> {
  const [row] = await db
    .select({ errorCount: ymProducts.errorCount, checkIntervalMin: ymProducts.checkIntervalMin })
    .from(ymProducts)
    .where(eq(ymProducts.sku, sku))
    .limit(1);
  const errorCount = (row?.errorCount ?? 0) + 1;
  await db
    .update(ymProducts)
    .set({ errorCount, nextCheckAt: nextCheckTime((row?.checkIntervalMin ?? 60) * Math.min(2 ** errorCount, 12)) })
    .where(eq(ymProducts.sku, sku));
}

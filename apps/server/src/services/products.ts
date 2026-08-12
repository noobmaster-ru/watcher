// Применение снимка товара из WB к базе: обновление справочника, история цен
// и порождение событий.
//
// Здесь же живёт главное правило трекера: пропавшая цена — это «нет в продаже»,
// а не «цена упала». WB у распроданного товара не отдаёт объект price вообще
// (проверено на живом API), и без этой развилки каждый закончившийся товар
// выглядел бы как стопроцентная скидка.

import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { WbProduct } from "@watcher/wb-core";
import { db } from "../db/client.js";
import { alerts, pricePoints, products, watches, type AlertType } from "../db/schema.js";
import { config } from "../config.js";

/** Раз в сутки пишем точку, даже если ничего не изменилось: график не должен рваться. */
const HEARTBEAT_MS = 24 * 60 * 60 * 1000;

export interface PriceEvent {
  nm: number;
  type: AlertType;
  oldPrice: number | null;
  newPrice: number | null;
}

interface PreviousState {
  lastPrice: number | null;
  lastInStock: boolean | null;
  lastPointAt: Date | null;
}

/**
 * Что изменилось между прошлым состоянием и снимком. Чистая функция — вся
 * логика событий проверяема без базы.
 */
export function diffState(previous: PreviousState, next: WbProduct): PriceEvent[] {
  const nm = Number(next.nm);
  const newPrice = next.price.product;
  const oldPrice = previous.lastPrice;
  const events: PriceEvent[] = [];

  // первое наблюдение: событий нет, только точка отсчёта
  if (previous.lastInStock === null && previous.lastPrice === null) return events;

  const wasInStock = previous.lastInStock === true;
  if (wasInStock && !next.inStock) {
    events.push({ nm, type: "out_of_stock", oldPrice, newPrice: null });
    return events; // исчезновение цены вместе с товаром — одно событие, не два
  }
  if (!wasInStock && next.inStock) {
    events.push({ nm, type: "back_in_stock", oldPrice, newPrice });
    // цена при возврате в продажу могла измениться — сравним ниже
  }

  if (oldPrice !== null && newPrice !== null && newPrice !== oldPrice) {
    events.push({
      nm,
      type: newPrice < oldPrice ? "price_drop" : "price_rise",
      oldPrice,
      newPrice,
    });
  }
  return events;
}

/** Нужно ли писать точку в историю. */
function shouldRecordPoint(previous: PreviousState, next: WbProduct, hasEvents: boolean): boolean {
  if (hasEvents) return true;
  if (previous.lastPrice === null && previous.lastInStock === null) return true; // первая точка
  if (previous.lastPrice !== next.price.product) return true;
  if (previous.lastInStock !== next.inStock) return true;
  if (!previous.lastPointAt) return true;
  return Date.now() - previous.lastPointAt.getTime() >= HEARTBEAT_MS;
}

/** Сохраняет карточку в справочник, не трогая расписание и трекинг. */
export async function upsertProduct(product: WbProduct): Promise<void> {
  const nm = Number(product.nm);
  await db
    .insert(products)
    .values({
      nm,
      name: product.name,
      brand: product.brand,
      supplierId: product.supplierId,
      supplierName: product.supplier,
      root: product.root ? Number(product.root) : null,
      pics: product.pics,
      rating: product.rating,
      reviews: product.reviews,
    })
    .onConflictDoUpdate({
      target: products.nm,
      set: {
        name: product.name,
        brand: product.brand,
        supplierId: product.supplierId,
        supplierName: product.supplier,
        root: product.root ? Number(product.root) : null,
        pics: product.pics,
        rating: product.rating,
        reviews: product.reviews,
      },
    });
}

/**
 * Полное применение снимка: справочник → история → события → расписание.
 * Возвращает события, чтобы вызывающий решил, кому их разослать.
 */
export async function applySnapshot(
  product: WbProduct,
  options: { scheduleNext?: boolean } = {},
): Promise<PriceEvent[]> {
  const nm = Number(product.nm);
  const [existing] = await db
    .select({
      lastPrice: products.lastPrice,
      lastInStock: products.lastInStock,
      lastPointAt: products.lastPointAt,
      checkIntervalMin: products.checkIntervalMin,
    })
    .from(products)
    .where(eq(products.nm, nm))
    .limit(1);

  const previous: PreviousState = {
    lastPrice: existing?.lastPrice ?? null,
    lastInStock: existing?.lastInStock ?? null,
    lastPointAt: existing?.lastPointAt ?? null,
  };

  await upsertProduct(product);

  const events = diffState(previous, product);
  const now = new Date();
  const recordPoint = shouldRecordPoint(previous, product, events.length > 0);

  if (recordPoint) {
    await db.insert(pricePoints).values({
      nm,
      checkedAt: now,
      price: product.price.product,
      basic: product.price.basic,
      priceMin: product.price.min,
      priceMax: product.price.max,
      cashback: product.price.cashback,
      inStock: product.inStock,
      quantity: product.totalQuantity,
      dest: config.wb.dest,
      spp: Number(config.wb.spp),
    });
  }

  const intervalMin = existing?.checkIntervalMin ?? config.scheduler.defaultIntervalMin;
  const update: Record<string, unknown> = {
    lastPrice: product.price.product,
    lastBasic: product.price.basic,
    lastInStock: product.inStock,
    lastCheckedAt: now,
    errorCount: 0,
  };
  if (recordPoint) update.lastPointAt = now;
  if (options.scheduleNext !== false) update.nextCheckAt = nextCheckTime(intervalMin);

  await db.update(products).set(update).where(eq(products.nm, nm));

  return events;
}

/** Следующая проверка с джиттером ±10%: чтобы тысяча товаров не ломилась в WB одновременно. */
export function nextCheckTime(intervalMin: number): Date {
  const base = intervalMin * 60_000;
  const jitter = base * (Math.random() * 0.2 - 0.1);
  return new Date(Date.now() + base + jitter);
}

/** Товар не ответил: отодвигаем проверку тем дальше, чем дольше он молчит. */
export async function markProductError(nm: number): Promise<void> {
  const [row] = await db
    .select({ errorCount: products.errorCount, checkIntervalMin: products.checkIntervalMin })
    .from(products)
    .where(eq(products.nm, nm))
    .limit(1);
  const errorCount = (row?.errorCount ?? 0) + 1;
  const interval = (row?.checkIntervalMin ?? config.scheduler.defaultIntervalMin) * Math.min(2 ** errorCount, 24);
  await db
    .update(products)
    .set({ errorCount, nextCheckAt: nextCheckTime(interval) })
    .where(eq(products.nm, nm));
}

/**
 * Раскладывает события по подписчикам. Подписка на товар ловит свой артикул,
 * подписка на продавца — любой его товар.
 */
export async function fanOutEvents(events: PriceEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  const nms = [...new Set(events.map((e) => e.nm))];
  const supplierRows = await db
    .select({ nm: products.nm, supplierId: products.supplierId })
    .from(products)
    .where(inArray(products.nm, nms));
  const supplierByNm = new Map(supplierRows.map((r) => [r.nm, r.supplierId]));
  const supplierIds = [...new Set(supplierRows.map((r) => r.supplierId).filter((id): id is number => id !== null))];

  const subscriptions = await db
    .select()
    .from(watches)
    .where(
      and(
        eq(watches.isActive, true),
        or(
          inArray(watches.nm, nms),
          supplierIds.length > 0 ? inArray(watches.supplierId, supplierIds) : sql`false`,
        ),
      ),
    );
  if (subscriptions.length === 0) return 0;

  const rows: Array<typeof alerts.$inferInsert> = [];
  for (const event of events) {
    const supplierId = supplierByNm.get(event.nm) ?? null;
    for (const watch of subscriptions) {
      const matches =
        (watch.kind === "product" && watch.nm === event.nm) ||
        (watch.kind === "seller" && supplierId !== null && watch.supplierId === supplierId);
      if (!matches) continue;
      if (!passesRules(watch, event)) continue;
      rows.push({
        userId: watch.userId,
        watchId: watch.id,
        nm: event.nm,
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

/** Проходит ли событие пороги подписки. */
export function passesRules(
  watch: { minChangePct: number; minChangeAbs: number; onDrop: boolean; onRise: boolean; onStockChange: boolean; onNewProduct: boolean },
  event: PriceEvent,
): boolean {
  switch (event.type) {
    case "price_drop":
      if (!watch.onDrop) return false;
      break;
    case "price_rise":
      if (!watch.onRise) return false;
      break;
    case "out_of_stock":
    case "back_in_stock":
      return watch.onStockChange;
    case "new_product":
      return watch.onNewProduct;
  }

  // пороги применимы только к изменению цены
  if (event.oldPrice === null || event.newPrice === null) return true;
  const delta = Math.abs(event.newPrice - event.oldPrice);
  if (delta < watch.minChangeAbs) return false;
  const pct = (delta / event.oldPrice) * 100;
  return pct >= watch.minChangePct;
}

/**
 * Пересчитывает, нужно ли опрашивать товар и как часто. Интервал — минимальный
 * из запрошенных подписчиками: кто хочет чаще, тот и задаёт темп.
 */
export async function refreshTracking(nms: number[]): Promise<void> {
  if (nms.length === 0) return;
  const unique = [...new Set(nms)];

  await db.execute(sql`
    update products p set
      is_tracked = coalesce(w.tracked, false),
      check_interval_min = coalesce(w.interval_min, ${config.scheduler.defaultIntervalMin}),
      next_check_at = case
        when coalesce(w.tracked, false) and not p.is_tracked then now()
        else p.next_check_at
      end
    from (
      select p2.nm,
             bool_or(watches.is_active) as tracked,
             min(watches.interval_min) filter (where watches.is_active) as interval_min
      from products p2
      left join watches on watches.is_active
        and (watches.nm = p2.nm or watches.supplier_id = p2.supplier_id)
      where p2.nm in (${sql.join(unique.map((nm) => sql`${nm}`), sql`, `)})
      group by p2.nm
    ) w
    where p.nm = w.nm
  `);
}

/** Товары, у которых нет ни одной подписки, больше не опрашиваем. */
export async function untrackOrphans(): Promise<void> {
  await db.execute(sql`
    update products p set is_tracked = false
    where p.is_tracked
      and not exists (
        select 1 from watches w
        where w.is_active and (w.nm = p.nm or w.supplier_id = p.supplier_id)
      )
  `);
}

/** Есть ли у товара хоть одна активная подписка (для ответов API). */
export async function isTrackedByUser(nm: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: watches.id })
    .from(watches)
    .where(and(eq(watches.userId, userId), eq(watches.isActive, true), eq(watches.nm, nm), isNotNull(watches.nm)))
    .limit(1);
  return Boolean(row);
}

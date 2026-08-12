// Подписки: добавление товара или продавца на отслеживание и синхронизация
// каталога продавца.
//
// Подписка на продавца — это не список артикулов, зафиксированный в момент
// добавления, а живой запрос: каталог пересинхронизируется по расписанию, и
// появившиеся товары сами попадают под наблюдение (с событием new_product).

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { WbClient } from "@watcher/wb-core";
import { db, rowsOf } from "../db/client.js";
import { alerts, products, sellerProducts, sellerSnapshots, sellers, watches, type WatchKind } from "../db/schema.js";
import { config } from "../config.js";
import { applySnapshot, fanOutEvents, refreshTracking, untrackOrphans, upsertProduct } from "./products.js";

export interface WatchInput {
  userId: number;
  kind: WatchKind;
  nm?: number;
  supplierId?: number;
  intervalMin?: number;
  minChangePct?: number;
  minChangeAbs?: number;
  onDrop?: boolean;
  onRise?: boolean;
  onStockChange?: boolean;
  onNewProduct?: boolean;
}

function clampInterval(value: number | undefined): number {
  const raw = value ?? config.scheduler.defaultIntervalMin;
  return Math.min(Math.max(raw, config.limits.minIntervalMin), config.limits.maxIntervalMin);
}

/** Ставит товар на отслеживание, попутно подтягивая карточку из WB. */
export async function watchProduct(client: WbClient, input: WatchInput & { nm: number }): Promise<number> {
  const product = await client.detail(input.nm, "interactive");
  if (!product) throw new Error(`Товар ${input.nm} не найден на Wildberries`);

  await upsertProduct(product);
  await applySnapshot(product, { scheduleNext: false });

  const [row] = await db
    .insert(watches)
    .values({
      userId: input.userId,
      kind: "product",
      nm: input.nm,
      title: product.name,
      intervalMin: clampInterval(input.intervalMin),
      minChangePct: input.minChangePct ?? 1,
      minChangeAbs: input.minChangeAbs ?? 0,
      onDrop: input.onDrop ?? true,
      onRise: input.onRise ?? false,
      onStockChange: input.onStockChange ?? true,
      onNewProduct: input.onNewProduct ?? true,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [watches.userId, watches.nm],
      // индекс частичный (where nm is not null) — без того же условия Postgres
      // его для ON CONFLICT не подберёт
      targetWhere: sql`${watches.nm} is not null`,
      set: { isActive: true, intervalMin: clampInterval(input.intervalMin), title: product.name },
    })
    .returning({ id: watches.id });

  await refreshTracking([input.nm]);
  return row?.id ?? 0;
}

/** Ставит на отслеживание весь каталог продавца. */
export async function watchSeller(
  client: WbClient,
  input: WatchInput & { supplierId: number },
): Promise<{ watchId: number; productCount: number; truncated: boolean }> {
  const seller = await client.seller(input.supplierId, "interactive");
  if (!seller) throw new Error(`Продавец ${input.supplierId} не найден на Wildberries`);

  await db
    .insert(sellers)
    .values({
      supplierId: seller.supplierId,
      name: seller.name,
      fullName: seller.fullName,
      inn: seller.inn,
      trademark: seller.trademark,
      nextSyncAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sellers.supplierId,
      set: { name: seller.name, fullName: seller.fullName, inn: seller.inn, trademark: seller.trademark },
    });

  const [row] = await db
    .insert(watches)
    .values({
      userId: input.userId,
      kind: "seller",
      supplierId: input.supplierId,
      title: seller.name,
      intervalMin: clampInterval(input.intervalMin),
      minChangePct: input.minChangePct ?? 1,
      minChangeAbs: input.minChangeAbs ?? 0,
      onDrop: input.onDrop ?? true,
      onRise: input.onRise ?? false,
      onStockChange: input.onStockChange ?? true,
      onNewProduct: input.onNewProduct ?? true,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [watches.userId, watches.supplierId],
      targetWhere: sql`${watches.supplierId} is not null`,
      set: { isActive: true, intervalMin: clampInterval(input.intervalMin), title: seller.name },
    })
    .returning({ id: watches.id });

  const sync = await syncSellerCatalog(client, input.supplierId, { announceNew: false });
  return { watchId: row?.id ?? 0, productCount: sync.total, truncated: sync.truncated };
}

/**
 * Обходит каталог продавца и приводит `seller_products` в соответствие с ним.
 * Товары, пропавшие из каталога, помечаются неактивными, но история цен по ним
 * остаётся — она ещё пригодится.
 */
export async function syncSellerCatalog(
  client: WbClient,
  supplierId: number,
  options: { announceNew?: boolean } = {},
): Promise<{ total: number; added: number; removed: number; truncated: boolean }> {
  const maxPages = Math.ceil(config.limits.maxSellerProducts / 100);
  const catalog = await client.sellerCatalogAll(supplierId, "background", maxPages);

  const known = await db
    .select({ nm: sellerProducts.nm })
    .from(sellerProducts)
    .where(and(eq(sellerProducts.supplierId, supplierId), eq(sellerProducts.isActive, true)));
  const knownNms = new Set(known.map((r) => r.nm));

  const seenNms: number[] = [];
  const freshNms: number[] = [];
  const now = new Date();

  for (const product of catalog.products) {
    const nm = Number(product.nm);
    seenNms.push(nm);
    if (!knownNms.has(nm)) freshNms.push(nm);
    await upsertProduct(product);
    // Снимок из каталога — такой же источник цены, как и обход планировщика.
    // Его события нужно разослать здесь: applySnapshot уже сдвинул lastPrice,
    // и следующий тик разницы не увидит.
    const events = await applySnapshot(product, { scheduleNext: false });
    if (events.length > 0) await fanOutEvents(events);
  }

  if (seenNms.length > 0) {
    // пачками: у крупного продавца тысячи артикулов, а параметров в запросе конечное число
    for (let i = 0; i < seenNms.length; i += 500) {
      const chunk = seenNms.slice(i, i + 500);
      await db
        .insert(sellerProducts)
        .values(chunk.map((nm) => ({ supplierId, nm, firstSeenAt: now, lastSeenAt: now, isActive: true })))
        .onConflictDoUpdate({
          target: [sellerProducts.supplierId, sellerProducts.nm],
          set: { lastSeenAt: now, isActive: true },
        });
    }
  }

  // Товары гасим, только если каталог обойдён целиком. Оборванный обход (лимит
  // WB, 404 посреди пагинации, упор в потолок страниц) даёт неполный список, и
  // доверять ему нельзя: иначе половина ассортимента помечается пропавшей, а на
  // следующей синхронизации возвращается как «новые товары» — с уведомлениями.
  const trustworthy = catalog.complete && !catalog.truncated && seenNms.length > 0;
  const removed = trustworthy
    ? await db
        .update(sellerProducts)
        .set({ isActive: false })
        .where(
          and(
            eq(sellerProducts.supplierId, supplierId),
            eq(sellerProducts.isActive, true),
            notInArray(sellerProducts.nm, seenNms),
          ),
        )
        .returning({ nm: sellerProducts.nm })
    : [];
  if (!trustworthy) {
    console.error(
      `[sellers] каталог ${supplierId} получен не полностью (страниц ${catalog.pagesFetched}, товаров ${seenNms.length}) — снятие с продажи пропущено`,
    );
  }

  await captureSellerSnapshot(supplierId, seenNms);

  await db
    .update(sellers)
    .set({
      lastSyncedAt: now,
      nextSyncAt: new Date(Date.now() + config.scheduler.sellerSyncIntervalHours * 3600_000),
      productCount: seenNms.length,
    })
    .where(eq(sellers.supplierId, supplierId));

  if (seenNms.length > 0) await refreshTracking(seenNms);

  // о новинках сообщаем только при плановой пересинхронизации: в момент подписки
  // весь каталог «новый», и заваливать пользователя сотней уведомлений незачем
  if (options.announceNew !== false && freshNms.length > 0 && trustworthy) {
    const rows = await db
      .select({ nm: products.nm, price: products.lastPrice })
      .from(products)
      .where(inArray(products.nm, freshNms));
    await fanOutEvents(
      rows.map((r) => ({ nm: r.nm, type: "new_product" as const, oldPrice: null, newPrice: r.price })),
    );
  }

  return { total: seenNms.length, added: freshNms.length, removed: removed.length, truncated: catalog.truncated };
}

/**
 * Записывает срез по продавцу: сколько товаров, сколько в наличии, разброс цен.
 * История цен есть у каждого товара, но по продавцу целиком её собрать неоткуда —
 * каталог меняется, и без среза нельзя ответить, что у него было месяц назад.
 */
async function captureSellerSnapshot(supplierId: number, nms: number[]): Promise<void> {
  if (nms.length === 0) return;
  const [stats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      inStock: sql<number>`count(*) filter (where ${products.lastInStock})::int`,
      min: sql<number | null>`min(${products.lastPrice})::int`,
      max: sql<number | null>`max(${products.lastPrice})::int`,
      avg: sql<number | null>`round(avg(${products.lastPrice}))::int`,
    })
    .from(products)
    .where(inArray(products.nm, nms));
  if (!stats) return;

  await db.insert(sellerSnapshots).values({
    supplierId,
    productCount: stats.total,
    inStockCount: stats.inStock,
    minPrice: stats.min,
    maxPrice: stats.max,
    avgPrice: stats.avg,
  });
}

/** Отписка: подписка деактивируется, товары без подписчиков перестают опрашиваться. */
export async function removeWatch(userId: number, watchId: number): Promise<boolean> {
  const [row] = await db
    .update(watches)
    .set({ isActive: false })
    .where(and(eq(watches.id, watchId), eq(watches.userId, userId)))
    .returning({ id: watches.id, nm: watches.nm, kind: watches.kind, supplierId: watches.supplierId });
  if (!row) return false;

  // Пересчитываем не только «опрашивать или нет», но и частоту: ушедший
  // подписчик мог быть единственным, кто просил проверять раз в 15 минут.
  await refreshTracking(await affectedProducts(row));
  await untrackOrphans();
  return true;
}

/** Артикулы, на которые влияет изменение подписки. */
async function affectedProducts(row: { nm: number | null; supplierId: number | null }): Promise<number[]> {
  if (row.nm) return [row.nm];
  if (row.supplierId === null) return [];
  const rows = await db
    .select({ nm: sellerProducts.nm })
    .from(sellerProducts)
    .where(and(eq(sellerProducts.supplierId, row.supplierId), eq(sellerProducts.isActive, true)));
  return rows.map((r) => r.nm);
}

export { affectedProducts };

/** Список подписок пользователя с текущей ценой и дельтами за сутки и неделю. */
export async function listWatches(userId: number): Promise<Record<string, unknown>[]> {
  const result = await db.execute(sql`
    select
      w.id, w.kind, w.nm, w.supplier_id as "supplierId", w.title, w.interval_min as "intervalMin",
      w.min_change_pct as "minChangePct", w.min_change_abs as "minChangeAbs",
      w.on_drop as "onDrop", w.on_rise as "onRise", w.on_stock_change as "onStockChange",
      w.on_new_product as "onNewProduct",
      w.created_at as "createdAt",
      p.name as "productName", p.brand, p.supplier_name as "supplierName",
      p.last_price as "lastPrice", p.last_basic as "lastBasic", p.last_in_stock as "lastInStock",
      p.last_checked_at as "lastCheckedAt",
      s.name as "sellerName", s.product_count as "sellerProductCount",
      (
        select pp.price from price_points pp
        where pp.nm = w.nm and pp.checked_at <= now() - interval '24 hours'
        order by pp.checked_at desc limit 1
      ) as "priceDayAgo",
      (
        select pp.price from price_points pp
        where pp.nm = w.nm and pp.checked_at <= now() - interval '7 days'
        order by pp.checked_at desc limit 1
      ) as "priceWeekAgo",
      (
        select count(*) from seller_products sp
        where sp.supplier_id = w.supplier_id and sp.is_active
      ) as "trackedProducts"
    from watches w
    left join products p on p.nm = w.nm
    left join sellers s on s.supplier_id = w.supplier_id
    where w.user_id = ${userId} and w.is_active
    order by w.created_at desc
  `);
  return rowsOf<Record<string, unknown>>(result);
}

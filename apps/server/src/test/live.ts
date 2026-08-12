#!/usr/bin/env node
// Сквозная проверка на живом Wildberries: подписка → обход планировщика →
// история цен → каталог продавца. База поднимается во временном PGlite, так что
// проверка не трогает ни боевые данные, ни Postgres.
//
//   npm run check:live

import { eq } from "drizzle-orm";
import { WbClient } from "@watcher/wb-core";
import { pricePoints, products, sellerProducts, users } from "../db/schema.js";
import { runPriceTick } from "../scheduler/prices.js";
import { watchProduct, watchSeller } from "../services/watches.js";
import { config } from "../config.js";
import { createTestDb } from "./harness.js";

// эталоны, проверенные на живом API 12.08.2026
const NM = 242678284; // «Оплетка на руль», в наличии
const SELLER = 809881; // «ДЭМИАЛ», небольшой каталог

const { db, close } = await createTestDb();
const wb = new WbClient({
  dest: config.wb.dest,
  spp: config.wb.spp,
  proxy: config.wb.proxy,
  netInterface: config.wb.netInterface,
  log: () => {},
});

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ step: name, ok: true, detail: await fn() });
  } catch (error) {
    results.push({ step: name, ok: false, detail: (error as Error).message });
  }
}

const [user] = await db
  .insert(users)
  .values({ email: "live@example.com", passwordHash: "scrypt$00$00" })
  .returning({ id: users.id });
const userId = user!.id;

await step("подписка на товар с живой ценой", async () => {
  await watchProduct(wb, { userId, kind: "product", nm: NM });
  const [product] = await db.select().from(products).where(eq(products.nm, NM));
  if (!product?.name) throw new Error("карточка не сохранилась");
  if (product.lastPrice === null) throw new Error("цена не записалась");
  if (!product.isTracked) throw new Error("товар не встал на отслеживание");
  return `${product.name?.slice(0, 40)} — ${product.lastPrice} ₽`;
});

await step("первая точка истории", async () => {
  const points = await db.select().from(pricePoints).where(eq(pricePoints.nm, NM));
  if (points.length !== 1) throw new Error(`ожидалась одна точка, получено ${points.length}`);
  if (points[0]!.dest !== config.wb.dest) throw new Error("в точке не записан регион");
  return `цена ${points[0]!.price} ₽, регион ${points[0]!.dest}, наличие ${points[0]!.inStock}`;
});

await step("тик планировщика ходит в WB пачкой", async () => {
  await db.update(products).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(products.nm, NM));
  const tick = await runPriceTick(wb);
  if (tick.degraded) throw new Error("WB ограничил запросы — повторите позже");
  if (tick.checked === 0) throw new Error("планировщик не проверил ни одного товара");
  return `проверено ${tick.checked}, событий ${tick.events}`;
});

await step("подписка на каталог продавца", async () => {
  const result = await watchSeller(wb, { userId, kind: "seller", supplierId: SELLER });
  if (result.productCount === 0) throw new Error("каталог продавца пуст — проверьте catalog.wb.ru");
  const tracked = await db.select().from(sellerProducts).where(eq(sellerProducts.supplierId, SELLER));
  return `${result.productCount} товаров у продавца, в базе ${tracked.length}`;
});

await step("товары продавца встали на обход", async () => {
  const rows = await db.select().from(products).where(eq(products.supplierId, SELLER));
  const tracked = rows.filter((r) => r.isTracked);
  const priced = rows.filter((r) => r.lastPrice !== null);
  if (tracked.length === 0) throw new Error("ни один товар продавца не отслеживается");
  return `${tracked.length} отслеживается, у ${priced.length} есть цена`;
});

await step("массовый тик по каталогу", async () => {
  await db.update(products).set({ nextCheckAt: new Date(Date.now() - 60_000) });
  const tick = await runPriceTick(wb);
  return `за один запрос к WB проверено ${tick.checked} товаров`;
});

// ── отчёт ───────────────────────────────────────────────────────────────────
const pad = Math.max(...results.map((r) => r.step.length));
console.log("\nСквозная проверка на живом Wildberries\n");
for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"}  ${r.step.padEnd(pad)}  ${r.detail}`);

console.log("\nСостояние хостов WB:");
for (const host of wb.hostStatuses()) console.log(`  ${host.host.padEnd(32)} ${host.state}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\nИтог: ${results.length - failed}/${results.length}\n`);
await close();
process.exit(failed > 0 ? 1 : 0);

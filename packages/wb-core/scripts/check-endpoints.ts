#!/usr/bin/env node
// Смоук всех эндпоинтов Wildberries. WB меняет API регулярно — это первое, что
// нужно запустить, если приложение вдруг перестало отдавать цены.
//
//   npm run check:endpoints
//   WB_PROXY=http://user:pass@host:port npm run check:endpoints

import { WbClient, WbUnavailableError } from "../src/index.js";

// Эталонные объекты, проверенные вживую 12.08.2026
const IN_STOCK_NM = 242678284; // «Оплетка на руль», есть в наличии, цена 1633 ₽
const OUT_OF_STOCK_NM = 719482347; // MacBook Pro, totalQuantity = 0, цены нет
const SELLER_ID = 809881; // «ДЭМИАЛ», небольшой каталог на 63 товара

const client = new WbClient({
  dest: process.env.WB_DEST ?? "-1257786",
  spp: process.env.WB_SPP ?? "30",
  proxy: process.env.WB_PROXY || undefined,
  netInterface: process.env.WB_INTERFACE || undefined,
});

interface Row {
  name: string;
  ok: boolean;
  detail: string;
}
const rows: Row[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    rows.push({ name, ok: true, detail: `${detail} (${Date.now() - started} мс)` });
  } catch (err) {
    const message =
      err instanceof WbUnavailableError
        ? `лимит WB: ${err.message}`
        : (err as Error)?.message ?? String(err);
    rows.push({ name, ok: false, detail: message });
  }
}

await check("карточка (батч из 2 nm)", async () => {
  const products = await client.detailBatch([IN_STOCK_NM, OUT_OF_STOCK_NM], "interactive");
  if (products.length === 0) throw new Error("пусто — card.wb.ru не отдал товары");
  const inStock = products.find((p) => p.nm === String(IN_STOCK_NM));
  if (!inStock) throw new Error(`нет товара ${IN_STOCK_NM} в ответе`);
  if (inStock.price.product === null) throw new Error(`у ${IN_STOCK_NM} пропала цена — проверить parsePrice`);
  return `${products.length} товаров, цена ${IN_STOCK_NM} = ${inStock.price.product} ₽`;
});

await check("товар не в наличии отдаёт null, а не 0", async () => {
  const product = await client.detail(OUT_OF_STOCK_NM);
  if (!product) throw new Error("товар не найден");
  if (product.inStock) return `внимание: ${OUT_OF_STOCK_NM} снова в наличии, выберите другой эталон`;
  if (product.price.product !== null) throw new Error("цена у распроданного товара должна быть null");
  return "ок: inStock=false, price=null";
});

await check("card.json (описание и характеристики)", async () => {
  const info = await client.cardInfo(IN_STOCK_NM);
  const count = Object.keys(info.characteristics).length;
  if (count === 0 && !info.description) throw new Error("ни описания, ни характеристик");
  return `описание ${info.description.length} симв., характеристик ${count}`;
});

await check("продавец (supplier-by-id)", async () => {
  const seller = await client.seller(SELLER_ID);
  if (!seller) throw new Error("продавец не найден");
  return `${seller.name ?? "без названия"}${seller.inn ? `, ИНН ${seller.inn}` : ""}`;
});

await check("каталог продавца", async () => {
  const page = await client.sellerCatalogPage(SELLER_ID, 1);
  if (page.products.length === 0) {
    throw new Error(
      "пустой каталог — либо WB сменил версию эндпоинта, либо у продавца нет активных товаров",
    );
  }
  return `${page.products.length} товаров на странице, total=${page.total ?? "?"}`;
});

await check("поиск по фразе", async () => {
  const items = await client.search("носки мужские", 5);
  if (items.length === 0) throw new Error("пустая выдача");
  return `${items.length} товаров, первый: ${items[0]?.name ?? "?"}`;
});

await check("отзывы", async () => {
  const product = await client.detail(IN_STOCK_NM);
  if (!product?.root) throw new Error("в карточке нет root (imtId) — отзывы не найти");
  const reviews = await client.reviews(product.root, 3);
  return `рейтинг ${reviews.rating ?? "?"}, всего ${reviews.totalReviews ?? "?"}, получено ${reviews.count}`;
});

// ── отчёт ───────────────────────────────────────────────────────────────────
const pad = Math.max(...rows.map((r) => r.name.length));
console.log("\nПроверка эндпоинтов Wildberries\n");
for (const row of rows) {
  console.log(`  ${row.ok ? "✅" : "❌"}  ${row.name.padEnd(pad)}  ${row.detail}`);
}

console.log("\nСостояние хостов:");
for (const status of client.hostStatuses()) {
  console.log(`  ${status.host.padEnd(34)} ${status.state}  (последний код: ${status.lastStatus ?? "—"})`);
}

const failed = rows.filter((r) => !r.ok);
console.log(`\nИтог: ${rows.length - failed.length}/${rows.length} успешно\n`);
process.exit(failed.length > 0 ? 1 : 0);

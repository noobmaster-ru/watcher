#!/usr/bin/env node
// Живая проверка Яндекс Маркета: работает ли поиск, извлекается ли цена,
// разворачивается ли ссылка на карточку в sku.
//
//   npm run check:endpoints -w @watcher/ym-core

import { YmClient } from "../src/index.js";

const SKU = "103522724497"; // «Набор шампуров 5 шт», проверено вживую
const CARD = "https://market.yandex.ru/card/nabor-shampurov-5-sht-vip-65-sm/102097399814";

const client = new YmClient({ proxy: process.env.YM_PROXY, log: () => {} });
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (error) {
    results.push({ name, ok: false, detail: (error as Error).message });
  }
}

await step("поиск по фразе", async () => {
  const items = await client.search("шампуры для шашлыка", 5);
  if (items.length === 0) throw new Error("выдача пуста");
  const withPrice = items.filter((i) => i.price !== null).length;
  return `${items.length} товаров, у ${withPrice} есть цена; первый: ${items[0]?.name?.slice(0, 34)} — ${items[0]?.price} ₽`;
});

await step("цена по номеру товара", async () => {
  const product = await client.bySku(SKU);
  if (!product) throw new Error(`товар ${SKU} не найден`);
  if (product.price === null) throw new Error("цена не извлеклась");
  return `${product.name?.slice(0, 38)} — ${product.price} ₽, в наличии: ${product.inStock}`;
});

await step("ссылка на карточку → номер товара", async () => {
  const sku = await client.resolveSku(CARD);
  if (sku !== SKU) throw new Error(`развернулось в ${sku}, ожидалось ${SKU}`);
  return `${sku}`;
});

const pad = Math.max(...results.map((r) => r.name.length));
console.log("\nЯндекс Маркет\n");
for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"}  ${r.name.padEnd(pad)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\nИтог: ${results.length - failed}/${results.length}\n`);
process.exit(failed > 0 ? 1 : 0);

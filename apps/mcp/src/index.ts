#!/usr/bin/env node
// MCP-сервер Wildberries поверх общего ядра wb-core — та же логика запросов и
// лимитов, что и у веб-приложения.
//
// КРИТИЧНО: stdout занят протоколом JSON-RPC. Всё, что нужно вывести, идёт в stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WbClient, WbUnavailableError, toNm, toSupplierId } from "@watcher/wb-core";

const log = (...args: unknown[]) => console.error("[wb-mcp]", ...args);
const TOOL_TIMEOUT_MS = 60_000;
const MAX_TEXT = 250_000;

const wb = new WbClient({
  dest: process.env.WB_DEST ?? "-1257786",
  spp: process.env.WB_SPP ?? "30",
  proxy: process.env.WB_PROXY || undefined,
  netInterface: process.env.WB_INTERFACE || undefined,
  log,
});

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: превышено время ожидания ${ms} мс`)), ms),
    ),
  ]);
}

function tool<A>(label: string, fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      const result = await withTimeout(fn(args), TOOL_TIMEOUT_MS, label);
      let text = JSON.stringify(result, null, 2);
      if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n…(обрезано)`;
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      const message =
        error instanceof WbUnavailableError
          ? `Wildberries ограничивает запросы: ${error.message}`
          : ((error as Error)?.message ?? String(error));
      log(`${label}:`, message);
      return { content: [{ type: "text" as const, text: `Ошибка: ${message}` }], isError: true };
    }
  };
}

const server = new McpServer({ name: "watcher-wb-mcp", version: "0.1.0" });

server.registerTool(
  "wb_search",
  {
    title: "Поиск товаров на Wildberries",
    description:
      "Ищет товары на wildberries.ru. Возвращает название, цену в рублях, старую цену, рейтинг, число отзывов, " +
      "бренд, продавца, картинку и ссылку. Учтите: WB жёстко лимитирует поиск, при отказе попробуйте позже.",
    inputSchema: {
      query: z.string().min(1).describe('Поисковый запрос, например "носки мужские" или "macbook pro"'),
      limit: z.number().int().min(1).max(300).default(24).describe("Сколько товаров вернуть (1–300)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  tool("wb_search", async ({ query, limit }: { query: string; limit: number }) => {
    const items = await wb.search(query, limit);
    return { query, count: items.length, items };
  }),
);

server.registerTool(
  "wb_product_details",
  {
    title: "Карточка товара Wildberries",
    description:
      "Полные данные по товару: цена, старая цена, наличие, рейтинг, отзывы, бренд, продавец, цвета, " +
      "описание и характеристики. Принимает артикул (nm) или ссылку на товар. " +
      "Если товара нет в наличии, цена возвращается как null — это не нулевая цена.",
    inputSchema: {
      product: z.string().min(1).describe('Артикул (например "242678284") или ссылка на товар'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  tool("wb_product_details", async ({ product }: { product: string }) => {
    const nm = toNm(product);
    const full = await wb.fullProduct(nm);
    if (!full) throw new Error(`Товар ${nm} не найден`);
    return full;
  }),
);

server.registerTool(
  "wb_product_prices",
  {
    title: "Цены пачкой по списку артикулов",
    description:
      "Возвращает цену и наличие сразу для многих товаров: до 100 артикулов уходят в WB одним запросом. " +
      "Удобно для сравнения цен и мониторинга подборки.",
    inputSchema: {
      products: z.array(z.string().min(1)).min(1).max(500).describe("Список артикулов или ссылок"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  tool("wb_product_prices", async ({ products }: { products: string[] }) => {
    const nms = products.map(toNm);
    const items = await wb.detailBatch(nms, "interactive");
    const found = new Set(items.map((i) => i.nm));
    return {
      requested: nms.length,
      count: items.length,
      missing: nms.filter((nm) => !found.has(String(nm))),
      items: items.map((i) => ({
        nm: i.nm,
        name: i.name,
        price: i.price.product,
        oldPrice: i.price.basic,
        inStock: i.inStock,
        supplier: i.supplier,
        url: i.url,
      })),
    };
  }),
);

server.registerTool(
  "wb_product_reviews",
  {
    title: "Отзывы о товаре Wildberries",
    description:
      "Отзывы покупателей: автор, оценка, текст, плюсы, минусы, дата, цвет и размер. " +
      "Принимает артикул (nm) или ссылку на товар.",
    inputSchema: {
      product: z.string().min(1).describe("Артикул (nm) или ссылка на товар"),
      limit: z.number().int().min(1).max(30).default(10).describe("Сколько отзывов вернуть (1–30)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  tool("wb_product_reviews", async ({ product, limit }: { product: string; limit: number }) => {
    const nm = toNm(product);
    const details = await wb.detail(nm);
    if (!details?.root) throw new Error(`Для товара ${nm} не удалось определить id отзывов (root)`);
    return { nm: String(nm), name: details.name, ...(await wb.reviews(details.root, limit)) };
  }),
);

server.registerTool(
  "wb_seller_info",
  {
    title: "Информация о продавце Wildberries",
    description:
      "Данные продавца по ID или ссылке вида wildberries.ru/seller/123456: название, полное юридическое " +
      "наименование, ИНН, торговая марка.",
    inputSchema: {
      seller: z.string().min(1).describe('ID продавца (например "809881") или ссылка на его страницу'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  tool("wb_seller_info", async ({ seller }: { seller: string }) => {
    const supplierId = toSupplierId(seller);
    const info = await wb.seller(supplierId);
    if (!info) throw new Error(`Продавец ${supplierId} не найден`);
    return info;
  }),
);

server.registerTool(
  "wb_seller_products",
  {
    title: "Каталог продавца Wildberries",
    description:
      "Товары продавца с ценами, постранично (до 100 товаров на страницу). Принимает ID продавца или ссылку. " +
      "Позволяет посмотреть весь ассортимент и сравнить цены внутри одного продавца.",
    inputSchema: {
      seller: z.string().min(1).describe("ID продавца или ссылка на его страницу"),
      page: z.number().int().min(1).max(50).default(1).describe("Номер страницы (по 100 товаров)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  tool("wb_seller_products", async ({ seller, page }: { seller: string; page: number }) => {
    const supplierId = toSupplierId(seller);
    const result = await wb.sellerCatalogPage(supplierId, page);
    return { supplierId, page, total: result.total, count: result.products.length, items: result.products };
  }),
);

// ── жизненный цикл ──────────────────────────────────────────────────────────
let cleaning = false;
function cleanup(): void {
  if (cleaning) return;
  cleaning = true;
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("uncaughtException", (error) => {
  log("uncaughtException:", error);
  cleanup();
});
process.on("unhandledRejection", (reason) => log("unhandledRejection:", reason));

const transport = new StdioServerTransport();
transport.onclose = cleanup;
await server.connect(transport);
log("готов, транспорт stdio");

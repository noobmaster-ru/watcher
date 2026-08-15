// HTTP-обёртка вокруг браузера. Живёт в docker-сети, наружу не торчит:
// основное приложение ходит сюда как в обычный источник цен, а весь Chromium
// со своими 300–500 МБ заперт в этом контейнере — его падение или прожорливость
// не задевают API и базу.

import Fastify from "fastify";
import { browserStatus, fetchComposer, shutdown } from "./browser.js";
import { parseProduct, parseSearch } from "./parse.js";

const app = Fastify({ logger: false });
const log = (...args: unknown[]) => console.error("[ozon-agent]", ...args);

// Запросы к Озону идём строго по одному: браузер один, и параллельная долбёжка
// из нескольких обработчиков — верный способ навлечь повторный челлендж.
let gate: Promise<void> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = gate.then(fn, fn);
  gate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

app.get("/health", async (_request, reply) => {
  return reply.send({ ok: true, browser: browserStatus() });
});

app.get<{ Params: { sku: string } }>("/product/:sku", async (request, reply) => {
  const sku = request.params.sku;
  if (!/^\d{5,16}$/.test(sku)) return reply.code(400).send({ error: "нужен числовой sku" });

  try {
    const page = await serialize(() => fetchComposer(`/product/${sku}/`));
    const product = parseProduct(page);
    if (!product.sku) return reply.code(404).send({ error: "товар не найден" });
    return reply.send(product);
  } catch (error) {
    const message = (error as Error).message;
    log(`product ${sku}:`, message);
    // 404 от композера — товара нет; всё остальное — недоступность
    if (/HTTP 404/.test(message)) return reply.code(404).send({ error: "товар не найден" });
    return reply.code(503).send({ error: message });
  }
});

app.get<{ Querystring: { q?: string; limit?: string } }>("/search", async (request, reply) => {
  const query = String(request.query.q ?? "").trim();
  if (query.length < 2) return reply.code(400).send({ error: "нужен запрос" });
  const limit = Math.min(Math.max(Number(request.query.limit ?? 12) || 12, 1), 30);

  try {
    const page = await serialize(() =>
      fetchComposer(`/search/?text=${encodeURIComponent(query)}&from_global=true`),
    );
    return reply.send({ items: parseSearch(page, limit) });
  } catch (error) {
    log(`search «${query}»:`, (error as Error).message);
    return reply.code(503).send({ error: (error as Error).message });
  }
});

const port = Number(process.env.PORT ?? 8100);
await app.listen({ port, host: "0.0.0.0" });
log(`слушает :${port}`);

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

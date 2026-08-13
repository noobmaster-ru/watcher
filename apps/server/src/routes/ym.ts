import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { YmUnavailableError, type YmClient } from "@watcher/ym-core";
import { db } from "../db/client.js";
import { ymProducts, ymWatches } from "../db/schema.js";
import { requireAuth } from "../auth.js";
import { listYmWatches, removeYmWatch, watchYmProduct, ymHistory } from "../services/ym.js";

const RANGES: Record<string, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "100 years",
};

export async function ymRoutes(app: FastifyInstance, client: YmClient): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/ym/watches", async (request, reply) => {
    return reply.send({ watches: await listYmWatches(request.user!.id) });
  });

  app.post("/api/ym/watches", async (request, reply) => {
    const parsed = z
      .object({ product: z.string().min(4).max(300), intervalMin: z.coerce.number().int().min(30).max(1440).optional() })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Укажите номер товара Яндекс Маркета или ссылку на него" });
    }

    try {
      const result = await watchYmProduct(client, {
        userId: request.user!.id,
        input: parsed.data.product,
        intervalMin: parsed.data.intervalMin,
      });

      if (result.kind === "candidates") {
        // Ссылку в номер товара надёжно не развернуть, поэтому выбирает человек.
        return reply.code(409).send({
          needsChoice: true,
          query: result.query,
          candidates: result.items,
          error: `Из ссылки товар определяется неточно. Выберите нужный из найденного по запросу «${result.query}»`,
        });
      }
      return reply.send({ watchId: result.watchId, sku: result.sku, product: result.product });
    } catch (error) {
      if (error instanceof YmUnavailableError) {
        return reply.code(503).send({ error: error.message, degraded: true });
      }
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.delete("/api/ym/watches/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный id" });
    const removed = await removeYmWatch(request.user!.id, params.data.id);
    if (!removed) return reply.code(404).send({ error: "Подписка не найдена" });
    return reply.send({ ok: true });
  });

  app.get("/api/ym/product/:sku/history", async (request, reply) => {
    const params = z.object({ sku: z.string().regex(/^\d{6,16}$/) }).safeParse(request.params);
    const query = z.object({ range: z.enum(["24h", "7d", "30d", "90d", "all"]).default("30d") }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Некорректные параметры" });

    const points = await ymHistory(params.data.sku, RANGES[query.data.range] ?? "30 days");
    const prices = points.map((p) => p.price).filter((p): p is number => p !== null);
    const [product] = await db.select().from(ymProducts).where(eq(ymProducts.sku, params.data.sku)).limit(1);

    return reply.send({
      sku: params.data.sku,
      product: product ?? null,
      points,
      stats: {
        count: points.length,
        min: prices.length > 0 ? Math.min(...prices) : null,
        max: prices.length > 0 ? Math.max(...prices) : null,
        current: points.at(-1)?.price ?? null,
      },
    });
  });

  /** Поиск по Маркету: чтобы товар можно было найти, а не только вставить номер. */
  app.get("/api/ym/search", async (request, reply) => {
    const query = z
      .object({ q: z.string().min(2).max(200), limit: z.coerce.number().int().min(1).max(24).default(12) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Введите запрос" });

    try {
      const items = await client.search(query.data.q, query.data.limit);
      return reply.send({ query: query.data.q, items });
    } catch (error) {
      if (error instanceof YmUnavailableError) {
        return reply.code(503).send({ error: error.message, degraded: true });
      }
      throw error;
    }
  });
}

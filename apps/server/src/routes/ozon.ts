import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { OzonUnavailableError, type OzonClient } from "@watcher/ozon-core";
import { db } from "../db/client.js";
import { ozonProducts } from "../db/schema.js";
import { requireAuth } from "../auth.js";
import { listOzonWatches, ozonHistory, removeOzonWatch, watchOzonProduct } from "../services/ozon.js";

const RANGES: Record<string, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "100 years",
};

const notConfigured =
  "Озон не подключён: на сервере не задан адрес агента (OZON_AGENT_URL). Площадка выключена.";

export async function ozonRoutes(app: FastifyInstance, client: OzonClient | null): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/ozon/watches", async (request, reply) => {
    return reply.send({ available: client !== null, watches: await listOzonWatches(request.user!.id) });
  });

  app.post("/api/ozon/watches", async (request, reply) => {
    if (!client) return reply.code(400).send({ error: notConfigured });
    const parsed = z
      .object({ product: z.string().min(5).max(300), intervalMin: z.coerce.number().int().min(30).max(1440).optional() })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Укажите номер товара Озона или ссылку на него" });
    }

    try {
      const result = await watchOzonProduct(client, {
        userId: request.user!.id,
        input: parsed.data.product,
        intervalMin: parsed.data.intervalMin,
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof OzonUnavailableError) {
        return reply.code(503).send({ error: error.message, degraded: true });
      }
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.delete("/api/ozon/watches/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный id" });
    const removed = await removeOzonWatch(request.user!.id, params.data.id);
    if (!removed) return reply.code(404).send({ error: "Подписка не найдена" });
    return reply.send({ ok: true });
  });

  app.get("/api/ozon/product/:sku/history", async (request, reply) => {
    const params = z.object({ sku: z.string().regex(/^\d{5,16}$/) }).safeParse(request.params);
    const query = z.object({ range: z.enum(["24h", "7d", "30d", "90d", "all"]).default("30d") }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Некорректные параметры" });

    const points = await ozonHistory(params.data.sku, RANGES[query.data.range] ?? "30 days");
    const prices = points.map((p) => p.price).filter((p): p is number => p !== null);
    const [product] = await db.select().from(ozonProducts).where(eq(ozonProducts.sku, params.data.sku)).limit(1);

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

  app.get("/api/ozon/search", async (request, reply) => {
    if (!client) return reply.code(400).send({ error: notConfigured });
    const query = z
      .object({ q: z.string().min(2).max(200), limit: z.coerce.number().int().min(1).max(24).default(12) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Введите запрос" });

    try {
      const items = await client.search(query.data.q, query.data.limit);
      return reply.send({ query: query.data.q, items });
    } catch (error) {
      if (error instanceof OzonUnavailableError) {
        return reply.code(503).send({ error: error.message, degraded: true });
      }
      throw error;
    }
  });
}

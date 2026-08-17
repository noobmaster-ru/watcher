import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { OzonNeedsHumanError, OzonUnavailableError, type OzonClient } from "@watcher/ozon-core";
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

  /**
   * Проверка для Caddy forward_auth перед окном браузера агента. Сюда доходят
   * только с валидной сессией (preHandler выше отбил бы 401), поэтому просто
   * подтверждаем: 204 = пускать.
   */
  app.get("/api/ozon/vnc-auth", async (_request, reply) => reply.code(204).send());

  /**
   * Состояние сессии браузера агента: живая, ждёт человека или браузер лежит.
   * Интерфейс по этому решает, показывать ли кнопку «пройти проверку».
   */
  app.get("/api/ozon/session", async (_request, reply) => {
    if (!client) return reply.send({ available: false, session: "down", lastTitle: notConfigured, lastCheckAt: null });
    const session = await client.session();
    return reply.send({
      available: true,
      session: session?.session ?? "down",
      lastTitle: session?.lastTitle ?? "",
      lastCheckAt: session?.lastCheckAt ?? null,
    });
  });

  /** Перепроверить сессию — после того, как человек прошёл капчу в окне. */
  app.post("/api/ozon/session/check", async (_request, reply) => {
    if (!client) return reply.code(400).send({ error: notConfigured });
    try {
      const status = await client.checkSession();
      return reply.send({ session: status?.session ?? "down", lastTitle: status?.lastTitle ?? "" });
    } catch (error) {
      return reply.code(503).send({ error: (error as Error).message });
    }
  });

  /** Скриншот окна браузера: что сейчас на экране у агента. */
  app.get("/api/ozon/session/screenshot", async (_request, reply) => {
    if (!client) return reply.code(400).send({ error: notConfigured });
    const png = await client.screenshot();
    if (!png) return reply.code(404).send({ error: "браузер агента не запущен" });
    return reply.header("cache-control", "no-store").type("image/png").send(png);
  });

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
      if (error instanceof OzonNeedsHumanError) {
        return reply.code(423).send({ error: error.message, needsHuman: true });
      }
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
      if (error instanceof OzonNeedsHumanError) {
        return reply.code(423).send({ error: error.message, needsHuman: true });
      }
      if (error instanceof OzonUnavailableError) {
        return reply.code(503).send({ error: error.message, degraded: true });
      }
      throw error;
    }
  });
}

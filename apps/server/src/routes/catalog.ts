// Чтение данных Wildberries: карточка, история, продавец, поиск.
//
// Все ручки, ходящие в WB, переводят WbUnavailableError в 503 с явным
// признаком degraded — интерфейс должен показать «WB нас притормаживает», а не
// «ничего не найдено».

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { WbUnavailableError, toNm, toSupplierId, type WbClient } from "@watcher/wb-core";
import { db } from "../db/client.js";
import { pricePoints, products, sellerProducts, sellers, watches } from "../db/schema.js";
import { applySnapshot, upsertProduct } from "../services/products.js";

const RANGES: Record<string, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "100 years",
};

/** Единая обёртка: лимит WB → 503 с флагом degraded. */
async function wbGuard<T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<T>) {
  try {
    return { ok: true as const, value: await fn() };
  } catch (error) {
    if (error instanceof WbUnavailableError) {
      reply.code(503).send({
        error: "Wildberries временно ограничивает запросы. Попробуйте через минуту.",
        degraded: true,
        retryAfterMs: error.retryAfterMs,
      });
      return { ok: false as const };
    }
    throw error;
  }
}

export async function catalogRoutes(app: FastifyInstance, wb: WbClient): Promise<void> {
  // ── карточка товара ────────────────────────────────────────────────────────
  app.get("/api/product/:nm", async (request, reply) => {
    const params = z.object({ nm: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Нужен артикул" });

    let nm: number;
    try {
      nm = toNm(params.data.nm);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const result = await wbGuard(reply, () => wb.fullProduct(nm, "interactive"));
    if (!result.ok) return;
    if (!result.value) return reply.code(404).send({ error: `Товар ${nm} не найден на Wildberries` });

    const product = result.value;
    // свежий снимок кладём в историю: пользователь открыл карточку — значит цена актуальна
    await upsertProduct(product);
    await applySnapshot(product, { scheduleNext: false });

    const [watch] = request.user
      ? await db
          .select({ id: watches.id })
          .from(watches)
          .where(and(eq(watches.userId, request.user.id), eq(watches.nm, nm), eq(watches.isActive, true)))
          .limit(1)
      : [];

    return reply.send({ product, watchId: watch?.id ?? null, degraded: wb.overallState() !== "ok" });
  });

  // ── история цен ────────────────────────────────────────────────────────────
  app.get("/api/product/:nm/history", async (request, reply) => {
    const params = z.object({ nm: z.string() }).safeParse(request.params);
    const query = z.object({ range: z.enum(["24h", "7d", "30d", "90d", "all"]).default("30d") }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Некорректные параметры" });

    const nm = toNm(params.data.nm);
    const interval = RANGES[query.data.range] ?? "30 days";

    const points = await db
      .select({
        checkedAt: pricePoints.checkedAt,
        price: pricePoints.price,
        basic: pricePoints.basic,
        inStock: pricePoints.inStock,
      })
      .from(pricePoints)
      .where(and(eq(pricePoints.nm, nm), gte(pricePoints.checkedAt, sql`now() - ${interval}::interval`)))
      .orderBy(asc(pricePoints.checkedAt));

    const prices = points.map((p) => p.price).filter((p): p is number => p !== null);
    return reply.send({
      nm,
      range: query.data.range,
      points,
      stats: {
        count: points.length,
        min: prices.length > 0 ? Math.min(...prices) : null,
        max: prices.length > 0 ? Math.max(...prices) : null,
        current: points.at(-1)?.price ?? null,
      },
    });
  });

  // ── продавец ───────────────────────────────────────────────────────────────
  app.get("/api/seller/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Нужен ID продавца" });

    let supplierId: number;
    try {
      supplierId = toSupplierId(params.data.id);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const result = await wbGuard(reply, () => wb.seller(supplierId, "interactive"));
    if (!result.ok) return;
    if (!result.value) return reply.code(404).send({ error: `Продавец ${supplierId} не найден` });

    await db
      .insert(sellers)
      .values({
        supplierId: result.value.supplierId,
        name: result.value.name,
        fullName: result.value.fullName,
        inn: result.value.inn,
        trademark: result.value.trademark,
      })
      .onConflictDoUpdate({
        target: sellers.supplierId,
        set: { name: result.value.name, fullName: result.value.fullName, inn: result.value.inn },
      });

    const [watch] = request.user
      ? await db
          .select({ id: watches.id })
          .from(watches)
          .where(
            and(eq(watches.userId, request.user.id), eq(watches.supplierId, supplierId), eq(watches.isActive, true)),
          )
          .limit(1)
      : [];

    return reply.send({ seller: result.value, watchId: watch?.id ?? null });
  });

  app.get("/api/seller/:id/products", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const query = z.object({ page: z.coerce.number().int().min(1).max(50).default(1) }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Некорректные параметры" });

    const supplierId = toSupplierId(params.data.id);
    const result = await wbGuard(reply, () => wb.sellerCatalogPage(supplierId, query.data.page, "interactive"));
    if (!result.ok) return;

    return reply.send({
      supplierId,
      page: query.data.page,
      total: result.value.total,
      products: result.value.products,
      degraded: wb.overallState() !== "ok",
    });
  });

  // ── поиск ──────────────────────────────────────────────────────────────────
  app.get("/api/search", async (request, reply) => {
    const query = z
      .object({ q: z.string().min(1, "Введите запрос"), limit: z.coerce.number().int().min(1).max(100).default(24) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues[0]?.message ?? "Некорректный запрос" });

    const result = await wbGuard(reply, () => wb.search(query.data.q, query.data.limit, "interactive"));
    if (!result.ok) return;

    return reply.send({ query: query.data.q, items: result.value, degraded: wb.overallState() !== "ok" });
  });

  // ── что уже есть в базе (быстрый ответ без похода в WB) ────────────────────
  app.get("/api/seller/:id/tracked", async (request, reply) => {
    const supplierId = toSupplierId(z.object({ id: z.string() }).parse(request.params).id);
    const rows = await db
      .select({
        nm: products.nm,
        name: products.name,
        lastPrice: products.lastPrice,
        lastInStock: products.lastInStock,
        lastCheckedAt: products.lastCheckedAt,
      })
      .from(sellerProducts)
      .innerJoin(products, eq(products.nm, sellerProducts.nm))
      .where(and(eq(sellerProducts.supplierId, supplierId), eq(sellerProducts.isActive, true)))
      .orderBy(desc(products.lastCheckedAt))
      .limit(500);
    return reply.send({ supplierId, products: rows });
  });
}

// Чтение данных Wildberries: карточка, история, продавец, поиск.
//
// Все ручки, ходящие в WB, переводят WbUnavailableError в 503 с явным
// признаком degraded — интерфейс должен показать «WB нас притормаживает», а не
// «ничего не найдено».

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { WbUnavailableError, looksLikeSlug, toNm, toSupplierId, type WbClient } from "@watcher/wb-core";
import { db } from "../db/client.js";
import { pricePoints, products, sellerProducts, sellers, watches } from "../db/schema.js";
import { applySnapshot, fanOutEvents, upsertProduct } from "../services/products.js";

const RANGES: Record<string, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "100 years",
};

/**
 * Разбор артикула или ID продавца. Парсеры бросают понятное сообщение, и его
 * нужно превратить в 400, а не дать всплыть до 500 с «Internal Server Error».
 */
function parseId<T>(raw: string, parse: (value: string) => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: parse(raw) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Единая обёртка: лимит WB → 503 с флагом degraded. */
async function wbGuard<T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<T>) {
  try {
    return { ok: true as const, value: await fn() };
  } catch (error) {
    if (error instanceof WbUnavailableError) {
      // Называем реальную паузу: у поиска она измеряется минутами, и обещание
      // «попробуйте через минуту» было бы обманом.
      const minutes = Math.ceil(error.retryAfterMs / 60_000);
      const wait = minutes <= 1 ? "меньше минуты" : `около ${minutes} мин`;
      reply.code(503).send({
        error: `Wildberries ограничивает запросы к ${error.host}. Ждать ${wait}.`,
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

    const parsedNm = parseId(params.data.nm, toNm);
    if (!parsedNm.ok) return reply.code(400).send({ error: parsedNm.error });
    const nm = parsedNm.value;

    const result = await wbGuard(reply, () => wb.fullProduct(nm, "interactive"));
    if (!result.ok) return;
    if (!result.value) return reply.code(404).send({ error: `Товар ${nm} не найден на Wildberries` });

    const product = result.value;
    // Свежий снимок кладём в историю: пользователь открыл карточку — значит цена
    // актуальна. События при этом обязаны уйти подписчикам: applySnapshot уже
    // сдвинул lastPrice, и обход планировщика разницы больше не увидит.
    await upsertProduct(product);
    const events = await applySnapshot(product, { scheduleNext: false });
    if (events.length > 0) await fanOutEvents(events);

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

    const parsedNm = parseId(params.data.nm, toNm);
    if (!parsedNm.ok) return reply.code(400).send({ error: parsedNm.error });
    const nm = parsedNm.value;
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

  /**
   * Превращает то, что вставил пользователь, в ID продавца.
   *
   * Принимает: число, ссылку /seller/809881, ссылку /seller/shampur-yug с
   * буквенным адресом и ссылку на любой товар продавца. Последнее — самый
   * надёжный путь: артикул даёт продавца точно, без догадок. Буквенный адрес
   * ищется поиском и подтверждается обратной свёрткой имени; если уверенного
   * совпадения нет, возвращается список кандидатов, а выбор остаётся за
   * пользователем.
   */
  app.get("/api/seller/resolve", async (request, reply) => {
    const query = z.object({ input: z.string().min(1).max(300) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Укажите ID, ссылку на продавца или на его товар" });

    const raw = query.data.input.trim();
    const sellerLink = raw.match(/seller\/([^/?#]+)/i);
    const productLink = /catalog\/(\d+)/i.test(raw);
    const token = (sellerLink?.[1] ?? raw).trim();

    // 1. Ссылка на товар — продавец берётся из карточки, без поиска и догадок
    if (productLink || (!sellerLink && /^\d{7,}$/.test(token))) {
      const result = await wbGuard(reply, () => wb.detail(toNm(raw), "interactive"));
      if (!result.ok) return;
      if (result.value?.supplierId) {
        return reply.send({
          supplierId: result.value.supplierId,
          name: result.value.supplier,
          source: "product",
          productName: result.value.name,
        });
      }
      // не товар — пробуем дальше как ID продавца
    }

    // 2. Число — это ID продавца
    if (/^\d+$/.test(token)) {
      const result = await wbGuard(reply, () => wb.seller(Number(token), "interactive"));
      if (!result.ok) return;
      if (result.value) {
        return reply.send({ supplierId: result.value.supplierId, name: result.value.name, source: "id" });
      }
      return reply.code(404).send({ error: `Продавец ${token} не найден на Wildberries` });
    }

    // 3. Буквенный адрес — поиск с подтверждением
    if (!looksLikeSlug(token)) {
      return reply.code(400).send({ error: "Не похоже ни на ID продавца, ни на ссылку" });
    }

    const result = await wbGuard(reply, () => wb.resolveSellerBySlug(token, "interactive"));
    if (!result.ok) return;

    if (result.value.exact) {
      return reply.send({ ...result.value.exact, source: "slug", query: result.value.query });
    }
    if (result.value.candidates.length > 0) {
      return reply.send({
        supplierId: null,
        source: "slug",
        query: result.value.query,
        candidates: result.value.candidates.slice(0, 8),
      });
    }
    return reply.code(404).send({
      error:
        `По адресу «${token}» продавец не найден. Откройте любой его товар и вставьте ссылку на товар — ` +
        `так продавец определится точно.`,
    });
  });

  // ── продавец ───────────────────────────────────────────────────────────────
  app.get("/api/seller/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Нужен ID продавца" });

    const parsedSeller = parseId(params.data.id, toSupplierId);
    if (!parsedSeller.ok) return reply.code(400).send({ error: parsedSeller.error });
    const supplierId = parsedSeller.value;

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

    const parsedSeller = parseId(params.data.id, toSupplierId);
    if (!parsedSeller.ok) return reply.code(400).send({ error: parsedSeller.error });
    const supplierId = parsedSeller.value;

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
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Нужен ID продавца" });
    const parsedSeller = parseId(params.data.id, toSupplierId);
    if (!parsedSeller.ok) return reply.code(400).send({ error: parsedSeller.error });
    const supplierId = parsedSeller.value;
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

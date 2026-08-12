import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { WbUnavailableError, imageUrl, toNm, toSupplierId, type WbClient } from "@watcher/wb-core";
import { db } from "../db/client.js";
import { watches } from "../db/schema.js";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { affectedProducts, listWatches, removeWatch, watchProduct, watchSeller } from "../services/watches.js";
import { refreshTracking, untrackOrphans } from "../services/products.js";

const rules = z.object({
  intervalMin: z.coerce.number().int().min(config.limits.minIntervalMin).max(config.limits.maxIntervalMin).optional(),
  minChangePct: z.coerce.number().min(0).max(100).optional(),
  minChangeAbs: z.coerce.number().int().min(0).optional(),
  onDrop: z.boolean().optional(),
  onRise: z.boolean().optional(),
  onStockChange: z.boolean().optional(),
  onNewProduct: z.boolean().optional(),
  notifyTelegram: z.boolean().optional(),
});

const createSchema = z.discriminatedUnion("kind", [
  rules.extend({ kind: z.literal("product"), product: z.string().min(1) }),
  rules.extend({ kind: z.literal("seller"), seller: z.string().min(1) }),
]);

export async function watchRoutes(app: FastifyInstance, wb: WbClient): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/watches", async (request, reply) => {
    const rows = await listWatches(request.user!.id);
    // Шард CDN с картинкой выбирается по таблице из 46 хостов — считать его
    // должен сервер, у клиента этой таблицы нет.
    return reply.send({
      watches: rows.map((row) => ({
        ...row,
        image: row.nm != null ? imageUrl(Number(row.nm)) : null,
      })),
    });
  });

  app.post("/api/watches", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Некорректные данные" });
    }
    const userId = request.user!.id;

    try {
      if (parsed.data.kind === "product") {
        const nm = toNm(parsed.data.product);
        const watchId = await watchProduct(wb, { ...parsed.data, userId, kind: "product", nm });
        return reply.send({ watchId, kind: "product", nm });
      }

      const supplierId = toSupplierId(parsed.data.seller);
      const result = await watchSeller(wb, { ...parsed.data, userId, kind: "seller", supplierId });
      return reply.send({ ...result, kind: "seller", supplierId });
    } catch (error) {
      if (error instanceof WbUnavailableError) {
        return reply.code(503).send({
          error: "Wildberries временно ограничивает запросы. Попробуйте через минуту.",
          degraded: true,
        });
      }
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.patch("/api/watches/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).safeParse(request.params);
    const body = rules.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Некорректные данные" });

    // Все поля необязательные, поэтому пустое тело проходит проверку, но drizzle
    // на пустом set падает. Отвечаем понятной ошибкой вместо 500.
    if (Object.keys(body.data).length === 0) {
      return reply.code(400).send({ error: "Не указано ни одного поля для изменения" });
    }

    const [row] = await db
      .update(watches)
      .set(body.data)
      .where(and(eq(watches.id, params.data.id), eq(watches.userId, request.user!.id)))
      .returning({ id: watches.id, nm: watches.nm, kind: watches.kind, supplierId: watches.supplierId });
    if (!row) return reply.code(404).send({ error: "Подписка не найдена" });

    // Интервал мог измениться. У подписки на продавца nm пустой, поэтому темп
    // пересчитываем по всем товарам его каталога, иначе правка ничего не меняла бы.
    const affected = await affectedProducts(row);
    if (affected.length > 0) await refreshTracking(affected);
    return reply.send({ ok: true });
  });

  app.delete("/api/watches/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный id" });

    const removed = await removeWatch(request.user!.id, params.data.id);
    if (!removed) return reply.code(404).send({ error: "Подписка не найдена" });
    await untrackOrphans();
    return reply.send({ ok: true });
  });
}

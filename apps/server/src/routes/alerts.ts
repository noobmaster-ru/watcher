import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { alerts, products } from "../db/schema.js";
import { requireAuth } from "../auth.js";

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/alerts", async (request, reply) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        unreadOnly: z.coerce.boolean().default(false),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Некорректные параметры" });

    const userId = request.user!.id;
    const rows = await db
      .select({
        id: alerts.id,
        nm: alerts.nm,
        type: alerts.type,
        oldPrice: alerts.oldPrice,
        newPrice: alerts.newPrice,
        createdAt: alerts.createdAt,
        readAt: alerts.readAt,
        name: products.name,
        brand: products.brand,
        supplierName: products.supplierName,
      })
      .from(alerts)
      .leftJoin(products, eq(products.nm, alerts.nm))
      .where(
        query.data.unreadOnly
          ? and(eq(alerts.userId, userId), isNull(alerts.readAt))
          : eq(alerts.userId, userId),
      )
      .orderBy(desc(alerts.createdAt))
      .limit(query.data.limit);

    const [unread] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(alerts)
      .where(and(eq(alerts.userId, userId), isNull(alerts.readAt)));

    return reply.send({ alerts: rows, unread: unread?.count ?? 0 });
  });

  app.post("/api/alerts/read", async (request, reply) => {
    const body = z.object({ ids: z.array(z.number()).optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Некорректные данные" });

    const userId = request.user!.id;
    const ids = body.data.ids;
    await db
      .update(alerts)
      .set({ readAt: new Date() })
      .where(
        ids && ids.length > 0
          ? and(eq(alerts.userId, userId), inArray(alerts.id, ids))
          : and(eq(alerts.userId, userId), isNull(alerts.readAt)),
      );
    return reply.send({ ok: true });
  });
}

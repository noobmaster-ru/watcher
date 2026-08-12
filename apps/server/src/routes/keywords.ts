import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { WbUnavailableError, type WbClient } from "@watcher/wb-core";
import { db } from "../db/client.js";
import { keywords } from "../db/schema.js";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { checkKeyword, keywordHistory, listKeywords } from "../services/keywords.js";

const settings = z.object({
  maxPages: z.coerce.number().int().min(1).max(3).optional(),
  intervalMin: z.coerce
    .number()
    .int()
    .min(config.limits.minKeywordIntervalMin)
    .max(config.limits.maxKeywordIntervalMin)
    .optional(),
  isActive: z.boolean().optional(),
});

export async function keywordRoutes(app: FastifyInstance, wb: WbClient): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/keywords", async (request, reply) => {
    return reply.send({ keywords: await listKeywords(request.user!.id) });
  });

  app.post("/api/keywords", async (request, reply) => {
    const parsed = settings.extend({ phrase: z.string().min(2).max(200) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Некорректные данные" });
    }

    const phrase = parsed.data.phrase.trim().toLowerCase();
    const [row] = await db
      .insert(keywords)
      .values({
        userId: request.user!.id,
        phrase,
        maxPages: parsed.data.maxPages ?? 3,
        intervalMin: parsed.data.intervalMin ?? 360,
      })
      .onConflictDoUpdate({
        target: [keywords.userId, keywords.phrase],
        set: { isActive: true, nextCheckAt: new Date() },
      })
      .returning({ id: keywords.id });
    if (!row) return reply.code(500).send({ error: "Не удалось сохранить запрос" });

    // первую проверку делаем сразу: иначе список стоит пустым до ближайшего цикла
    try {
      const result = await checkKeyword(wb, {
        id: row.id,
        userId: request.user!.id,
        phrase,
        maxPages: parsed.data.maxPages ?? 3,
        intervalMin: parsed.data.intervalMin ?? 360,
      });
      return reply.send({ id: row.id, ...result });
    } catch (error) {
      if (error instanceof WbUnavailableError) {
        return reply.send({
          id: row.id,
          phrase,
          scanned: 0,
          found: 0,
          dropped: 0,
          degraded: true,
          note: "Wildberries сейчас ограничивает поиск — позиции появятся при следующей проверке",
        });
      }
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.patch("/api/keywords/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).safeParse(request.params);
    const body = settings.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Некорректные данные" });
    if (Object.keys(body.data).length === 0) {
      return reply.code(400).send({ error: "Не указано ни одного поля для изменения" });
    }

    const [row] = await db
      .update(keywords)
      .set(body.data)
      .where(and(eq(keywords.id, params.data.id), eq(keywords.userId, request.user!.id)))
      .returning({ id: keywords.id });
    if (!row) return reply.code(404).send({ error: "Ключевое слово не найдено" });
    return reply.send({ ok: true });
  });

  app.delete("/api/keywords/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный id" });

    const [row] = await db
      .delete(keywords)
      .where(and(eq(keywords.id, params.data.id), eq(keywords.userId, request.user!.id)))
      .returning({ id: keywords.id });
    if (!row) return reply.code(404).send({ error: "Ключевое слово не найдено" });
    return reply.send({ ok: true });
  });

  app.get("/api/keywords/:id/history", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный id" });

    const history = await keywordHistory(request.user!.id, params.data.id);
    if (history === null) return reply.code(404).send({ error: "Ключевое слово не найдено" });
    return reply.send({ history });
  });
}

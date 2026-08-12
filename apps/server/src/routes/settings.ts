import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userChannels } from "../db/schema.js";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { createBindLink, handleUpdate, isTelegramEnabled, unbindTelegram } from "../services/telegram.js";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", { preHandler: requireAuth }, async (request, reply) => {
    const [channel] = await db
      .select()
      .from(userChannels)
      .where(eq(userChannels.userId, request.user!.id))
      .limit(1);

    return reply.send({
      telegram: {
        available: isTelegramEnabled(),
        connected: Boolean(channel?.telegramChatId && channel.verifiedAt),
      },
      defaults: {
        intervalMin: config.scheduler.defaultIntervalMin,
        minIntervalMin: config.limits.minIntervalMin,
        maxIntervalMin: config.limits.maxIntervalMin,
      },
    });
  });

  app.post("/api/telegram/bind", { preHandler: requireAuth }, async (request, reply) => {
    if (!isTelegramEnabled()) {
      return reply.code(400).send({ error: "Telegram-бот не настроен: не задан TELEGRAM_BOT_TOKEN" });
    }
    const link = await createBindLink(request.user!.id);
    if (!link.url) return reply.code(502).send({ error: "Не удалось получить имя бота у Telegram" });
    return reply.send({ url: link.url });
  });

  app.post("/api/telegram/unbind", { preHandler: requireAuth }, async (request, reply) => {
    await unbindTelegram(request.user!.id);
    return reply.send({ ok: true });
  });

  // вебхук вызывается Telegram, не пользователем — авторизация здесь не нужна
  app.post("/api/telegram/webhook", async (request, reply) => {
    if (config.telegram.mode !== "webhook") return reply.code(404).send({ error: "Вебхук выключен" });
    try {
      await handleUpdate(request.body as never);
    } catch (error) {
      request.log.error({ err: error }, "telegram webhook");
    }
    return reply.send({ ok: true });
  });
}

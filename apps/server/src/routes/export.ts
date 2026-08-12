import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userSheets } from "../db/schema.js";
import { requireAuth } from "../auth.js";
import { exportUser } from "../services/export.js";
import { GoogleError, type GoogleApi } from "../services/google.js";

export async function exportRoutes(app: FastifyInstance, google: GoogleApi | null): Promise<void> {
  app.addHook("preHandler", requireAuth);

  /** Состояние выгрузки: ссылка на таблицу и когда обновлялась. */
  app.get("/api/sheet", async (request, reply) => {
    const [state] = await db.select().from(userSheets).where(eq(userSheets.userId, request.user!.id)).limit(1);
    return reply.send({
      available: google !== null,
      url: state?.spreadsheetUrl ?? null,
      lastExportAt: state?.lastExportAt ?? null,
      lastError: state?.lastError ?? null,
    });
  });

  /**
   * Создаёт таблицу, если её ещё нет, и дописывает всё новое. Ручку дёргает
   * кнопка «Гугл-таблица»: в первый раз таблицы ещё не существует, и ссылку
   * взять неоткуда, пока она не создана.
   */
  app.post("/api/sheet/export", async (request, reply) => {
    if (!google) {
      return reply.code(400).send({
        error:
          "Выгрузка не настроена: на сервере не задан GOOGLE_SERVICE_ACCOUNT. " +
          "Добавьте ключ сервисного аккаунта Google и перезапустите приложение.",
      });
    }

    try {
      const result = await exportUser(google, request.user!.id);
      return reply.send(result);
    } catch (error) {
      if (error instanceof GoogleError) {
        return reply.code(502).send({ error: `Google отказал: ${error.message}` });
      }
      return reply.code(500).send({ error: (error as Error).message });
    }
  });
}

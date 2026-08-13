import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userSheets, type Marketplace } from "../db/schema.js";
import { requireAuth } from "../auth.js";
import { z } from "zod";
import { SheetNotLinkedError, exportUser, linkSpreadsheet } from "../services/export.js";
import { exportYm } from "../services/ym-export.js";
import { GoogleError, type GoogleApi } from "../services/google.js";

const notConfigured =
  "Выгрузка не настроена: на сервере не задан ключ сервисного аккаунта Google (GOOGLE_SERVICE_ACCOUNT).";

export async function exportRoutes(app: FastifyInstance, google: GoogleApi | null): Promise<void> {
  app.addHook("preHandler", requireAuth);

  /**
   * Состояние выгрузки по обеим площадкам сразу: у каждой своя таблица, и в
   * шапке нужно показать обе кнопки одним запросом.
   */
  app.get("/api/sheet", async (request, reply) => {
    const rows = await db.select().from(userSheets).where(eq(userSheets.userId, request.user!.id));
    const byMarketplace = (marketplace: Marketplace) => {
      const state = rows.find((row) => row.marketplace === marketplace);
      return {
        url: state?.spreadsheetUrl ?? null,
        lastExportAt: state?.lastExportAt ?? null,
        lastError: state?.lastError ?? null,
      };
    };
    return reply.send({
      available: google !== null,
      // адрес, которому пользователь открывает доступ к своей таблице
      serviceAccountEmail: google?.email ?? null,
      wb: byMarketplace("wb"),
      ym: byMarketplace("ym"),
      // прежние поля — чтобы не ломать уже открытые вкладки со старым интерфейсом
      ...byMarketplace("wb"),
    });
  });

  /** Подключение таблицы, созданной пользователем. */
  app.post("/api/sheet/link", async (request, reply) => {
    if (!google) return reply.code(400).send({ error: notConfigured });

    const parsed = z
      .object({
        url: z.string().min(10).max(500),
        marketplace: z.enum(["wb", "ym"]).default("wb"),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Вставьте ссылку на Гугл-таблицу" });

    try {
      const result = await linkSpreadsheet(google, request.user!.id, parsed.data.url, parsed.data.marketplace);
      return reply.send(result);
    } catch (error) {
      if (error instanceof GoogleError) {
        const hint =
          error.status === 403 || error.status === 404
            ? ` Проверьте, что доступ на редактирование выдан для ${google.email}.`
            : "";
        return reply.code(400).send({ error: `Google отказал: ${error.message}.${hint}` });
      }
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  /**
   * Создаёт таблицу, если её ещё нет, и дописывает всё новое. Ручку дёргает
   * кнопка «Гугл-таблица»: в первый раз таблицы ещё не существует, и ссылку
   * взять неоткуда, пока она не создана.
   */
  app.post("/api/sheet/export", async (request, reply) => {
    if (!google) return reply.code(400).send({ error: notConfigured });
    const body = z.object({ marketplace: z.enum(["wb", "ym"]).default("wb") }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Некорректная площадка" });

    try {
      const result =
        body.data.marketplace === "ym"
          ? await exportYm(google, request.user!.id)
          : await exportUser(google, request.user!.id);
      return reply.send(result);
    } catch (error) {
      if (error instanceof SheetNotLinkedError) {
        return reply.code(409).send({ error: error.message, needsLink: true });
      }
      if (error instanceof GoogleError) {
        return reply.code(502).send({ error: `Google отказал: ${error.message}` });
      }
      return reply.code(500).send({ error: (error as Error).message });
    }
  });
}

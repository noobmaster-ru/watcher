import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { WbClient } from "@watcher/wb-core";
import { db } from "../db/client.js";
import { isTelegramEnabled } from "../services/telegram.js";

/**
 * Здоровье приложения. Отдельно показывает состояние каждого хоста WB: пустая
 * выдача из-за лимита и поломка сервиса выглядят в интерфейсе одинаково, если
 * не различить их здесь.
 */
export async function healthRoutes(app: FastifyInstance, wb: WbClient): Promise<void> {
  app.get("/api/health", async (_request, reply) => {
    let database: "ok" | "down" = "ok";
    try {
      await db.execute(sql`select 1`);
    } catch {
      database = "down";
    }

    const hosts = wb.hostStatuses();
    return reply.code(database === "ok" ? 200 : 503).send({
      database,
      wb: { state: wb.overallState(), hosts },
      telegram: isTelegramEnabled() ? "on" : "off",
      time: new Date().toISOString(),
    });
  });
}

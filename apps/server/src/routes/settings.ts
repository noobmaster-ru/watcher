import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", { preHandler: requireAuth }, async (_request, reply) => {
    return reply.send({
      defaults: {
        intervalMin: config.scheduler.defaultIntervalMin,
        minIntervalMin: config.limits.minIntervalMin,
        maxIntervalMin: config.limits.maxIntervalMin,
      },
    });
  });
}

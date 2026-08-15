import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { WbClient } from "@watcher/wb-core";
import { YmClient } from "@watcher/ym-core";
import { OzonClient } from "@watcher/ozon-core";
import { GoogleSheetsApi, loadServiceAccount, type GoogleApi } from "./services/google.js";
import { config } from "./config.js";
import { loadUser } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { catalogRoutes } from "./routes/catalog.js";
import { watchRoutes } from "./routes/watches.js";
import { alertRoutes } from "./routes/alerts.js";
import { settingsRoutes } from "./routes/settings.js";
import { keywordRoutes } from "./routes/keywords.js";
import { ymRoutes } from "./routes/ym.js";
import { ozonRoutes } from "./routes/ozon.js";
import { exportRoutes } from "./routes/export.js";

export interface App {
  server: FastifyInstance;
  wb: WbClient;
  ym: YmClient;
  /** null, когда агент не настроен: площадка выключена. */
  ozon: OzonClient | null;
  /** null, когда ключ сервисного аккаунта не задан: выгрузка просто выключена. */
  google: GoogleApi | null;
}

export interface BuildOptions {
  /** Готовый клиент WB. Тесты подставляют сюда подставной, чтобы не ходить в сеть. */
  wb?: WbClient;
  /** Готовый клиент Google. Тесты подставляют подставной вместо настоящего API. */
  google?: GoogleApi | null;
  /** Готовый клиент Яндекс Маркета. */
  ym?: YmClient;
  /** Готовый клиент Озона. */
  ozon?: OzonClient | null;
}

export async function buildApp(options: BuildOptions = {}): Promise<App> {
  const server = Fastify({
    logger: config.isProduction ? true : { transport: undefined, level: "warn" },
    trustProxy: true,
  });

  // один клиент WB на процесс: в нём живут очереди и предохранители, и делить
  // их между запросами обязательно — иначе лимиты считаются вразнобой
  const wb =
    options.wb ??
    new WbClient({
      dest: config.wb.dest,
      spp: config.wb.spp,
      proxy: config.wb.proxy,
      netInterface: config.wb.netInterface,
      log: (...args: unknown[]) => server.log.debug({ wb: args }),
    });

  // Fastify разбирает тело у любого запроса с content-type: application/json,
  // включая DELETE, и на пустом теле отвечает 400. Пустое тело при таком
  // заголовке — обычное дело у HTTP-клиентов, поэтому трактуем его как
  // отсутствие тела, а не как ошибку разбора.
  server.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const raw = typeof body === "string" ? body.trim() : "";
    if (raw.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch (error) {
      const failure = error as Error & { statusCode?: number };
      failure.statusCode = 400;
      done(failure);
    }
  });

  const ym =
    options.ym ??
    new YmClient({ proxy: config.wb.proxy, log: (...args: unknown[]) => server.log.debug({ ym: args }) });

  const ozon =
    options.ozon !== undefined
      ? options.ozon
      : config.ozonAgentUrl
        ? new OzonClient(config.ozonAgentUrl)
        : null;

  const account = loadServiceAccount(config.google.serviceAccount);
  const google = options.google !== undefined ? options.google : account ? new GoogleSheetsApi(account) : null;

  await server.register(cookie, { secret: config.sessionSecret });

  server.decorateRequest("user", null);
  server.addHook("preHandler", loadUser);

  await server.register(async (instance) => healthRoutes(instance, wb));
  await server.register(authRoutes);
  await server.register(async (instance) => catalogRoutes(instance, wb));
  await server.register(async (instance) => watchRoutes(instance, wb));
  await server.register(alertRoutes);
  await server.register(async (instance) => keywordRoutes(instance, wb));
  await server.register(async (instance) => ymRoutes(instance, ym));
  await server.register(async (instance) => ozonRoutes(instance, ozon));
  await server.register(async (instance) => exportRoutes(instance, google));
  await server.register(settingsRoutes);

  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Метод не найден" });
    // остальное отдаёт Caddy (статика SPA); сюда запрос долетает только в разработке
    return reply.code(404).send({ error: "Not found" });
  });

  return { server, wb, ym, ozon, google };
}

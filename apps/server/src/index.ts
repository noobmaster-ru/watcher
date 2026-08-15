// Точка входа: HTTP-сервер и планировщик в одном процессе.
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db/client.js";
import { Scheduler } from "./scheduler/index.js";

const { server, wb, ym, ozon, google } = await buildApp();
const scheduler = new Scheduler(wb, google, ym, ozon);

await server.listen({ port: config.port, host: config.host });
console.error(`[watcher] слушает http://${config.host}:${config.port}`);

if (!config.cookieSecure) {
  console.error(
    "[watcher] ВНИМАНИЕ: сайт отдаётся по HTTP — пароли и куки идут открытым текстом. " +
      "Для боевой эксплуатации укажите домен в SITE_ADDRESS и https в PUBLIC_URL.",
  );
}

scheduler.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[watcher] ${signal}: останавливаюсь`);
  await scheduler.stop();
  await server.close();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

import { resolve } from "node:path";
import type { Config } from "drizzle-kit";

// Пути считаем от корня пакета, а не от cwd: команду запускают и из корня
// монорепо, и из apps/server, и из контейнера. drizzle-kit собирает конфиг
// в CJS, поэтому import.meta здесь недоступен — берём путь через process.
const here = process.env.SERVER_DIR ?? resolve(process.cwd(), process.cwd().endsWith("apps/server") ? "." : "apps/server");

export default {
  schema: resolve(here, "src/db/schema.ts"),
  out: resolve(here, "drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://watcher:watcher@localhost:5432/watcher",
  },
} satisfies Config;

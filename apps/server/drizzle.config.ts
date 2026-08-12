import type { Config } from "drizzle-kit";

// Пути относительные: drizzle-kit склеивает их с cwd, и абсолютный out ломает
// чтение снапшотов. Запускать командой `npm run db:generate -w @watcher/server`
// — она сама переходит в каталог пакета.
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://watcher:watcher@localhost:5432/watcher",
  },
} satisfies Config;

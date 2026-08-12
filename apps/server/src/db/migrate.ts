// Применение миграций. Запускается отдельной командой перед стартом сервера:
//   npm run db:migrate
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const sql = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder });
  console.log(`Миграции применены (${migrationsFolder})`);
} finally {
  await sql.end();
}

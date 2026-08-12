// Подключение к БД.
//
// Соединение поднимается лениво, при первом обращении, и прячется за прокси.
// Это даёт две вещи: импорт модуля ничего не открывает (важно для тестов и для
// команд вроде миграций), а тесты могут подменить драйвер на встроенный PGlite
// и прогонять настоящий Postgres без контейнеров. Продакшен при этом идёт по
// обычному пути postgres-js и о подмене ничего не знает.

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

let connection: postgres.Sql | null = null;
let active: Db | null = null;

function connect(): Db {
  if (active) return active;
  connection = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });
  active = drizzle(connection, { schema });
  return active;
}

/** Подменяет драйвер (используется тестами с PGlite). */
export function setDb(instance: Db): void {
  active = instance;
}

export async function closeDb(): Promise<void> {
  if (connection) {
    await connection.end({ timeout: 5 });
    connection = null;
  }
  active = null;
}

/**
 * Прокси, чтобы вызовы вида `db.select()` работали одинаково и с postgres-js,
 * и с подменённым в тестах драйвером, без изменения кода сервисов.
 */
export const db = new Proxy({} as Db, {
  get(_target, property, receiver) {
    const instance = connect() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(instance, property, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

/**
 * Приводит результат db.execute к массиву строк. Драйверы расходятся: postgres-js
 * отдаёт массив, pglite — объект с полем rows. Сырой SQL есть в планировщике и в
 * выборке подписок, и он должен работать одинаково на обоих.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export { schema };

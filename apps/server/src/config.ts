// Конфигурация из окружения. Читается один раз при старте; всё, что нужно
// приложению, валидируется здесь, чтобы падать на старте, а не в рантайме.

function str(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Не задана переменная окружения ${name}`);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} должно быть числом, получено «${raw}»`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

const sessionSecret = str("SESSION_SECRET", "dev-secret-change-me");
if (process.env.NODE_ENV === "production" && sessionSecret === "dev-secret-change-me") {
  throw new Error("В продакшене SESSION_SECRET обязателен: openssl rand -hex 32");
}

export const config = {
  databaseUrl: str("DATABASE_URL", "postgres://watcher:watcher@localhost:5432/watcher"),
  port: num("PORT", 3000),
  host: str("HOST", "0.0.0.0"),
  publicUrl: str("PUBLIC_URL", "http://localhost:3000").replace(/\/+$/, ""),
  sessionSecret,
  allowRegistration: bool("ALLOW_REGISTRATION", true),
  isProduction: process.env.NODE_ENV === "production",

  /**
   * Помечать ли куку сессии флагом Secure. Ориентир — реальная схема PUBLIC_URL,
   * а не NODE_ENV: боевой стенд может отдаваться по HTTP (свой порт, чужой прокси
   * впереди), и тогда Secure-кука молча ломает вход — браузер её не отправляет и
   * даже не сохраняет, а пользователь видит бесконечную форму логина.
   */
  cookieSecure: process.env.COOKIE_SECURE?.trim()
    ? bool("COOKIE_SECURE", false)
    : str("PUBLIC_URL", "http://localhost:3000").startsWith("https://"),

  wb: {
    dest: str("WB_DEST", "-1257786"),
    spp: str("WB_SPP", "30"),
    proxy: process.env.WB_PROXY?.trim() || undefined,
    netInterface: process.env.WB_INTERFACE?.trim() || undefined,
  },

  scheduler: {
    enabled: bool("SCHEDULER_ENABLED", true),
    defaultIntervalMin: num("DEFAULT_CHECK_INTERVAL_MIN", 60),
    sellerSyncIntervalHours: num("SELLER_SYNC_INTERVAL_HOURS", 12),
    /** Пауза между тиками цикла цен. */
    tickMs: num("SCHEDULER_TICK_MS", 20_000),
  },


  /** Адрес агента Озона в docker-сети. Пусто — площадка выключена. */
  ozonAgentUrl: process.env.OZON_AGENT_URL?.trim() || undefined,

  google: {
    /** JSON сервисного аккаунта целиком либо путь к файлу с ним. */
    serviceAccount: process.env.GOOGLE_SERVICE_ACCOUNT?.trim() || undefined,
    /** Как часто дописывать данные в таблицы, минут. */
    exportIntervalMin: num("SHEETS_EXPORT_INTERVAL_MIN", 60),
  },

  /** Минимальный и максимальный интервал проверки, который можно выставить в интерфейсе. */
  limits: {
    minIntervalMin: 15,
    maxIntervalMin: 24 * 60,
    /** Потолок товаров, которые тянем из каталога одного продавца. */
    maxSellerProducts: 5000,
    /** Границы интервала проверки позиций по ключевым словам, минут. */
    minKeywordIntervalMin: 60,
    maxKeywordIntervalMin: 24 * 60,
  },
} as const;

export type Config = typeof config;

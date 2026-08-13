// HTTP-клиент Яндекс Маркета.
//
// Запросы идут встроенным fetch, а не системным curl — и это ровно наоборот по
// сравнению с клиентом Wildberries. Причина в фильтрации по TLS-отпечатку, и
// площадки фильтруют в разные стороны: card.wb.ru отбивает fetch и пропускает
// curl, а Маркет отбивает curl из образа (Debian bookworm, версия 7.88) капчей
// «Вы не робот?» и спокойно пропускает fetch. Проверено на боевом сервере:
// один и тот же запрос даёт 13 КБ капчи через curl и 1.5 МБ страницы через
// fetch. Заменить fetch на curl здесь — сломать сбор цен целиком.
//
// Жёстких лимитов у Маркета не замечено: пять запросов подряд прошли без
// единого отказа, поэтому достаточно скромной паузы и обычных ретраев.
//
// Прокси тут не поддержан намеренно: fetch умеет его только через ProxyAgent из
// undici, отдельной зависимости. Приложение живёт на российском сервере, где
// прокси не нужен; если понадобится — придётся её добавить.

import { YmHttpError, YmUnavailableError, type YmConfig } from "./types.js";

/** Заголовки настоящего браузера: без них Маркет отдаёт заглушку антибота. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Пауза между запросами. С запасом: Маркет терпит и более частые. */
const GAP_MS = 1500;
const MAX_RETRIES = 2;
/** После стольких отказов подряд хост считается закрытым. */
const TRIP_AFTER_FAILURES = 3;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(() => resolve(), ms));

export class YmTransport {
  private readonly log: (...args: unknown[]) => void;
  private gate: Promise<void> = Promise.resolve();
  private failures = 0;
  private blockedUntil = 0;
  private lastStatus: number | null = null;

  constructor(config: YmConfig = {}) {
    this.log = config.log ?? ((...args: unknown[]) => console.error("[ym]", ...args));
  }

  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - Date.now());
  }

  status(): { host: string; state: "ok" | "degraded"; lastStatus: number | null; blockedForMs: number } {
    return {
      host: "market.yandex.ru",
      state: this.failures >= TRIP_AFTER_FAILURES || this.blockedForMs() > 0 ? "degraded" : "ok",
      lastStatus: this.lastStatus,
      blockedForMs: this.blockedForMs(),
    };
  }

  /** Запросы выстраиваются в очередь с паузой: параллельных обращений не бывает. */
  private throttle(): Promise<void> {
    const next = this.gate.then(() => sleep(GAP_MS));
    this.gate = next;
    return next;
  }

  private async request(url: string, timeoutSec: number): Promise<{ status: number; body: string }> {
    const abort = AbortSignal.timeout(timeoutSec * 1000);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: abort,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ru-RU,ru;q=0.9",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1",
        },
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      // сетевой сбой или таймаут: обрабатывается как повторяемый, статусом 0
      this.log("сетевая ошибка:", (error as Error).message);
      return { status: 0, body: "" };
    }
  }

  private noteFailure(status: number): void {
    this.failures += 1;
    this.lastStatus = status;
    if (this.failures >= TRIP_AFTER_FAILURES) {
      const over = this.failures - TRIP_AFTER_FAILURES;
      this.blockedUntil = Date.now() + Math.min(BASE_BACKOFF_MS * 2 ** over, MAX_BACKOFF_MS);
    }
  }

  private noteSuccess(status: number): void {
    this.failures = 0;
    this.lastStatus = status;
    this.blockedUntil = 0;
  }

  /** Забирает HTML страницы. 404 → null: товара нет, и это не ошибка. */
  async getHtml(url: string, timeoutSec = 25): Promise<string | null> {
    const blocked = this.blockedForMs();
    if (blocked > 0) throw new YmUnavailableError(blocked);

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(attempt * 1500 + Math.floor(Math.random() * 500));
      await this.throttle();
      try {
        const { status, body } = await this.request(url, timeoutSec);
        if (status === 404) {
          this.noteSuccess(status);
          return null;
        }
        if (status === 0 || status === 429 || status === 403 || status >= 500) {
          this.noteFailure(status);
          lastError = new YmHttpError(status, url);
          if (this.blockedForMs() > 0) throw new YmUnavailableError(this.blockedForMs());
          continue;
        }
        if (status < 200 || status >= 300) throw new YmHttpError(status, url);

        // Капча приходит с кодом 200, и без этой проверки приложение решило бы,
        // что товар просто пропал, и записало бы «нет в продаже».
        if (body.includes("Вы не робот") || body.includes("showcaptcha")) {
          this.noteFailure(429);
          lastError = new YmHttpError(429, url);
          if (this.blockedForMs() > 0) throw new YmUnavailableError(this.blockedForMs());
          continue;
        }

        this.noteSuccess(status);
        return body;
      } catch (error) {
        if (error instanceof YmUnavailableError) throw error;
        lastError = error;
      }
    }
    this.log("не удалось получить", url, (lastError as Error)?.message);
    throw lastError ?? new YmHttpError(0, url);
  }
}

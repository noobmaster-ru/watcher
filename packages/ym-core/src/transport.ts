// HTTP-клиент Яндекс Маркета.
//
// Здесь намеренно нет той машинерии, что в клиенте Wildberries: у Маркета не
// наблюдается ни жёстких лимитов, ни фильтрации по TLS-отпечатку — пять
// запросов подряд с московского сервера прошли без единого отказа. Поэтому
// достаточно скромной паузы между обращениями и обычных ретраев.
//
// Запросы всё равно идут через системный curl, а не fetch: так работает вся
// сетевая часть приложения, и прокси с таймаутами настраиваются единообразно.

import { execFile } from "node:child_process";
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
  private readonly proxy: string | undefined;
  private gate: Promise<void> = Promise.resolve();
  private failures = 0;
  private blockedUntil = 0;
  private lastStatus: number | null = null;

  constructor(config: YmConfig = {}) {
    this.log = config.log ?? ((...args: unknown[]) => console.error("[ym]", ...args));
    this.proxy = config.proxy || undefined;
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

  private curl(url: string, timeoutSec: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const args = [
        "-sSL", // Маркет любит перекидывать между зеркалами
        "--compressed",
        "--max-redirs",
        "5",
        "-m",
        String(timeoutSec),
        "-H",
        `User-Agent: ${UA}`,
        "-H",
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H",
        "Accept-Language: ru-RU,ru;q=0.9",
        "-H",
        "Sec-Fetch-Dest: document",
        "-H",
        "Sec-Fetch-Mode: navigate",
        "-H",
        "Sec-Fetch-Site: none",
        "-w",
        "\n%{http_code}",
      ];
      if (this.proxy) args.push("--proxy", this.proxy);
      args.push(url);

      execFile("curl", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        const i = stdout.lastIndexOf("\n");
        const status = Number.parseInt(stdout.slice(i + 1), 10);
        resolve({ status: Number.isNaN(status) ? 0 : status, body: stdout.slice(0, i) });
      });
    });
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
        const { status, body } = await this.curl(url, timeoutSec);
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

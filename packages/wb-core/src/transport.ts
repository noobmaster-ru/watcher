// HTTP-транспорт к публичному API Wildberries.
//
// ВАЖНО: запросы идут через системный curl, а не через fetch. Это не легаси —
// card.wb.ru фильтрует по TLS/HTTP-фингерпринту и отдаёт Node'овому undici 403,
// тогда как curl проходит. Замена curl на fetch ломает приложение целиком.
//
// Поверх транспорта три механизма, без которых WB банит IP:
//   1. Лимитер на каждый хост (у search.wb.ru лимиты жёстче, чем у CDN-корзин).
//   2. Приоритетная очередь: запрос живого пользователя обгоняет фоновый обход.
//   3. Предохранитель: после серии 429/403 хост закрывается на растущий таймаут,
//      и запросы к нему падают сразу, а не добивают лимит.

import { execFile } from "node:child_process";
import type { HostState, HostStatus, Priority, WbConfig } from "./types.js";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Минимальный интервал между запросами к хосту, мс. Подобрано по поведению WB.
 *
 * У поиска пауза на порядок больше остальных, и это не перестраховка: замер с
 * боевого сервера показал 429 на всех запросах подряд даже с паузой в пять
 * секунд, причём штраф держится и после прекращения нагрузки. Поиск WB терпит
 * редкие обращения, но не серии.
 */
const HOST_GAP_MS: Record<string, number> = {
  "search.wb.ru": 30_000,
  "catalog.wb.ru": 2000,
  "card.wb.ru": 500,
  "feedback-bt.wildberries.ru": 700,
  "static-basket-01.wbbasket.ru": 300,
};
const DEFAULT_GAP_MS = 500;

function gapFor(host: string): number {
  if (host in HOST_GAP_MS) return HOST_GAP_MS[host] as number;
  // basket-NN.wbbasket.ru и feedback-view-NN.wb.ru — обычные CDN, лимиты мягкие
  if (host.startsWith("basket-") || host.startsWith("feedback-view-")) return 300;
  return DEFAULT_GAP_MS;
}

/** Порог срабатывания предохранителя и потолок бэкоффа. */
const TRIP_AFTER_FAILURES = 3;
const BANNED_AFTER_FAILURES = 8;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Хосты, у которых штраф за превышение держится долго и наказывается сама
 * серия запросов, а не их общее число.
 *
 * Замер с боевого сервера: после нагрузки search.wb.ru отвечал 429 двенадцать
 * попыток подряд с паузой в минуту. Для таких хостов ретраи внутри одного
 * вызова вредны — это и есть та серия, за которую бьют, — поэтому попытка
 * всегда одна, а предохранитель закрывается с первого же отказа.
 */
const SLOW_RECOVERY_HOSTS = new Set(["search.wb.ru"]);
const SLOW_BASE_BACKOFF_MS = 5 * 60_000;
const SLOW_MAX_BACKOFF_MS = 60 * 60_000;
/** Сколько отказов терпим до закрытия хоста: у «медленных» — ни одного. */
const SLOW_TRIP_AFTER_FAILURES = 1;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** WB закрыл хост лимитом. Отдаётся сразу, без ожидания в очереди. */
export class WbUnavailableError extends Error {
  readonly host: string;
  readonly retryAfterMs: number;
  constructor(host: string, retryAfterMs: number) {
    super(`Wildberries limits requests to ${host}; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "WbUnavailableError";
    this.host = host;
    this.retryAfterMs = retryAfterMs;
  }
}

export class WbHttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = "WbHttpError";
    this.status = status;
  }
}

interface Waiter {
  resolve: () => void;
  priority: Priority;
}

/** Очередь к одному хосту: выдерживает паузу между запросами, вперёд пускает интерактивные. */
class HostQueue {
  readonly host: string;
  private readonly gapMs: number;
  private waiters: Waiter[] = [];
  private running = false;
  private lastStart = 0;

  // состояние предохранителя
  failures = 0;
  lastStatus: number | null = null;
  lastErrorAt: number | null = null;
  lastOkAt: number | null = null;
  blockedUntil = 0;

  constructor(host: string) {
    this.host = host;
    this.gapMs = gapFor(host);
  }

  acquire(priority: Priority): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter: Waiter = { resolve, priority };
      if (priority === "interactive") {
        // встаём перед фоновыми, но за уже ожидающими интерактивными
        const firstBackground = this.waiters.findIndex((w) => w.priority === "background");
        if (firstBackground === -1) this.waiters.push(waiter);
        else this.waiters.splice(firstBackground, 0, waiter);
      } else {
        this.waiters.push(waiter);
      }
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.waiters.length > 0) {
        const wait = this.lastStart + this.gapMs - Date.now();
        if (wait > 0) await sleep(wait);
        const next = this.waiters.shift();
        if (!next) break;
        this.lastStart = Date.now();
        next.resolve();
      }
    } finally {
      this.running = false;
    }
  }

  /** Сколько ещё хост закрыт. 0 — открыт. */
  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - Date.now());
  }

  noteSuccess(status: number): void {
    this.failures = 0;
    this.lastStatus = status;
    this.lastOkAt = Date.now();
    this.blockedUntil = 0;
  }

  noteFailure(status: number | null): void {
    this.failures += 1;
    this.lastStatus = status;
    this.lastErrorAt = Date.now();
    const slow = SLOW_RECOVERY_HOSTS.has(this.host);
    const trip = slow ? SLOW_TRIP_AFTER_FAILURES : TRIP_AFTER_FAILURES;
    if (this.failures >= trip) {
      const base = slow ? SLOW_BASE_BACKOFF_MS : BASE_BACKOFF_MS;
      const max = slow ? SLOW_MAX_BACKOFF_MS : MAX_BACKOFF_MS;
      const over = this.failures - trip;
      this.blockedUntil = Date.now() + Math.min(base * 2 ** over, max);
    }
  }

  get state(): HostState {
    if (this.failures >= BANNED_AFTER_FAILURES) return "banned";
    const trip = SLOW_RECOVERY_HOSTS.has(this.host) ? SLOW_TRIP_AFTER_FAILURES : TRIP_AFTER_FAILURES;
    if (this.failures >= trip || this.blockedForMs() > 0) return "degraded";
    return "ok";
  }

  status(): HostStatus {
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
    return {
      host: this.host,
      state: this.state,
      consecutiveFailures: this.failures,
      lastStatus: this.lastStatus,
      lastErrorAt: iso(this.lastErrorAt),
      lastOkAt: iso(this.lastOkAt),
      blockedUntil: this.blockedUntil > Date.now() ? new Date(this.blockedUntil).toISOString() : null,
    };
  }
}

export interface RequestOptions {
  priority?: Priority;
  /** Сколько раз повторить после 429/403/5xx. */
  retries?: number;
  /** Таймаут одной попытки, секунд. */
  timeoutSec?: number;
}

/** Клиент к WB: очереди и предохранители живут внутри одного экземпляра. */
export class WbTransport {
  private readonly queues = new Map<string, HostQueue>();
  private readonly log: (...args: unknown[]) => void;
  private readonly proxy: string | undefined;
  private readonly netInterface: string | undefined;

  constructor(config: Pick<WbConfig, "proxy" | "netInterface" | "log"> = {}) {
    this.log = config.log ?? ((...a: unknown[]) => console.error("[wb]", ...a));
    this.proxy = config.proxy || undefined;
    this.netInterface = config.netInterface || undefined;
  }

  private queueFor(host: string): HostQueue {
    let q = this.queues.get(host);
    if (!q) {
      q = new HostQueue(host);
      this.queues.set(host, q);
    }
    return q;
  }

  /** Состояние всех хостов, к которым ходили. Для /api/health. */
  hostStatuses(): HostStatus[] {
    return [...this.queues.values()].map((q) => q.status());
  }

  /** Худшее из состояний — им и раскрашивается баннер в интерфейсе. */
  overallState(): HostState {
    const states = [...this.queues.values()].map((q) => q.state);
    if (states.includes("banned")) return "banned";
    if (states.includes("degraded")) return "degraded";
    return "ok";
  }

  private curl(url: string, timeoutSec: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const args = [
        "-sS",
        "--compressed",
        "-m",
        String(timeoutSec),
        "-H",
        `User-Agent: ${UA}`,
        "-H",
        "Accept: application/json",
        "-w",
        "\n%{http_code}", // статус последней строкой
      ];
      if (this.proxy) args.push("--proxy", this.proxy);
      if (this.netInterface) args.push("--interface", this.netInterface);
      args.push(url);

      execFile("curl", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        const i = stdout.lastIndexOf("\n");
        const status = Number.parseInt(stdout.slice(i + 1), 10);
        // При сетевом сбое (таймаут, отказ соединения, DNS, TLS) curl всё равно
        // печатает шаблон -w, и http_code там равен 000. Это временная беда, а не
        // ответ сервера, поэтому наружу отдаём 0 и обрабатываем как повторяемую.
        resolve({ status: Number.isNaN(status) ? 0 : status, body: stdout.slice(0, i) });
      });
    });
  }

  /**
   * GET с разбором JSON. 404 → null (товара/продавца нет — это не ошибка).
   * 429/403/5xx → ретраи с джиттером, затем WbUnavailableError.
   */
  async getJson<T>(url: string, options: RequestOptions = {}): Promise<T | null> {
    const { priority = "interactive", timeoutSec = 20 } = options;
    const host = new URL(url).host;
    // У хостов с долгим штрафом повтор внутри вызова только усугубляет: серия
    // запросов и есть то, за что WB наказывает. Одна попытка, дальше — пауза.
    const retries = SLOW_RECOVERY_HOSTS.has(host) ? 0 : (options.retries ?? 3);
    const queue = this.queueFor(host);

    const blocked = queue.blockedForMs();
    if (blocked > 0) throw new WbUnavailableError(host, blocked);

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(attempt * 900 + Math.floor(Math.random() * 400));
      await queue.acquire(priority);
      // Очередь могла держать запрос минуты — за это время хост мог закрыться,
      // поэтому предохранитель проверяем повторно, уже перед самым вызовом.
      const blockedAfterWait = queue.blockedForMs();
      if (blockedAfterWait > 0) throw new WbUnavailableError(host, blockedAfterWait);
      try {
        const { status, body } = await this.curl(url, timeoutSec);
        // status 0 — сетевой сбой на стороне curl, а не ответ Wildberries
        if (status === 0 || status === 429 || status === 403 || status >= 500) {
          queue.noteFailure(status);
          lastError = new WbHttpError(status, url);
          if (queue.blockedForMs() > 0) throw new WbUnavailableError(host, queue.blockedForMs());
          continue;
        }
        if (status === 404) {
          queue.noteSuccess(status);
          return null;
        }
        if (status < 200 || status >= 300) {
          queue.noteFailure(status);
          throw new WbHttpError(status, url);
        }
        const parsed = JSON.parse(body) as T;
        queue.noteSuccess(status);
        return parsed;
      } catch (err) {
        if (err instanceof WbUnavailableError) throw err;
        if (err instanceof WbHttpError) throw err;
        // сетевой сбой или битый JSON — повторяем
        queue.noteFailure(null);
        lastError = err;
        this.log(`${url} failed (attempt ${attempt + 1}): ${(err as Error)?.message}`);
        if (queue.blockedForMs() > 0) throw new WbUnavailableError(host, queue.blockedForMs());
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(`request to ${url} failed`);
  }
}

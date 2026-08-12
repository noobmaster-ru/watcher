// Планировщик живёт в том же процессе, что и HTTP-сервер, и это осознанно:
// Wildberries лимитирует по IP, а не по пользователю, поэтому фоновый обход и
// запросы из интерфейса должны стоять в одной очереди. Разнести их по
// контейнерам можно, но тогда лимитер придётся выносить в общий Redis.

import type { WbClient } from "@watcher/wb-core";
import { config } from "../config.js";
import { purgeExpiredSessions } from "../auth.js";
import { runPriceTick } from "./prices.js";
import { runSellerTick } from "./sellers.js";
import { runKeywordTick } from "./keywords.js";
import { exportUser, usersToExport } from "../services/export.js";
import type { GoogleApi } from "../services/google.js";

const log = (...args: unknown[]) => console.error("[scheduler]", ...args);

export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  /** Задачи, выполняющиеся прямо сейчас: их нужно дождаться при остановке. */
  private inFlight = new Set<Promise<void>>();

  constructor(
    private readonly wb: WbClient,
    private readonly google: GoogleApi | null = null,
  ) {}

  start(): void {
    if (!config.scheduler.enabled) {
      log("выключен (SCHEDULER_ENABLED=false)");
      return;
    }
    log(`запущен: тик цен раз в ${Math.round(config.scheduler.tickMs / 1000)} с`);

    this.every(config.scheduler.tickMs, "цены", async () => {
      const result = await runPriceTick(this.wb);
      if (result.checked > 0 || result.events > 0) {
        log(`проверено ${result.checked}, событий ${result.events}, пропало ${result.missing}`);
      }
    });

    // каталоги продавцов — редко и по одному, чтобы не выедать лимит catalog.wb.ru
    this.every(5 * 60_000, "каталоги", async () => {
      const result = await runSellerTick(this.wb);
      if (result.sellers > 0) {
        log(`каталоги: продавцов ${result.sellers}, товаров ${result.products}, новых ${result.added}`);
      }
    });


    // Позиции — по одному запросу за раз: search.wb.ru лимитирует жёстче всех,
    // и жадный обход стоил бы блокировки поиска целиком, включая интерфейс.
    this.every(3 * 60_000, "позиции", async () => {
      const result = await runKeywordTick(this.wb);
      if (result.checked > 0) log(`позиции: запросов ${result.checked}, найдено ${result.positions}`);
    });

    if (this.google) {
      this.every(config.google.exportIntervalMin * 60_000, "выгрузка", async () => {
        for (const userId of await usersToExport()) {
          try {
            const result = await exportUser(this.google as GoogleApi, userId);
            const total = result.products + result.sellers + result.keywords;
            if (total > 0) log(`выгрузка пользователя ${userId}: строк ${total}`);
          } catch (error) {
            log(`выгрузка пользователя ${userId}: ${(error as Error).message}`);
          }
        }
      });
    } else {
      log("выгрузка в Google Таблицы выключена: не задан GOOGLE_SERVICE_ACCOUNT");
    }

    this.every(24 * 3600_000, "сессии", async () => {
      await purgeExpiredSessions();
    });
  }

  /** Тики не накладываются друг на друга: следующий стартует после завершения предыдущего. */
  private every(intervalMs: number, name: string, task: () => Promise<void>): void {
    const run = async (): Promise<void> => {
      if (this.stopped) return;
      const running = task().catch((error: Error) => {
        log(`${name}: ${error.message}`);
      });
      this.inFlight.add(running);
      try {
        await running;
      } finally {
        this.inFlight.delete(running);
      }
      if (this.stopped) return;
      const timer = setTimeout(run, intervalMs);
      timer.unref();
      this.timers.push(timer);
    };
    const first = setTimeout(run, 1000);
    first.unref();
    this.timers.push(first);
  }

  /**
   * Останавливает планировщик и дожидается текущих задач. Без ожидания перезапуск
   * контейнера посреди тика обрывал бы рассылку уже вычисленных уведомлений.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    await Promise.allSettled([...this.inFlight]);
  }
}

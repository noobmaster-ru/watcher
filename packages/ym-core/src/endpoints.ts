// Операции над Яндекс Маркетом.
//
// Единственный надёжный способ узнать цену конкретного товара — найти его
// поиском по sku: страница карточки рисуется на клиенте и цену в HTML не
// отдаёт, а страница поиска отдаёт микроразметку с ценой. Поэтому и добавление
// товара, и каждая последующая проверка идут через поиск.

import { parseInput, parseSearch, slugQuery } from "./parse.js";
import { YmTransport } from "./transport.js";
import type { YmConfig, YmProduct } from "./types.js";

const SEARCH = "https://market.yandex.ru/search?text=";

export class YmClient {
  readonly transport: YmTransport;

  constructor(config: YmConfig = {}) {
    this.transport = new YmTransport(config);
  }

  /** Поиск по фразе. */
  async search(query: string, limit = 12): Promise<YmProduct[]> {
    const html = await this.transport.getHtml(`${SEARCH}${encodeURIComponent(query)}`);
    if (!html) return [];
    return parseSearch(html).slice(0, limit);
  }

  /**
   * Цена и данные конкретного товара.
   *
   * Тонкость, которую видно только на живых данных: по одному sku Маркет может
   * вернуть несколько строк с разной ценой — это предложения разных продавцов
   * на один товар. Брать первую нельзя: порядок выдачи меняется, и цена скакала
   * бы туда-сюда без всякого изменения на самом деле. Берём минимальную —
   * именно её видит покупатель как цену товара.
   */
  async bySku(sku: string): Promise<YmProduct | null> {
    const html = await this.transport.getHtml(`${SEARCH}${encodeURIComponent(sku)}`);
    if (!html) return null;

    const matching = parseSearch(html).filter((product) => product.sku === sku);
    if (matching.length === 0) return null;

    const priced = matching.filter((product) => product.price !== null);
    if (priced.length === 0) return matching[0] as YmProduct;

    return priced.reduce((best, current) =>
      (current.price as number) < (best.price as number) ? current : best,
    );
  }

  /** Цены сразу для нескольких товаров: у Маркета батчей нет, идём по одному. */
  async bySkus(skus: string[]): Promise<YmProduct[]> {
    const found: YmProduct[] = [];
    for (const sku of skus) {
      const product = await this.bySku(sku);
      if (product) found.push(product);
    }
    return found;
  }

  /**
   * Разбирает то, что вставил пользователь.
   *
   * Номер товара берётся как есть. Ссылку развернуть в номер надёжно нельзя:
   * число в адресе — не sku, а карточка закрыта капчей. Поэтому по названию из
   * адреса выполняется поиск, и наружу отдаётся список кандидатов — выбирает
   * пользователь. Угадывать нельзя: проверка на живых ссылках дала одно
   * попадание из двух.
   */
  async resolve(input: string): Promise<{ kind: "sku"; sku: string } | { kind: "candidates"; query: string; items: YmProduct[] }> {
    const parsed = parseInput(input);
    if (parsed.kind === "sku") return { kind: "sku", sku: parsed.sku };

    const query = slugQuery(parsed.url);
    if (!query) {
      throw new Error("Из ссылки не вышло понять товар. Вставьте его номер или найдите поиском");
    }
    return { kind: "candidates", query, items: await this.search(query, 8) };
  }

  status() {
    return [this.transport.status()];
  }

  overallState(): "ok" | "degraded" {
    return this.transport.status().state;
  }
}

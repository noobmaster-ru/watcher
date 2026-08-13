// Операции над Яндекс Маркетом.
//
// Единственный надёжный способ узнать цену конкретного товара — найти его
// поиском по sku: страница карточки рисуется на клиенте и цену в HTML не
// отдаёт, а страница поиска отдаёт микроразметку с ценой. Поэтому и добавление
// товара, и каждая последующая проверка идут через поиск.

import { parseInput, parseSearch, parseSkuFromCard } from "./parse.js";
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
   * Маркет по запросу «sku» возвращает не только сам товар, но и похожие,
   * поэтому из выдачи выбирается строка с совпадающим sku, а не первая.
   */
  async bySku(sku: string): Promise<YmProduct | null> {
    const html = await this.transport.getHtml(`${SEARCH}${encodeURIComponent(sku)}`);
    if (!html) return null;
    const products = parseSearch(html);
    return products.find((product) => product.sku === sku) ?? null;
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
   * Превращает то, что вставил пользователь, в sku. Ссылку на карточку
   * приходится разворачивать: число в её адресе — это не sku, поиск по нему
   * ничего не находит.
   */
  async resolveSku(input: string): Promise<string> {
    const parsed = parseInput(input);
    if (parsed.kind === "sku") return parsed.sku;

    const html = await this.transport.getHtml(parsed.url);
    if (!html) throw new Error("Страница товара не открылась");

    const sku = parseSkuFromCard(html);
    if (!sku) {
      throw new Error(
        "На странице не нашёлся номер товара. Скопируйте его из адресной строки или найдите товар поиском",
      );
    }
    return sku;
  }

  status() {
    return [this.transport.status()];
  }

  overallState(): "ok" | "degraded" {
    return this.transport.status().state;
  }
}

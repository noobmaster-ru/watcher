// Эндпоинты публичного API Wildberries, проверенные вживую 12.08.2026:
//   поиск       : https://search.wb.ru/exactmatch/ru/common/v5/search
//   карточка    : https://card.wb.ru/cards/v4/detail        (принимает до 100 nm через «;»)
//   card.json   : https://basket-NN.wbbasket.ru/volV/partP/{nm}/info/ru/card.json
//   продавец    : https://static-basket-01.wbbasket.ru/vol0/data/supplier-by-id/{id}.json
//   каталог     : https://catalog.wb.ru/sellers/v4/catalog?supplier={id}   (v5/v8/v9 → 404)
//   отзывы      : feedback-bt.wildberries.ru резолвит шард → feedback-view-NN.wb.ru/feedbacks/v2/{imtId}

import { WbTransport, WbUnavailableError } from "./transport.js";
import { cardJsonUrl, crc16Arc } from "./urls.js";
import { parseCardInfo, parseFeedbacks, parseProductList, parseSeller, parseTotal } from "./parse.js";
import type { HostState, HostStatus, Priority, WbCardInfo, WbConfig, WbProduct, WbReviews, WbSeller } from "./types.js";

/** Сколько артикулов влезает в один запрос карточки. Проверено: 100 отдаёт 200 OK. */
export const DETAIL_BATCH_SIZE = 100;

/** Потолок страниц при обходе каталога продавца — защита от бесконечной пагинации. */
const SELLER_MAX_PAGES = 50;
/** WB отдаёт до 100 товаров на страницу каталога. */
const SELLER_PAGE_SIZE = 100;

export interface WbClientOptions extends Partial<WbConfig> {
  transport?: WbTransport;
}

export class WbClient {
  readonly transport: WbTransport;
  readonly dest: string;
  readonly spp: string;

  constructor(options: WbClientOptions = {}) {
    this.dest = options.dest ?? "-1257786"; // Москва
    this.spp = options.spp ?? "30";
    this.transport =
      options.transport ??
      new WbTransport({ proxy: options.proxy, netInterface: options.netInterface, log: options.log });
  }

  hostStatuses(): HostStatus[] {
    return this.transport.hostStatuses();
  }

  overallState(): HostState {
    return this.transport.overallState();
  }

  // ── поиск ─────────────────────────────────────────────────────────────────
  /**
   * Поиск по фразе. Самый хрупкий эндпоинт: search.wb.ru жёстко режет частые
   * запросы и с зарубежного IP отвечает 429 практически всегда.
   */
  async search(query: string, limit = 24, priority: Priority = "interactive"): Promise<WbProduct[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("Пустой поисковый запрос");

    const want = Math.min(Math.max(limit, 1), 300);
    const perPage = Math.min(100, want);
    const maxPages = Math.ceil(want / 100);
    const seen = new Set<string>();
    const items: WbProduct[] = [];

    for (let page = 1; items.length < want && page <= maxPages; page++) {
      const url = new URL("https://search.wb.ru/exactmatch/ru/common/v5/search");
      url.searchParams.set("query", trimmed);
      url.searchParams.set("resultset", "catalog");
      url.searchParams.set("limit", String(perPage));
      url.searchParams.set("dest", this.dest);
      url.searchParams.set("curr", "rub");
      url.searchParams.set("lang", "ru");
      if (page > 1) url.searchParams.set("page", String(page));

      let batch: WbProduct[];
      try {
        batch = parseProductList(await this.transport.getJson(url.toString(), { priority }));
      } catch (err) {
        // отдаём собранное, а не падаем целиком: частичная выдача полезнее ошибки
        if (items.length > 0 && err instanceof WbUnavailableError) break;
        throw err;
      }
      if (batch.length === 0) break;
      for (const item of batch) {
        if (!seen.has(item.nm)) {
          seen.add(item.nm);
          items.push(item);
        }
      }
      if (batch.length < perPage) break;
    }
    return items.slice(0, want);
  }

  // ── карточки ──────────────────────────────────────────────────────────────
  /**
   * Карточки пачкой — горячий путь трекера. Тысяча отслеживаемых артикулов
   * стоит десяти запросов, а не тысячи.
   */
  async detailBatch(nms: Array<number | string>, priority: Priority = "background"): Promise<WbProduct[]> {
    const unique = [...new Set(nms.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
    if (unique.length === 0) return [];

    const result: WbProduct[] = [];
    for (let i = 0; i < unique.length; i += DETAIL_BATCH_SIZE) {
      const chunk = unique.slice(i, i + DETAIL_BATCH_SIZE);
      const url = new URL("https://card.wb.ru/cards/v4/detail");
      url.searchParams.set("appType", "1");
      url.searchParams.set("curr", "rub");
      url.searchParams.set("dest", this.dest);
      url.searchParams.set("spp", this.spp);
      url.searchParams.set("nm", chunk.join(";"));
      result.push(...parseProductList(await this.transport.getJson(url.toString(), { priority })));
    }
    return result;
  }

  async detail(nm: number | string, priority: Priority = "interactive"): Promise<WbProduct | null> {
    const [product] = await this.detailBatch([nm], priority);
    return product ?? null;
  }

  /** Описание и характеристики лежат отдельно, на CDN. */
  async cardInfo(nm: number | string, priority: Priority = "interactive"): Promise<WbCardInfo> {
    return parseCardInfo(await this.transport.getJson(cardJsonUrl(Number(nm)), { priority }));
  }

  // ── продавец ──────────────────────────────────────────────────────────────
  async seller(supplierId: number | string, priority: Priority = "interactive"): Promise<WbSeller | null> {
    const id = Number(supplierId);
    const url = `https://static-basket-01.wbbasket.ru/vol0/data/supplier-by-id/${id}.json`;
    return parseSeller(await this.transport.getJson(url, { priority }), id);
  }

  /** Одна страница каталога продавца. */
  async sellerCatalogPage(
    supplierId: number | string,
    page = 1,
    priority: Priority = "interactive",
  ): Promise<{ products: WbProduct[]; total: number | null; missing: boolean }> {
    const url = new URL("https://catalog.wb.ru/sellers/v4/catalog");
    url.searchParams.set("ab_testing", "false");
    url.searchParams.set("appType", "1");
    url.searchParams.set("curr", "rub");
    url.searchParams.set("dest", this.dest);
    url.searchParams.set("hide_dtype", "13");
    url.searchParams.set("lang", "ru");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "popular");
    url.searchParams.set("spp", this.spp);
    url.searchParams.set("supplier", String(Number(supplierId)));

    const json = await this.transport.getJson(url.toString(), { priority });
    // json === null означает 404 от WB: страницы нет, но это не «каталог кончился»
    return { products: parseProductList(json), total: parseTotal(json), missing: json === null };
  }

  /** Весь каталог продавца постранично. Прерывается на первой пустой странице. */
  async sellerCatalogAll(
    supplierId: number | string,
    priority: Priority = "background",
    maxPages = SELLER_MAX_PAGES,
  ): Promise<{
    products: WbProduct[];
    total: number | null;
    pagesFetched: number;
    truncated: boolean;
    /** Обход дошёл до естественного конца каталога. False — список неполный. */
    complete: boolean;
  }> {
    const seen = new Set<string>();
    const products: WbProduct[] = [];
    let total: number | null = null;
    let page = 1;
    let complete = false;

    for (; page <= maxPages; page++) {
      const chunk = await this.sellerCatalogPage(supplierId, page, priority);
      if (total === null) total = chunk.total;

      if (chunk.missing) break; // 404 посреди обхода — список заведомо неполный
      if (chunk.products.length === 0) {
        // пустая страница после непустых — обычный конец выдачи
        complete = page > 1;
        break;
      }
      for (const item of chunk.products) {
        if (!seen.has(item.nm)) {
          seen.add(item.nm);
          products.push(item);
        }
      }
      if (chunk.products.length < SELLER_PAGE_SIZE) {
        complete = true; // последняя, неполная страница
        break;
      }
    }

    return { products, total, pagesFetched: page - 1, truncated: page > maxPages, complete };
  }

  // ── отзывы ────────────────────────────────────────────────────────────────
  /**
   * Отзывы лежат по root (imtId) из карточки, не по артикулу. Хост шарда
   * спрашиваем у резолвера WB, а если он молчит — считаем шард сами, как это
   * делает фронт WB (CRC16/ARC от imtId).
   */
  async reviews(root: number | string, limit = 10, priority: Priority = "interactive"): Promise<WbReviews> {
    const candidates: string[] = [];

    try {
      const resolved = await this.transport.getJson<string[]>(
        `https://feedback-bt.wildberries.ru/feedback/api/v2/host?imt=${root}`,
        { priority, retries: 1 },
      );
      if (Array.isArray(resolved) && typeof resolved[0] === "string") {
        candidates.push(resolved[0].replace(/\/+$/, ""));
      }
    } catch {
      // резолвер недоступен — ниже посчитаем шард сами
    }

    const shard = crc16Arc(root) % 100 >= 50 ? "02" : "01";
    for (const host of [
      `https://feedback-view-${shard}.wb.ru`,
      "https://feedback-view-01.wb.ru",
      "https://feedback-view-02.wb.ru",
    ]) {
      if (!candidates.includes(host)) candidates.push(host);
    }

    let fallback: unknown = null;
    for (const base of candidates) {
      try {
        const data = await this.transport.getJson<{ feedbacks?: unknown[] }>(`${base}/feedbacks/v2/${root}`, {
          priority,
          retries: 1,
        });
        if (data && Array.isArray(data.feedbacks)) return parseFeedbacks(data, limit);
        if (data) fallback = data;
      } catch {
        // не тот шард — пробуем следующий
      }
    }
    return parseFeedbacks(fallback, limit);
  }

  /** Карточка + описание + характеристики одним вызовом. */
  async fullProduct(
    nm: number | string,
    priority: Priority = "interactive",
  ): Promise<(WbProduct & WbCardInfo) | null> {
    const product = await this.detail(nm, priority);
    if (!product) return null;
    let info: WbCardInfo = { description: "", characteristics: {} };
    try {
      info = await this.cardInfo(nm, priority);
    } catch {
      // описание живёт на CDN отдельно; без него карточка всё ещё полезна
    }
    return { ...product, ...info };
  }
}

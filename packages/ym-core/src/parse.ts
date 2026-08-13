// Разбор страниц Яндекс Маркета.
//
// Цены берутся не из вёрстки, а из микроразметки schema.org, которую Маркет
// кладёт в страницу поиска: там для каждого товара есть name, sku, image,
// описание и Offer с ценой и наличием. Это официальный, стабильный контракт —
// он рассчитан на поисковые системы, и ломать его Маркету невыгодно, в отличие
// от классов вёрстки, которые меняются от релиза к релизу.

import type { YmProduct } from "./types.js";

interface LdOffer {
  price?: number | string;
  priceCurrency?: string;
  availability?: string;
}

interface LdProduct {
  name?: string;
  sku?: string | number;
  image?: string;
  description?: string;
  url?: string;
  offers?: LdOffer | LdOffer[];
}

/** Все блоки ld+json со страницы. */
function ldBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script type="application\/ld\+json">(.*?)<\/script>/gs;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1] as string));
    } catch {
      // битый блок пропускаем: остальные обычно целы
    }
  }
  return blocks;
}

const firstOffer = (offers: LdOffer | LdOffer[] | undefined): LdOffer | undefined =>
  Array.isArray(offers) ? offers[0] : offers;

function toProduct(item: LdProduct): YmProduct | null {
  const sku = item.sku != null ? String(item.sku) : null;
  if (!sku) return null;

  const offer = firstOffer(item.offers);
  const rawPrice = offer?.price;
  const price = rawPrice == null ? null : Math.round(Number(rawPrice));

  return {
    sku,
    name: item.name ?? null,
    price: Number.isFinite(price) ? price : null,
    // Маркет старую цену в микроразметке не отдаёт — поле есть ради единого
    // вида с товарами Wildberries, где скидка приходит всегда.
    oldPrice: null,
    inStock: (offer?.availability ?? "").includes("InStock"),
    image: item.image ?? null,
    url: item.url ?? `https://market.yandex.ru/search?text=${sku}`,
    description: item.description ?? null,
  };
}

/** Товары со страницы поиска. */
export function parseSearch(html: string): YmProduct[] {
  const products: YmProduct[] = [];
  for (const block of ldBlocks(html)) {
    const list = block as { "@type"?: string; itemListElement?: Array<{ item?: LdProduct }> };
    if (list["@type"] !== "ItemList") continue;
    for (const entry of list.itemListElement ?? []) {
      const product = entry.item ? toProduct(entry.item) : null;
      if (product) products.push(product);
    }
  }
  return products;
}

/**
 * Идентификатор товара со страницы карточки.
 *
 * Оставлен для полноты, но приложением не используется: страницы карточек
 * Маркет закрывает капчей для встроенного fetch, а fetch здесь единственный
 * рабочий способ (см. комментарий в transport.ts). Ссылка вместо этого
 * превращается в поисковый запрос — см. slugQuery.
 */
export function parseSkuFromCard(html: string): string | null {
  const match = html.match(/"sku"\s*:\s*"?(\d{6,16})"?/);
  return match?.[1] ?? null;
}

/**
 * Поисковый запрос из адреса карточки.
 *
 * Число в адресе — не sku, и поиск по нему ничего не находит; сама карточка
 * закрыта капчей. Зато в адресе есть человекочитаемая часть с названием
 * товара, и по ней поиск обычно находит нужное. «Обычно» — потому что
 * проверка на живых ссылках дала одно попадание из двух: во втором случае по
 * запросу «shampur ecos 103343» первым вышел рюкзак. Поэтому результат такого
 * поиска показывается пользователю как список кандидатов, а не выбирается за
 * него молча.
 */
export function slugQuery(url: string): string | null {
  const path = url.match(/market\.yandex\.[a-z]+\/(?:card|product)(?:--)?\/([^/?#]+)/i)?.[1];
  if (!path) return null;
  const words = decodeURIComponent(path).replace(/-/g, " ").trim();
  return words.length >= 3 ? words : null;
}

/** Похоже ли на sku: только цифры, достаточно длинное. */
export function looksLikeSku(value: string): boolean {
  return /^\d{6,16}$/.test(value.trim());
}

/** Извлекает sku или адрес карточки из того, что вставил пользователь. */
export function parseInput(input: string): { kind: "sku"; sku: string } | { kind: "url"; url: string } {
  const raw = input.trim();
  if (looksLikeSku(raw)) return { kind: "sku", sku: raw };

  const url = raw.match(/https?:\/\/[^\s]*market\.yandex\.[a-z]+\/[^\s]*/i)?.[0];
  if (url) return { kind: "url", url };

  throw new Error("Нужен номер товара Яндекс Маркета или ссылка на его карточку");
}

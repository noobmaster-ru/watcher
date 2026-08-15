// Разбор ответов composer-api Озона. Чистые функции, без сети — порт parse.js
// из ozon-mcp-server, обрезанный до того, что нужно трекеру цен: карточка и
// поиск. Отзывы и характеристики не переносились.

export interface OzonParsedProduct {
  sku: string | null;
  name: string | null;
  /** Цена с Ozon Картой — её видит покупатель с картой; может отсутствовать. */
  cardPrice: number | null;
  /** Обычная цена без карты. */
  price: number | null;
  oldPrice: number | null;
  available: boolean | null;
  image: string | null;
  url: string | null;
}

interface ComposerPage {
  widgetStates?: Record<string, string>;
  seo?: { link?: Array<{ href?: string }>; title?: string };
  layoutTrackingInfo?: string;
  nextPage?: string;
}

/** Ключи виджетов выглядят как «webPrice-3121879-default-1»: сравниваем имя до дефиса. */
const widgetName = (key: string): string => String(key).split("-")[0] as string;

function widget(page: ComposerPage | null, name: string): Record<string, unknown> | null {
  const states = page?.widgetStates ?? {};
  const key = Object.keys(states).find((k) => widgetName(k) === name);
  if (!key) return null;
  try {
    return JSON.parse(states[key] as string) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** «53 022 ₽» → 53022; мусор → null. */
export function priceToNumber(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const digits = text.replace(/[^\d]/g, "");
  return digits ? Number.parseInt(digits, 10) : null;
}

const cleanUrl = (link: unknown): string | null => {
  if (!link) return null;
  const path = String(link).split("?")[0] as string;
  return path.startsWith("http") ? path : `https://www.ozon.ru${path}`;
};

const skuFromUrl = (url: unknown): string | null => {
  const m = String(url ?? "").match(/-(\d+)\/?(?:\?|$)/) ?? String(url ?? "").match(/(\d{6,})/);
  return m?.[1] ?? null;
};

/** Карточка товара: цена лежит в виджете webPrice, имя — в webProductHeading. */
export function parseProduct(page: unknown): OzonParsedProduct {
  const p = page as ComposerPage;
  const heading = widget(p, "webProductHeading");
  const price = widget(p, "webPrice");
  const gallery = widget(p, "webGallery");

  let trackingSku: string | null = null;
  try {
    trackingSku = String(JSON.parse(p?.layoutTrackingInfo ?? "{}").sku ?? "") || null;
  } catch {
    /* нет данных трекинга — возьмём из галереи или ссылки */
  }
  const sku = String((gallery?.sku as string) ?? trackingSku ?? "") || skuFromUrl(p?.seo?.link?.[0]?.href);

  const images: string[] = [];
  if (typeof gallery?.coverImage === "string") images.push(gallery.coverImage);

  return {
    sku,
    name: (heading?.title as string) ?? p?.seo?.title ?? null,
    cardPrice: priceToNumber(price?.cardPrice),
    price: priceToNumber(price?.price),
    oldPrice: priceToNumber(price?.originalPrice),
    available: (price?.isAvailable as boolean) ?? null,
    image: images[0] ?? null,
    url: cleanUrl(p?.seo?.link?.[0]?.href) ?? (sku ? `https://www.ozon.ru/product/${sku}/` : null),
  };
}

export interface OzonSearchItem {
  sku: string;
  name: string | null;
  price: number | null;
  oldPrice: number | null;
  image: string | null;
  url: string | null;
}

/** Плитки поиска: товары в tileGridDesktop, цена в блоке priceV2. */
export function parseSearch(page: unknown, limit = 12): OzonSearchItem[] {
  const grid = widget(page as ComposerPage, "tileGridDesktop");
  const rawItems = (grid?.items as Array<Record<string, unknown>>) ?? [];

  const items: OzonSearchItem[] = [];
  for (const it of rawItems) {
    const ms = Array.isArray(it.mainState) ? (it.mainState as Array<Record<string, unknown>>) : [];
    const priceBlock = ms.find((s) => s.type === "priceV2")?.priceV2 as
      | { price?: Array<{ text?: string; textStyle?: string }> }
      | undefined;
    const prices = priceBlock?.price ?? [];
    const price = priceToNumber(prices.find((x) => x.textStyle === "PRICE")?.text);
    const oldPrice = priceToNumber(prices.find((x) => x.textStyle === "ORIGINAL_PRICE")?.text);
    const name = ((ms.find((s) => s.id === "name")?.textDS as { text?: string })?.text as string) ?? null;

    const action = it.action as { link?: string } | undefined;
    const url = cleanUrl(action?.link);
    const sku = String((it.sku as string) ?? (it.id as string) ?? skuFromUrl(url) ?? "") || null;

    const tile = it.tileImage as { items?: Array<{ image?: { link?: string } }>; coverImage?: string } | undefined;
    const image = tile?.items?.find((x) => x.image?.link)?.image?.link ?? tile?.coverImage ?? null;

    // у настоящего товара всегда есть и номер, и цена
    if (!sku || price === null) continue;
    items.push({ sku, name, price, oldPrice: oldPrice && oldPrice > price ? oldPrice : null, image, url });
    if (items.length >= limit) break;
  }
  return items;
}

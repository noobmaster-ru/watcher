// Чистые парсеры ответов Wildberries. Сети здесь нет.
//
// Главная тонкость — цена. WB отдаёт её в копейках внутри sizes[].price, причём
// у товара, которого нет в наличии, объекта price нет вообще (проверено на живом
// API). Для трекера это критично: отсутствие цены нужно отличать от падения цены,
// иначе каждый распроданный товар выглядит как скидка 100%.

import { imageUrl, productUrl } from "./urls.js";
import type { Price, WbCardInfo, WbProduct, WbReviews, WbSeller } from "./types.js";

interface RawPrice {
  basic?: number;
  product?: number;
  total?: number;
  logistics?: number;
  return?: number;
  cashback?: number;
}

interface RawSize {
  name?: string;
  origName?: string;
  price?: RawPrice;
  stocks?: Array<{ qty?: number }>;
}

interface RawProduct {
  id: number;
  root?: number;
  name?: string;
  brand?: string;
  supplier?: string;
  supplierId?: number;
  supplierRating?: number;
  rating?: number;
  reviewRating?: number;
  nmReviewRating?: number;
  feedbacks?: number;
  nmFeedbacks?: number;
  pics?: number;
  totalQuantity?: number;
  colors?: Array<{ name?: string }>;
  sizes?: RawSize[];
  salePriceU?: number;
  priceU?: number;
}

interface RawProductList {
  products?: RawProduct[];
  data?: { products?: RawProduct[] };
  total?: number;
}

/** Копейки → рубли. 0 и отсутствующее значение одинаково означают «цены нет». */
function rub(kopecks: number | undefined | null): number | null {
  if (typeof kopecks !== "number" || !Number.isFinite(kopecks) || kopecks <= 0) return null;
  return Math.round(kopecks / 100);
}

/**
 * Цена по всем размерам. У разноразмерных товаров цены различаются, поэтому
 * помимо основной цены считаем разброс min/max — иначе трекер будет прыгать
 * между размерами и рапортовать несуществующие изменения.
 */
export function parsePrice(p: RawProduct): Price {
  const sizes = Array.isArray(p.sizes) ? p.sizes : [];
  const products: number[] = [];
  let basic: number | null = null;
  let cashback: number | null = null;

  for (const size of sizes) {
    const raw = size?.price;
    if (!raw) continue;
    const value = rub(raw.product ?? raw.total ?? raw.basic);
    if (value === null) continue;
    products.push(value);
    const sizeBasic = rub(raw.basic);
    if (sizeBasic !== null && (basic === null || sizeBasic > basic)) basic = sizeBasic;
    const sizeCashback = rub(raw.cashback);
    if (sizeCashback !== null && (cashback === null || sizeCashback > cashback)) cashback = sizeCashback;
  }

  if (products.length === 0) {
    // запасной путь для старых плоских полей; на v4 они уже не приходят
    const legacy = rub(p.salePriceU);
    if (legacy === null) {
      return { product: null, basic: null, cashback: null, min: null, max: null, pricedSizes: 0 };
    }
    const legacyBasic = rub(p.priceU);
    return {
      product: legacy,
      basic: legacyBasic !== null && legacyBasic > legacy ? legacyBasic : null,
      cashback: null,
      min: legacy,
      max: legacy,
      pricedSizes: 1,
    };
  }

  const min = Math.min(...products);
  const max = Math.max(...products);
  // основной ценой считаем минимальную: именно её WB показывает на карточке
  const product = min;
  return {
    product,
    basic: basic !== null && basic > product ? basic : null,
    cashback,
    min,
    max,
    pricedSizes: products.length,
  };
}

/** Суммарный остаток: totalQuantity, а если его нет — сумма по стокам размеров. */
function quantityOf(p: RawProduct): number {
  if (typeof p.totalQuantity === "number") return p.totalQuantity;
  let sum = 0;
  for (const size of p.sizes ?? []) {
    for (const stock of size?.stocks ?? []) sum += stock?.qty ?? 0;
  }
  return sum;
}

export function parseProduct(p: RawProduct): WbProduct {
  const nm = p.id;
  const totalQuantity = quantityOf(p);
  const price = parsePrice(p);
  return {
    nm: String(nm),
    name: p.name ?? null,
    brand: p.brand ?? null,
    price,
    rating: p.reviewRating ?? p.nmReviewRating ?? p.rating ?? null,
    reviews: p.feedbacks ?? p.nmFeedbacks ?? null,
    supplier: p.supplier ?? null,
    supplierId: p.supplierId ?? null,
    supplierRating: p.supplierRating ?? null,
    root: p.root != null ? String(p.root) : null,
    // товар считается доступным, только если есть и остаток, и цена
    inStock: totalQuantity > 0 && price.product !== null,
    totalQuantity,
    pics: p.pics ?? null,
    colors: (p.colors ?? []).map((c) => c?.name).filter((n): n is string => Boolean(n)),
    url: productUrl(nm),
    image: imageUrl(nm),
  };
}

/** Разбирает любой ответ вида {products:[...]} — поиск, карточка, каталог продавца. */
export function parseProductList(json: unknown): WbProduct[] {
  const raw = json as RawProductList | null;
  const products = raw?.products ?? raw?.data?.products ?? [];
  return products.filter((p) => p && typeof p.id === "number").map(parseProduct);
}

export function parseTotal(json: unknown): number | null {
  const raw = json as RawProductList | null;
  return typeof raw?.total === "number" ? raw.total : null;
}

/** card.json с CDN: описание и характеристики. */
export function parseCardInfo(json: unknown): WbCardInfo {
  const card = json as
    | { description?: string; options?: Array<{ name?: string; value?: unknown }>; grouped_options?: Array<{ options?: Array<{ name?: string; value?: unknown }> }> }
    | null;
  if (!card) return { description: "", characteristics: {} };

  const description = (card.description ?? "").replace(/\s+/g, " ").trim();
  let options = Array.isArray(card.options) ? card.options : [];
  if (options.length === 0 && Array.isArray(card.grouped_options)) {
    options = card.grouped_options.flatMap((g) => g?.options ?? []);
  }

  const characteristics: Record<string, string> = {};
  for (const option of options) {
    const name = option?.name;
    const value = Array.isArray(option?.value) ? option.value.join(", ") : option?.value;
    if (name && value != null && String(value).trim()) characteristics[name] = String(value).trim();
  }
  return { description, characteristics };
}

/** supplier-by-id.json. Поля приходят пустыми строками — нормализуем в null. */
export function parseSeller(json: unknown, supplierId: number): WbSeller | null {
  const s = json as
    | { supplierId?: number; supplierName?: string; supplierFullName?: string; inn?: string; trademark?: string; legalAddress?: string }
    | null;
  if (!s) return null;
  const clean = (v: string | undefined) => {
    const trimmed = (v ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    supplierId: s.supplierId ?? supplierId,
    name: clean(s.supplierName),
    fullName: clean(s.supplierFullName),
    inn: clean(s.inn),
    trademark: clean(s.trademark),
    legalAddress: clean(s.legalAddress),
  };
}

interface RawFeedback {
  wbUserDetails?: { name?: string };
  userName?: string;
  productValuation?: number;
  text?: string;
  pros?: string;
  cons?: string;
  createdDate?: string;
  color?: string;
  size?: string;
  photos?: unknown[];
  photo?: unknown[];
}

export function parseFeedbacks(json: unknown, limit = 10): WbReviews {
  const data = json as { feedbacks?: RawFeedback[]; valuation?: number; feedbackCount?: number } | null;
  const all = Array.isArray(data?.feedbacks) ? data.feedbacks : [];

  // сначала отзывы с текстом, внутри — свежие сверху
  const sorted = [...all].sort((a, b) => {
    const aHasText = a.text || a.pros || a.cons ? 1 : 0;
    const bHasText = b.text || b.pros || b.cons ? 1 : 0;
    if (aHasText !== bHasText) return bHasText - aHasText;
    return String(b.createdDate ?? "").localeCompare(String(a.createdDate ?? ""));
  });

  const reviews = sorted.slice(0, limit).map((f) => ({
    author: f.wbUserDetails?.name || f.userName || "Аноним",
    score: typeof f.productValuation === "number" ? f.productValuation : null,
    text: f.text ?? "",
    pros: f.pros ?? "",
    cons: f.cons ?? "",
    date: (f.createdDate ?? "").slice(0, 10) || null,
    color: f.color ?? null,
    size: f.size ?? null,
    hasPhotos: (Array.isArray(f.photos) && f.photos.length > 0) || (Array.isArray(f.photo) && f.photo.length > 0),
  }));

  return {
    rating: data?.valuation ?? null,
    totalReviews: data?.feedbackCount ?? null,
    count: reviews.length,
    reviews,
  };
}

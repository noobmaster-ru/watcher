// Типы, которыми wb-core разговаривает с внешним миром. Всё, что уходит наружу,
// уже нормализовано: цены в рублях, наличие явным флагом, копейки не протекают.

/** Цена одного товара. Все поля в рублях; null означает «WB цену не отдал». */
export interface Price {
  /** Цена к оплате после скидки (sizes[].price.product). */
  product: number | null;
  /** Цена до скидки (sizes[].price.basic). Null, если она не выше product. */
  basic: number | null;
  /** Кэшбэк баллами, если WB его вернул. */
  cashback: number | null;
  /** Минимальная и максимальная цена по всем размерам — у разноразмерных товаров они различаются. */
  min: number | null;
  max: number | null;
  /** Сколько размеров реально имеют цену. 0 → товара нет в продаже. */
  pricedSizes: number;
}

/** Товар в том виде, в каком его отдают и поиск, и карточка, и каталог продавца. */
export interface WbProduct {
  nm: string;
  name: string | null;
  brand: string | null;
  price: Price;
  rating: number | null;
  reviews: number | null;
  supplier: string | null;
  supplierId: number | null;
  supplierRating: number | null;
  /** imtId — по нему лежат отзывы. Есть только в ответе карточки. */
  root: string | null;
  inStock: boolean;
  totalQuantity: number;
  pics: number | null;
  colors: string[];
  url: string;
  image: string;
}

/** Описание и характеристики из card.json (отдельный CDN-запрос). */
export interface WbCardInfo {
  description: string;
  characteristics: Record<string, string>;
}

/** Продавец из supplier-by-id.json. */
export interface WbSeller {
  supplierId: number;
  name: string | null;
  fullName: string | null;
  inn: string | null;
  trademark: string | null;
  legalAddress: string | null;
}

export interface WbReview {
  author: string;
  score: number | null;
  text: string;
  pros: string;
  cons: string;
  date: string | null;
  color: string | null;
  size: string | null;
  hasPhotos: boolean;
}

export interface WbReviews {
  rating: number | null;
  totalReviews: number | null;
  count: number;
  reviews: WbReview[];
}

/** Состояние хоста WB для /api/health и баннера в UI. */
export type HostState = "ok" | "degraded" | "banned";

export interface HostStatus {
  host: string;
  state: HostState;
  /** Сколько подряд запросов упёрлось в 429/403. */
  consecutiveFailures: number;
  lastStatus: number | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
  /** До какого момента запросы к хосту не выпускаются (открытый предохранитель). */
  blockedUntil: string | null;
}

/** Настройки, общие для всех запросов к WB. */
export interface WbConfig {
  /** Регион доставки: влияет на цену и наличие. */
  dest: string;
  /** Скидка постоянного покупателя, которую подставляем в запрос карточки. */
  spp: string;
  /** HTTP-прокси для curl (нужен, если сервер вне РФ). */
  proxy?: string | undefined;
  /** Привязка curl к конкретному интерфейсу/адресу. */
  netInterface?: string | undefined;
  /** Логгер; по умолчанию пишет в stderr (stdout занят JSON-RPC у MCP). */
  log?: (...args: unknown[]) => void;
}

/** Приоритет в очереди к WB: живой пользователь ждёт ответа, фоновый обход — нет. */
export type Priority = "interactive" | "background";

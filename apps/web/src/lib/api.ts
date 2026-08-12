// Тонкий клиент к нашему API. Одно место, где живёт разбор ошибок: сервер
// отдаёт 503 с флагом degraded, когда его тормозит Wildberries, и интерфейс
// обязан отличать это от «ничего не нашлось».

export class ApiError extends Error {
  readonly status: number;
  readonly degraded: boolean;
  constructor(status: number, message: string, degraded = false) {
    super(message);
    this.status = status;
    this.degraded = degraded;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      (body.error as string) ?? `Ошибка ${response.status}`,
      Boolean(body.degraded),
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ── типы ответов ────────────────────────────────────────────────────────────
export interface Price {
  product: number | null;
  basic: number | null;
  cashback: number | null;
  min: number | null;
  max: number | null;
  pricedSizes: number;
}

export interface Product {
  nm: string;
  name: string | null;
  brand: string | null;
  price: Price;
  rating: number | null;
  reviews: number | null;
  supplier: string | null;
  supplierId: number | null;
  root: string | null;
  inStock: boolean;
  totalQuantity: number;
  colors: string[];
  url: string;
  image: string;
  description?: string;
  characteristics?: Record<string, string>;
}

export interface Seller {
  supplierId: number;
  name: string | null;
  fullName: string | null;
  inn: string | null;
  trademark: string | null;
}

export interface Watch {
  id: number;
  kind: "product" | "seller";
  nm: number | null;
  supplierId: number | null;
  title: string | null;
  intervalMin: number;
  minChangePct: number;
  minChangeAbs: number;
  onDrop: boolean;
  onRise: boolean;
  onStockChange: boolean;
  onNewProduct: boolean;
  notifyTelegram: boolean;
  productName: string | null;
  brand: string | null;
  supplierName: string | null;
  lastPrice: number | null;
  lastBasic: number | null;
  lastInStock: boolean | null;
  lastCheckedAt: string | null;
  sellerName: string | null;
  priceDayAgo: number | null;
  priceWeekAgo: number | null;
  trackedProducts: number | null;
}

export interface Alert {
  id: number;
  nm: number;
  type: "price_drop" | "price_rise" | "out_of_stock" | "back_in_stock" | "new_product";
  oldPrice: number | null;
  newPrice: number | null;
  createdAt: string;
  readAt: string | null;
  name: string | null;
  brand: string | null;
  supplierName: string | null;
}

export interface PricePoint {
  checkedAt: string;
  price: number | null;
  basic: number | null;
  inStock: boolean;
}

export interface Health {
  database: "ok" | "down";
  wb: { state: "ok" | "degraded" | "banned"; hosts: Array<{ host: string; state: string; lastStatus: number | null }> };
  telegram: "on" | "off";
}

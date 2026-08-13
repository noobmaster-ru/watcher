/** Товар Яндекс Маркета в том виде, в каком его использует приложение. */
export interface YmProduct {
  /** Идентификатор товарного предложения. Именно по нему ищется цена. */
  sku: string;
  name: string | null;
  price: number | null;
  oldPrice: number | null;
  inStock: boolean;
  image: string | null;
  url: string;
  description: string | null;
}

export interface YmConfig {
  /** HTTP-прокси, если приложение живёт вне России. */
  proxy?: string | undefined;
  log?: ((...args: unknown[]) => void) | undefined;
}

export class YmUnavailableError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Яндекс Маркет ограничивает запросы; повтор через ${Math.ceil(retryAfterMs / 1000)} с`);
    this.name = "YmUnavailableError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class YmHttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`Яндекс Маркет ответил ${status} на ${url}`);
    this.name = "YmHttpError";
    this.status = status;
  }
}

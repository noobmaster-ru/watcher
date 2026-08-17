// Клиент агента Озона.
//
// Сам по себе лёгкий: Chromium и Playwright живут в отдельном контейнере
// ozon-agent, а здесь — обычные HTTP-запросы к нему по docker-сети. Если адрес
// агента не задан, площадка считается выключенной, и приложение живёт без неё —
// так же, как выгрузка живёт без ключа Google.

export interface OzonProduct {
  sku: string;
  name: string | null;
  /** Обычная цена. Для истории берём её: карта есть не у всех. */
  price: number | null;
  /** Цена с Ozon Картой — справочно, показывается в карточке. */
  cardPrice: number | null;
  oldPrice: number | null;
  inStock: boolean;
  image: string | null;
  url: string;
}

export class OzonUnavailableError extends Error {
  constructor(message: string) {
    super(`Озон недоступен: ${message}`);
    this.name = "OzonUnavailableError";
  }
}

/**
 * Сессия браузера протухла, и автоматически её не восстановить: Озон
 * показывает капчу для человека. Это не сбой, а штатное состояние — интерфейс
 * должен показать кнопку «открыть окно браузера», а планировщик — не ретраить.
 */
export class OzonNeedsHumanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OzonNeedsHumanError";
  }
}

export type OzonSessionState = "down" | "needs_human" | "ready";

export interface OzonAgentStatus {
  running: boolean;
  session: OzonSessionState;
  lastTitle: string;
  lastCheckAt: string | null;
}

interface AgentProduct {
  sku: string | null;
  name: string | null;
  cardPrice: number | null;
  price: number | null;
  oldPrice: number | null;
  available: boolean | null;
  image: string | null;
  url: string | null;
}

/** Приводит ответ агента к форме товара; цена null у недоступного товара. */
function toProduct(raw: AgentProduct): OzonProduct | null {
  if (!raw.sku) return null;
  const available = raw.available !== false && raw.price !== null;
  return {
    sku: raw.sku,
    name: raw.name,
    price: available ? raw.price : null,
    cardPrice: available ? raw.cardPrice : null,
    oldPrice: raw.oldPrice,
    inStock: available,
    image: raw.image,
    url: raw.url ?? `https://www.ozon.ru/product/${raw.sku}/`,
  };
}

/** Извлекает sku из того, что вставил пользователь: число, ссылка со slug'ом. */
export function parseOzonInput(input: string): string {
  const raw = input.trim();
  if (/^\d{5,16}$/.test(raw)) return raw;
  // в ссылках Озона sku — последнее число в slug: .../product/nazvanie-1587315442/
  const url = raw.match(/ozon\.ru\/[^\s]*/i)?.[0] ?? "";
  const m = url.match(/-(\d{5,16})\/?(?:[?#]|$)/) ?? url.match(/product\/(\d{5,16})/);
  if (m?.[1]) return m[1];
  throw new Error("Нужен номер товара Озона (sku) или ссылка на его карточку");
}

export class OzonClient {
  private readonly base: string;
  private lastError: string | null = null;
  private lastOkAt: number | null = null;

  constructor(agentUrl: string) {
    this.base = agentUrl.replace(/\/+$/, "");
  }

  private async call<T>(path: string, timeoutMs = 120_000): Promise<T> {
    let response: Response;
    try {
      // таймаут щедрый: холодный старт агента — это запуск Chromium и
      // прохождение антибот-челленджа, порядка 15–20 секунд
      response = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      this.lastError = (error as Error).message;
      throw new OzonUnavailableError(this.lastError);
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 404) {
      this.lastOkAt = Date.now();
      return null as T;
    }
    if (response.status === 423) {
      // агент говорит: сессия жива только с участием человека
      this.lastError = String(body.error ?? "нужна проверка человеком");
      throw new OzonNeedsHumanError(this.lastError);
    }
    if (!response.ok) {
      this.lastError = String(body.error ?? `HTTP ${response.status}`);
      throw new OzonUnavailableError(this.lastError);
    }
    this.lastOkAt = Date.now();
    this.lastError = null;
    return body as T;
  }

  async bySku(sku: string): Promise<OzonProduct | null> {
    const raw = await this.call<AgentProduct | null>(`/product/${encodeURIComponent(sku)}`);
    return raw ? toProduct(raw) : null;
  }

  async search(query: string, limit = 12): Promise<OzonProduct[]> {
    const raw = await this.call<{ items: AgentProduct[] }>(
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    return (raw?.items ?? [])
      .map((item) => toProduct({ ...item, available: true, cardPrice: null }))
      .filter((p): p is OzonProduct => p !== null);
  }

  /** Состояние сессии браузера агента. */
  async session(): Promise<OzonAgentStatus | null> {
    try {
      const raw = await this.call<{ browser: OzonAgentStatus }>("/health", 10_000);
      return raw?.browser ?? null;
    } catch {
      return null;
    }
  }

  /** Просит агента заново проверить сессию (после того как человек прошёл капчу). */
  async checkSession(): Promise<OzonAgentStatus | null> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/session/check`, { method: "POST", signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new OzonUnavailableError((error as Error).message);
    }
    const body = (await response.json().catch(() => ({}))) as OzonAgentStatus & { error?: string };
    if (!response.ok) throw new OzonUnavailableError(body.error ?? `HTTP ${response.status}`);
    this.lastError = body.session === "ready" ? null : (this.lastError ?? body.lastTitle);
    return body;
  }

  /** Скриншот окна браузера агента (PNG) — что сейчас видит «человек». */
  async screenshot(): Promise<Buffer | null> {
    try {
      const response = await fetch(`${this.base}/session/screenshot`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Адрес noVNC внутри docker-сети — приложение проксирует его наружу. */
  get vncBase(): string {
    return this.base.replace(/:\d+$/, ":6080");
  }

  status() {
    return [
      {
        host: "ozon.ru (агент)",
        state: this.lastError ? ("degraded" as const) : ("ok" as const),
        lastStatus: null,
        lastOkAt: this.lastOkAt,
        lastError: this.lastError,
      },
    ];
  }

  overallState(): "ok" | "degraded" {
    return this.lastError ? "degraded" : "ok";
  }
}

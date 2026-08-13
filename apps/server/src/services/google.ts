// Клиент Google Sheets на сервисном аккаунте.
//
// Приложение не создаёт таблицы и не раздаёт права: у сервисных аккаунтов
// Google нет собственного места на Диске, и создание файла упирается в
// «storage quota exceeded». Таблицу заводит сам пользователь и выдаёт
// сервисному аккаунту доступ на редактирование — приложение только читает
// структуру и дописывает строки.
//
// Библиотека googleapis сюда не тянется намеренно: нужно несколько вызовов
// обычным HTTPS плюс подпись JWT средствами node:crypto, а зависимость весом в
// десятки мегабайт пришлось бы тащить в образ и обновлять.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
// Нужны только таблицы: файлы приложение не создаёт и правами не управляет.
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export class GoogleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
  }
}

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Интерфейс, который подменяется в тестах: сеть до Google там не нужна. */
export interface GoogleApi {
  /** Почта сервисного аккаунта: её пользователь указывает, открывая доступ к своей таблице. */
  readonly email: string;
  /** Название, листы и локаль таблицы. Заодно проверка, что доступ выдан. */
  describe(spreadsheetId: string): Promise<{
    title: string;
    url: string;
    locale: string;
    sheets: Array<{ id: number; title: string }>;
  }>;
  /** Перезапись прямоугольника значений. Для листов-витрин, которые считаются заново. */
  writeRange(spreadsheetId: string, range: string, rows: Array<Array<string | number | null>>): Promise<void>;
  /** Оформление листа: закрепление, ширины колонок, высоты строк, жирная шапка. */
  formatSheet(spreadsheetId: string, requests: unknown[]): Promise<void>;
  /** Первая строка листа: по ней видно, проставлены ли уже заголовки. */
  firstRow(spreadsheetId: string, sheet: string): Promise<string[]>;
  ensureSheets(spreadsheetId: string, sheets: string[]): Promise<void>;
  appendRows(spreadsheetId: string, sheet: string, rows: Array<Array<string | number | null>>): Promise<number>;
  clearSheet(spreadsheetId: string, sheet: string): Promise<void>;
}

export class GoogleSheetsApi implements GoogleApi {
  private token: { value: string; expiresAt: number } | null = null;
  readonly email: string;

  constructor(private readonly account: ServiceAccount) {
    this.email = account.client_email;
  }

  /** Токен живёт час; берём с запасом в минуту, чтобы не попасть на границу. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.account.client_email,
      scope: SCOPES,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    };
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.account.private_key);
    const assertion = `${unsigned}.${base64url(signature)}`;

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !body.access_token) {
      throw new GoogleError(response.status, `не удалось получить токен Google: ${body.error_description ?? response.status}`);
    }

    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${response.status}`;
      throw new GoogleError(response.status, message);
    }
    return body as T;
  }

  async describe(spreadsheetId: string) {
    const meta = await this.call<{
      properties?: { title?: string; locale?: string };
      spreadsheetUrl?: string;
      sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
    }>(
      `${SHEETS_API}/${spreadsheetId}?fields=properties(title,locale),spreadsheetUrl,sheets.properties(sheetId,title)`,
      { method: "GET" },
    );
    return {
      title: meta.properties?.title ?? "",
      locale: meta.properties?.locale ?? "en_US",
      url: meta.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      sheets: (meta.sheets ?? [])
        .map((sheet) => ({ id: sheet.properties?.sheetId ?? 0, title: sheet.properties?.title ?? "" }))
        .filter((sheet) => sheet.title),
    };
  }

  async writeRange(
    spreadsheetId: string,
    range: string,
    rows: Array<Array<string | number | null>>,
  ): Promise<void> {
    await this.call(
      `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: JSON.stringify({ values: rows }) },
    );
  }

  async formatSheet(spreadsheetId: string, requests: unknown[]): Promise<void> {
    if (requests.length === 0) return;
    await this.call(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
  }

  async firstRow(spreadsheetId: string, sheet: string): Promise<string[]> {
    const range = encodeURIComponent(`${sheet}!A1:Z1`);
    const data = await this.call<{ values?: string[][] }>(`${SHEETS_API}/${spreadsheetId}/values/${range}`, {
      method: "GET",
    });
    return data.values?.[0] ?? [];
  }

  /** Досоздаёт недостающие листы: таблицу мог править человек. */
  async ensureSheets(spreadsheetId: string, sheets: string[]): Promise<void> {
    const meta = await this.describe(spreadsheetId);
    const existing = new Set(meta.sheets.map((sheet) => sheet.title));
    const missing = sheets.filter((name) => !existing.has(name));
    if (missing.length === 0) return;

    await this.call(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      }),
    });
  }

  async appendRows(spreadsheetId: string, sheet: string, rows: Array<Array<string | number | null>>): Promise<number> {
    if (rows.length === 0) return 0;
    const range = encodeURIComponent(`${sheet}!A1`);
    await this.call(`${SHEETS_API}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values: rows }),
    });
    return rows.length;
  }

  async clearSheet(spreadsheetId: string, sheet: string): Promise<void> {
    const range = encodeURIComponent(sheet);
    await this.call(`${SHEETS_API}/${spreadsheetId}/values/${range}:clear`, { method: "POST", body: "{}" });
  }
}

/** Читает сервисный аккаунт из переменной окружения: JSON целиком или путь к файлу. */
export function loadServiceAccount(raw: string | undefined): ServiceAccount | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    // ключ удобнее монтировать файлом, чем городить многострочную переменную
    const json = value.startsWith("{") ? value : readFileSync(value, "utf8");
    const parsed = JSON.parse(json) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) throw new Error("нет client_email или private_key");
    // в переменных окружения переводы строк часто приезжают экранированными
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    return parsed;
  } catch (error) {
    throw new Error(`Не удалось прочитать ключ сервисного аккаунта Google: ${(error as Error).message}`);
  }
}

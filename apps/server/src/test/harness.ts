// Тестовая база: настоящий Postgres, скомпилированный в WASM (PGlite).
// Позволяет прогонять миграции и SQL планировщика без контейнеров и без того,
// чтобы у разработчика вообще был установлен Postgres.

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { WbUnavailableError } from "@watcher/wb-core";
import type { WbProduct } from "@watcher/wb-core";
import { setDb, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder });
  setDb(db);
  return { db, close: () => client.close() };
}

/**
 * Подставной клиент WB: отдаёт заранее заданные снимки. Тесты про поведение
 * трекера не должны зависеть от того, что сейчас происходит на Wildberries.
 */
export class FakeWb {
  private catalogue = new Map<string, WbProduct>();
  private sellerCatalogue = new Map<number, WbProduct[]>();
  calls = { detailBatch: 0, sellerCatalog: 0 };
  /** Когда выставлено, клиент ведёт себя как WB, упёршийся в лимит. */
  throttled: string | null = null;

  private guard(): void {
    if (this.throttled) throw new WbUnavailableError(this.throttled, 5000);
  }

  set(product: WbProduct): void {
    this.catalogue.set(String(product.nm), product);
  }

  setSellerCatalog(supplierId: number, products: WbProduct[]): void {
    this.sellerCatalogue.set(supplierId, products);
    for (const product of products) this.set(product);
  }

  async detailBatch(nms: Array<number | string>): Promise<WbProduct[]> {
    this.guard();
    this.calls.detailBatch += 1;
    return nms.map((nm) => this.catalogue.get(String(nm))).filter((p): p is WbProduct => Boolean(p));
  }

  /** Выдача по конкретной фразе; порядок важен — из него берётся позиция. */
  private searchResults = new Map<string, WbProduct[]>();

  setSearchResults(phrase: string, products: WbProduct[]): void {
    this.searchResults.set(phrase.toLowerCase(), products);
    for (const product of products) this.set(product);
  }

  async search(query: string, limit = 24): Promise<WbProduct[]> {
    this.guard();
    const prepared = this.searchResults.get(query.toLowerCase());
    if (prepared) return prepared.slice(0, limit);
    return [...this.catalogue.values()].slice(0, limit);
  }

  async detail(nm: number | string): Promise<WbProduct | null> {
    this.guard();
    return this.catalogue.get(String(nm)) ?? null;
  }

  async fullProduct(nm: number | string): Promise<WbProduct | null> {
    return this.detail(nm);
  }

  async seller(supplierId: number | string) {
    return {
      supplierId: Number(supplierId),
      name: "ТРЕЙД АП",
      fullName: 'ООО "ТРЕЙД АП"',
      inn: "7701234567",
      trademark: "TradeUp",
      legalAddress: null,
    };
  }

  async sellerCatalogPage(supplierId: number | string, page = 1) {
    this.guard();
    const products = this.sellerCatalogue.get(Number(supplierId)) ?? [];
    return { products: page === 1 ? products : [], total: products.length };
  }

  /** Каталог, обход которого оборвался: список неполный. */
  setSellerCatalogIncomplete(supplierId: number, products: WbProduct[]): void {
    this.sellerCatalogue.set(supplierId, products);
    this.incomplete.add(supplierId);
    for (const product of products) this.set(product);
  }

  private incomplete = new Set<number>();

  async sellerCatalogAll(supplierId: number | string) {
    this.guard();
    this.calls.sellerCatalog += 1;
    const id = Number(supplierId);
    const products = this.sellerCatalogue.get(id) ?? [];
    const complete = !this.incomplete.has(id);
    return { products, total: products.length, pagesFetched: 1, truncated: false, complete };
  }

  hostStatuses() {
    return [];
  }

  activeDetailHost() {
    return "card.wb.ru";
  }

  overallState() {
    return "ok" as const;
  }
}

/** Подставной Google: запоминает всё, что в него написали, вместо похода в сеть. */
export class FakeGoogle {
  readonly email = "watcher@example.iam.gserviceaccount.com";
  spreadsheets = new Map<string, Map<string, Array<Array<string | number | null>>>>();
  /** Когда выставлено, любой вызов падает — так проверяется обработка отказа. */
  failWith: Error | null = null;

  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  async describe(spreadsheetId: string) {
    this.guard();
    const book = this.spreadsheets.get(spreadsheetId);
    if (!book) throw new Error(`нет доступа к таблице ${spreadsheetId}`);
    return {
      title: this.titles.get(spreadsheetId) ?? "таблица",
      locale: "ru_RU",
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      sheets: [...book.keys()].map((title, index) => ({ id: index + 1, title })),
    };
  }

  /** Значения, записанные перезаписью диапазона (витрины). */
  written = new Map<string, Array<Array<string | number | null>>>();
  formatted: string[] = [];

  async writeRange(spreadsheetId: string, range: string, rows: Array<Array<string | number | null>>) {
    this.guard();
    const sheet = range.split("!")[0]!;
    this.written.set(`${spreadsheetId}:${sheet}`, rows);
    const book = this.spreadsheets.get(spreadsheetId);
    if (book) book.set(sheet, rows);
  }

  async formatSheet(spreadsheetId: string, requests: unknown[]) {
    this.guard();
    if (requests.length > 0) this.formatted.push(spreadsheetId);
  }

  async firstRow(spreadsheetId: string, sheet: string) {
    this.guard();
    const rows = this.spreadsheets.get(spreadsheetId)?.get(sheet) ?? [];
    return (rows[0] ?? []).map(String);
  }

  /** Таблица, созданная «пользователем»: доступ у сервисного аккаунта уже есть. */
  addExistingSpreadsheet(spreadsheetId: string, sheets: string[] = []): void {
    this.spreadsheets.set(spreadsheetId, new Map(sheets.map((name) => [name, []])));
  }

  titles = new Map<string, string>();

  async ensureSheets(spreadsheetId: string, sheets: string[]) {
    this.guard();
    const book = this.spreadsheets.get(spreadsheetId);
    if (!book) throw new Error(`нет таблицы ${spreadsheetId}`);
    for (const name of sheets) if (!book.has(name)) book.set(name, []);
  }

  async appendRows(spreadsheetId: string, sheet: string, rows: Array<Array<string | number | null>>) {
    this.guard();
    const book = this.spreadsheets.get(spreadsheetId);
    if (!book) throw new Error(`нет таблицы ${spreadsheetId}`);
    const existing = book.get(sheet) ?? [];
    book.set(sheet, [...existing, ...rows]);
    return rows.length;
  }

  async clearSheet(spreadsheetId: string, sheet: string) {
    this.guard();
    this.spreadsheets.get(spreadsheetId)?.set(sheet, []);
  }

  /** Строки листа без строки заголовков. */
  rows(spreadsheetId: string, sheet: string): Array<Array<string | number | null>> {
    return (this.spreadsheets.get(spreadsheetId)?.get(sheet) ?? []).slice(1);
  }
}

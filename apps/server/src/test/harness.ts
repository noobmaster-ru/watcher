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

  async search(query: string, limit = 24): Promise<WbProduct[]> {
    this.guard();
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

  overallState() {
    return "ok" as const;
  }
}

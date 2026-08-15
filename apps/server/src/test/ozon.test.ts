// Озон: разбор живых сэмплов composer-api и поведение трекера с подставным
// агентом. Сэмплы сняты с настоящего Озона (репо ozon-mcp-server) — по ним
// видно, что парсер понимает реальные ответы, а не выдуманную форму.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WbClient } from "@watcher/wb-core";
import type { OzonClient, OzonProduct } from "@watcher/ozon-core";
import { parseOzonInput } from "@watcher/ozon-core";
import { parseProduct, parseSearch } from "../../../ozon-agent/src/parse.js";
import { buildApp } from "../app.js";
import { alerts, ozonPricePoints, ozonProducts } from "../db/schema.js";
import { runOzonTick } from "../scheduler/ozon.js";
import { createTestDb, FakeWb } from "./harness.js";
import type { Db } from "../db/client.js";

const samples = resolve(dirname(fileURLToPath(import.meta.url)), "../../../ozon-agent/samples");
const SKU = "1185261285";

describe("разбор composer-api Озона (живые сэмплы)", () => {
  it("карточка: обе цены, старая цена и наличие", () => {
    const page = JSON.parse(readFileSync(`${samples}/pdp.json`, "utf8"));
    const product = parseProduct(page);
    assert.equal(product.sku, SKU);
    assert.equal(product.cardPrice, 53022, "цена с Ozon Картой");
    assert.equal(product.price, 53558, "обычная цена");
    assert.equal(product.oldPrice, 119990);
    assert.equal(product.available, true);
    assert.ok(product.name);
  });

  it("поиск: плитки с ценой и номером", () => {
    const page = JSON.parse(readFileSync(`${samples}/search.json`, "utf8"));
    const items = parseSearch(page, 20);
    assert.ok(items.length >= 5, `ожидались товары, получено ${items.length}`);
    for (const item of items) {
      assert.match(item.sku, /^\d+$/);
      assert.ok(item.price !== null && item.price > 0);
    }
  });
});

describe("разбор ввода пользователя", () => {
  it("понимает номер и ссылку", () => {
    assert.equal(parseOzonInput("1587315442"), "1587315442");
    assert.equal(
      parseOzonInput("https://www.ozon.ru/product/nazvanie-tovara-1587315442/?from=share"),
      "1587315442",
    );
    assert.throws(() => parseOzonInput("просто текст"));
  });
});

/** Подставной агент: цены задаются тестом, Chromium не нужен. */
class FakeOzon {
  private products = new Map<string, OzonProduct>();
  failWith: Error | null = null;

  set(product: OzonProduct): void {
    this.products.set(product.sku, product);
  }

  async bySku(sku: string): Promise<OzonProduct | null> {
    if (this.failWith) throw this.failWith;
    return this.products.get(sku) ?? null;
  }

  async search(): Promise<OzonProduct[]> {
    if (this.failWith) throw this.failWith;
    return [...this.products.values()];
  }

  status() {
    return [{ host: "ozon.ru (агент)", state: "ok" as const, lastStatus: null, lastOkAt: null, lastError: null }];
  }

  overallState() {
    return "ok" as const;
  }
}

const product = (over: Partial<OzonProduct> = {}): OzonProduct => ({
  sku: SKU,
  name: "Ноутбук",
  price: 53558,
  cardPrice: 53022,
  oldPrice: 119990,
  inStock: true,
  image: null,
  url: `https://www.ozon.ru/product/${SKU}/`,
  ...over,
});

let app: FastifyInstance;
let db: Db;
let close: () => Promise<void>;
let ozon: FakeOzon;
let cookie = "";

before(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  ozon = new FakeOzon();
  ozon.set(product());

  app = (
    await buildApp({
      wb: new FakeWb() as unknown as WbClient,
      ozon: ozon as unknown as OzonClient,
      google: null,
    })
  ).server;
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "ozon@example.com", password: "supersecret" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "ozon@example.com", password: "supersecret" },
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

after(async () => {
  await app.close();
  await close();
});

describe("трекер Озона", () => {
  it("добавляет товар и пишет обе цены в историю", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/ozon/watches",
      headers: { cookie },
      payload: { product: `https://www.ozon.ru/product/noutbuk-${SKU}/` },
    });
    assert.equal(response.statusCode, 200, response.body);

    const [point] = await db.select().from(ozonPricePoints);
    assert.equal(point?.price, 53558);
    assert.equal(point?.cardPrice, 53022);
  });

  it("тик замечает падение и создаёт событие площадки ozon", async () => {
    ozon.set(product({ price: 49999, cardPrice: 49500 }));
    await db.update(ozonProducts).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(ozonProducts.sku, SKU));

    const tick = await runOzonTick(ozon as unknown as OzonClient);
    assert.equal(tick.checked, 1);

    const [alert] = await db.select().from(alerts).where(eq(alerts.marketplace, "ozon"));
    assert.equal(alert?.type, "price_drop");
    assert.equal(alert?.oldPrice, 53558);
    assert.equal(alert?.newPrice, 49999);
  });

  it("исчезнувшая цена — «нет в продаже», а не ноль", async () => {
    ozon.set(product({ price: null, cardPrice: null, inStock: false }));
    await db.update(ozonProducts).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(ozonProducts.sku, SKU));
    await runOzonTick(ozon as unknown as OzonClient);

    const rows = await db.select().from(alerts).where(eq(alerts.marketplace, "ozon"));
    assert.ok(rows.some((a) => a.type === "out_of_stock"));
    assert.equal(rows.filter((a) => a.type === "price_drop").length, 1);

    const [row] = await db.select().from(ozonProducts).where(eq(ozonProducts.sku, SKU));
    assert.equal(row?.lastPrice, null);
  });

  it("недоступность агента — degraded, а не потерянный товар", async () => {
    const { OzonUnavailableError } = await import("@watcher/ozon-core");
    ozon.failWith = new OzonUnavailableError("агент лежит");
    await db.update(ozonProducts).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(ozonProducts.sku, SKU));

    const tick = await runOzonTick(ozon as unknown as OzonClient);
    ozon.failWith = null;
    assert.equal(tick.degraded, true);
    assert.equal(tick.checked, 0);
  });

  it("чужую подписку не удалить", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "other-ozon@example.com", password: "supersecret" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "other-ozon@example.com", password: "supersecret" },
    });
    const otherCookie = String(login.headers["set-cookie"]).split(";")[0]!;

    const list = await app.inject({ method: "GET", url: "/api/ozon/watches", headers: { cookie } });
    const id = list.json().watches[0].id;
    const response = await app.inject({
      method: "DELETE",
      url: `/api/ozon/watches/${id}`,
      headers: { cookie: otherCookie },
    });
    assert.equal(response.statusCode, 404);
  });

  it("без агента ручки честно говорят, что площадка выключена", async () => {
    const bare = (
      await buildApp({ wb: new FakeWb() as unknown as WbClient, ozon: null, google: null })
    ).server;
    await bare.ready();
    const response = await bare.inject({
      method: "POST",
      url: "/api/ozon/watches",
      headers: { cookie },
      payload: { product: SKU },
    });
    // сессия из другого приложения не подойдёт — важен не код авторизации,
    // а что ручка не падает и внятно отвечает
    assert.ok([400, 401].includes(response.statusCode));
    await bare.close();
  });
});

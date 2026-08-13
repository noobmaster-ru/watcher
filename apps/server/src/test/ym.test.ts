// Отслеживание цен Яндекс Маркета: разбор микроразметки и поведение трекера.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WbClient } from "@watcher/wb-core";
import type { YmClient, YmProduct } from "@watcher/ym-core";
import { looksLikeSku, parseInput, parseSearch, parseSkuFromCard } from "@watcher/ym-core";
import { buildApp } from "../app.js";
import { alerts, ymPricePoints, ymProducts } from "../db/schema.js";
import { runYmTick } from "../scheduler/ym.js";
import { createTestDb, FakeWb } from "./harness.js";
import type { Db } from "../db/client.js";

const SKU = "103522724497";

/** Страница поиска в том виде, в каком её отдаёт Маркет. */
function searchHtml(products: Array<{ sku: string; name: string; price: number | null; inStock?: boolean }>): string {
  const list = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: products.map((p, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "Product",
        name: p.name,
        sku: p.sku,
        image: `https://avatars.mds.yandex.net/${p.sku}/orig`,
        url: `https://market.yandex.ru/card/tovar/${p.sku}`,
        offers:
          p.price === null
            ? { "@type": "Offer", availability: "https://schema.org/OutOfStock" }
            : {
                "@type": "Offer",
                availability: `https://schema.org/${p.inStock === false ? "OutOfStock" : "InStock"}`,
                price: p.price,
                priceCurrency: "RUB",
              },
      },
    })),
  };
  return `<html><script type="application/ld+json">${JSON.stringify(list)}</script></html>`;
}

/** Подставной Маркет: отдаёт заранее заданные цены, в сеть не ходит. */
class FakeYm {
  private prices = new Map<string, YmProduct>();
  calls = 0;
  failWith: Error | null = null;

  set(product: YmProduct): void {
    this.prices.set(product.sku, product);
  }

  async search(query: string): Promise<YmProduct[]> {
    if (this.failWith) throw this.failWith;
    return [...this.prices.values()].filter((p) => p.sku === query || p.name?.includes(query));
  }

  async bySku(sku: string): Promise<YmProduct | null> {
    if (this.failWith) throw this.failWith;
    this.calls += 1;
    return this.prices.get(sku) ?? null;
  }

  async resolveSku(input: string): Promise<string> {
    const match = input.match(/(\d{6,16})/);
    if (!match) throw new Error("Нужен номер товара Яндекс Маркета или ссылка на его карточку");
    return match[1]!;
  }

  status() {
    return [{ host: "market.yandex.ru", state: "ok" as const, lastStatus: 200, blockedForMs: 0 }];
  }

  overallState() {
    return "ok" as const;
  }
}

const product = (over: Partial<YmProduct> = {}): YmProduct => ({
  sku: SKU,
  name: "Набор шампуров 5 шт",
  price: 800,
  oldPrice: null,
  inStock: true,
  image: "https://avatars.mds.yandex.net/x/orig",
  url: `https://market.yandex.ru/card/tovar/${SKU}`,
  description: null,
  ...over,
});

describe("разбор микроразметки Маркета", () => {
  it("достаёт цену, наличие и номер товара", () => {
    const items = parseSearch(searchHtml([{ sku: SKU, name: "Набор шампуров", price: 788 }]));
    assert.equal(items.length, 1);
    assert.equal(items[0]?.sku, SKU);
    assert.equal(items[0]?.price, 788);
    assert.equal(items[0]?.inStock, true);
  });

  it("товар без предложения получает цену null, а не ноль", () => {
    const items = parseSearch(searchHtml([{ sku: SKU, name: "Нет в продаже", price: null }]));
    assert.equal(items[0]?.price, null);
    assert.equal(items[0]?.inStock, false);
  });

  it("не спотыкается о битый блок разметки", () => {
    const html = `<script type="application/ld+json">{сломано</script>${searchHtml([{ sku: SKU, name: "Товар", price: 100 }])}`;
    assert.equal(parseSearch(html).length, 1);
  });

  it("находит номер товара на странице карточки", () => {
    assert.equal(parseSkuFromCard(`{"productId":1,"sku":"${SKU}","x":2}`), SKU);
    assert.equal(parseSkuFromCard("<html>без номера</html>"), null);
  });

  it("различает номер и ссылку", () => {
    assert.deepEqual(parseInput(SKU), { kind: "sku", sku: SKU });
    assert.equal(parseInput("https://market.yandex.ru/card/tovar/102097399814").kind, "url");
    assert.throws(() => parseInput("просто текст"));
    assert.equal(looksLikeSku("12345"), false, "слишком короткое — не номер");
  });
});

let app: FastifyInstance;
let db: Db;
let close: () => Promise<void>;
let ym: FakeYm;
let cookie = "";

before(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  ym = new FakeYm();
  ym.set(product());

  app = (
    await buildApp({
      wb: new FakeWb() as unknown as WbClient,
      ym: ym as unknown as YmClient,
      google: null,
    })
  ).server;
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "ym@example.com", password: "supersecret" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "ym@example.com", password: "supersecret" },
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

after(async () => {
  await app.close();
  await close();
});

describe("отслеживание товара Маркета", () => {
  it("добавляется по номеру и сразу пишет первую точку", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/ym/watches",
      headers: { cookie },
      payload: { product: SKU },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().sku, SKU);

    const [row] = await db.select().from(ymProducts).where(eq(ymProducts.sku, SKU));
    assert.equal(row?.lastPrice, 800);
    assert.equal(row?.isTracked, true);

    const points = await db.select().from(ymPricePoints);
    assert.equal(points.length, 1);
  });

  it("добавляется по ссылке на карточку", async () => {
    ym.set(product({ sku: "900000000123", name: "Другой товар", price: 500 }));
    const response = await app.inject({
      method: "POST",
      url: "/api/ym/watches",
      headers: { cookie },
      payload: { product: "https://market.yandex.ru/card/tovar/900000000123" },
    });
    assert.equal(response.statusCode, 200, response.body);
  });

  it("тик планировщика замечает снижение цены", async () => {
    ym.set(product({ price: 700 }));
    await db.update(ymProducts).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(ymProducts.sku, SKU));

    const tick = await runYmTick(ym as unknown as YmClient);
    assert.ok(tick.checked >= 1);

    const [alert] = await db.select().from(alerts).where(eq(alerts.marketplace, "ym"));
    assert.equal(alert?.type, "price_drop");
    assert.equal(alert?.oldPrice, 800);
    assert.equal(alert?.newPrice, 700);
  });

  it("исчезнувшая цена — это «нет в продаже», а не падение до нуля", async () => {
    ym.set(product({ price: null, inStock: false }));
    await db.update(ymProducts).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(ymProducts.sku, SKU));
    await runYmTick(ym as unknown as YmClient);

    const rows = await db.select().from(alerts).where(eq(alerts.marketplace, "ym"));
    assert.ok(rows.some((a) => a.type === "out_of_stock"));
    assert.equal(rows.filter((a) => a.type === "price_drop").length, 1, "второго падения быть не должно");

    const [row] = await db.select().from(ymProducts).where(eq(ymProducts.sku, SKU));
    assert.equal(row?.lastPrice, null);
    assert.equal(row?.lastInStock, false);
  });

  it("история отдаётся с минимумом и максимумом", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/ym/product/${SKU}/history?range=30d`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.points.length >= 2);
    assert.equal(body.stats.min, 700);
    assert.equal(body.stats.max, 800);
  });

  it("мусор вместо номера даёт 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/ym/watches",
      headers: { cookie },
      payload: { product: "совсем не номер" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("чужую подписку не удалить", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "other-ym@example.com", password: "supersecret" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "other-ym@example.com", password: "supersecret" },
    });
    const otherCookie = String(login.headers["set-cookie"]).split(";")[0]!;

    const list = await app.inject({ method: "GET", url: "/api/ym/watches", headers: { cookie } });
    const id = list.json().watches[0].id;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/ym/watches/${id}`,
      headers: { cookie: otherCookie },
    });
    assert.equal(response.statusCode, 404);
  });
});

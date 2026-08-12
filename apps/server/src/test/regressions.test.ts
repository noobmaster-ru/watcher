// Тесты на дефекты, найденные ревью. Каждый воспроизводит конкретный сбой,
// который уже случился бы в проде.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WbClient } from "@watcher/wb-core";
import { buildApp } from "../app.js";
import { alerts, products, sellerProducts, watches } from "../db/schema.js";
import { runPriceTick } from "../scheduler/prices.js";
import { syncSellerCatalog, watchSeller } from "../services/watches.js";
import { createTestDb, FakeWb } from "./harness.js";
import { makeProduct } from "./fixtures.js";
import type { Db } from "../db/client.js";

const SUPPLIER = 777;
const NM = 900000001;

let app: FastifyInstance;
let db: Db;
let close: () => Promise<void>;
let wb: FakeWb;
let cookie = "";

const priced = (nm: number, value: number) =>
  makeProduct({
    nm: String(nm),
    supplierId: SUPPLIER,
    price: { product: value, basic: 3000, cashback: null, min: value, max: value, pricedSizes: 1 },
  });

before(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  wb = new FakeWb();
  const built = await buildApp({ wb: wb as unknown as WbClient });
  app = built.server;
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "reg@example.com", password: "supersecret" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "reg@example.com", password: "supersecret" },
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

after(async () => {
  await app.close();
  await close();
});

describe("потеря событий (applySnapshot)", () => {
  it("синхронизация каталога не съедает изменение цены", async () => {
    wb.setSellerCatalog(SUPPLIER, [priced(NM, 1633), priced(900000002, 500)]);
    await watchSeller(wb as unknown as WbClient, { userId: 1, kind: "seller", supplierId: SUPPLIER });

    // цена упала, и первым это увидел обход каталога, а не тик цен
    wb.setSellerCatalog(SUPPLIER, [priced(NM, 900), priced(900000002, 500)]);
    await syncSellerCatalog(wb as unknown as WbClient, SUPPLIER, { announceNew: true });

    const drops = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.nm, NM), eq(alerts.type, "price_drop")));
    assert.equal(drops.length, 1, "падение цены, замеченное каталогом, должно давать уведомление");
    assert.equal(drops[0]?.oldPrice, 1633);
    assert.equal(drops[0]?.newPrice, 900);
  });

  it("просмотр карточки не съедает изменение цены", async () => {
    wb.set(priced(900000002, 400)); // было 500

    const response = await app.inject({ method: "GET", url: "/api/product/900000002", headers: { cookie } });
    assert.equal(response.statusCode, 200);

    const drops = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.nm, 900000002), eq(alerts.type, "price_drop")));
    assert.equal(drops.length, 1, "цена, увиденная при открытии карточки, должна доходить до подписчиков");
  });

  it("сбой на одном товаре не уносит уведомления по остальным", async () => {
    wb.setSellerCatalog(SUPPLIER, [priced(NM, 800), priced(900000002, 300)]);
    // ломаем один товар: количество не влезает в integer
    const broken = priced(900000003, 700);
    broken.totalQuantity = 3_000_000_000;
    wb.set(broken);
    await db.insert(products).values({ nm: 900000003, supplierId: SUPPLIER, lastPrice: 1000, lastInStock: true, isTracked: true });

    await db.update(products).set({ nextCheckAt: new Date(Date.now() - 60_000) });
    const before = await db.select().from(alerts);
    await runPriceTick(wb as unknown as WbClient);
    const after = await db.select().from(alerts);

    assert.ok(after.length > before.length, "уведомления по исправным товарам должны сохраниться");
  });
});

describe("неполный каталог продавца", () => {
  it("оборванный обход не снимает товары с продажи", async () => {
    const activeBefore = await db
      .select()
      .from(sellerProducts)
      .where(and(eq(sellerProducts.supplierId, SUPPLIER), eq(sellerProducts.isActive, true)));

    // WB отдал ровно 100 товаров и оборвался — обход неполный
    wb.setSellerCatalogIncomplete(SUPPLIER, [priced(NM, 800)]);
    const sync = await syncSellerCatalog(wb as unknown as WbClient, SUPPLIER, { announceNew: true });

    assert.equal(sync.removed, 0, "при неполном обходе снимать товары нельзя");
    const activeAfter = await db
      .select()
      .from(sellerProducts)
      .where(and(eq(sellerProducts.supplierId, SUPPLIER), eq(sellerProducts.isActive, true)));
    assert.equal(activeAfter.length, activeBefore.length);
  });
});

describe("валидация запросов", () => {
  it("мусор вместо артикула даёт 400, а не 500", async () => {
    for (const url of ["/api/product/abc/history", "/api/seller/abc/products", "/api/seller/abc/tracked"]) {
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      assert.equal(response.statusCode, 400, `${url} должен отвечать 400`);
    }
  });

  it("пустое тело PATCH даёт 400, а не 500", async () => {
    const list = await app.inject({ method: "GET", url: "/api/watches", headers: { cookie } });
    const id = list.json().watches[0].id;

    for (const payload of [{}, { неизвестное: 1 }]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/watches/${id}`,
        headers: { cookie },
        payload,
      });
      assert.equal(response.statusCode, 400, "изменение без полей должно быть понятной ошибкой");
    }
  });

  it("unreadOnly=false не включает фильтр непрочитанного", async () => {
    await db.update(alerts).set({ readAt: new Date() });

    const all = await app.inject({ method: "GET", url: "/api/alerts?unreadOnly=false", headers: { cookie } });
    const unread = await app.inject({ method: "GET", url: "/api/alerts?unreadOnly=true", headers: { cookie } });

    assert.ok(all.json().alerts.length > 0, "unreadOnly=false должен вернуть все события");
    assert.equal(unread.json().alerts.length, 0);
  });

  it("дробные id событий отсекаются валидацией", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/alerts/read",
      headers: { cookie },
      payload: { ids: [1.5] },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe("подписка на продавца", () => {
  it("смена интервала применяется ко всем товарам каталога", async () => {
    const [watch] = await db.select().from(watches).where(eq(watches.kind, "seller"));

    const response = await app.inject({
      method: "PATCH",
      url: `/api/watches/${watch!.id}`,
      headers: { cookie },
      payload: { intervalMin: 15 },
    });
    assert.equal(response.statusCode, 200);

    // сверяем только товары из каталога продавца: 900000003 добавлен в тесте выше
    // напрямую в products и в seller_products не входит
    const rows = await db
      .select({ nm: products.nm, interval: products.checkIntervalMin })
      .from(sellerProducts)
      .innerJoin(products, eq(products.nm, sellerProducts.nm))
      .where(and(eq(sellerProducts.supplierId, SUPPLIER), eq(sellerProducts.isActive, true)));

    assert.ok(rows.length > 0);
    assert.ok(
      rows.every((r) => r.interval === 15),
      `новый интервал должен доехать до товаров продавца, получено ${JSON.stringify(rows)}`,
    );
  });
});

describe("список подписок", () => {
  it("отдаёт ссылку на картинку с правильного шарда CDN", async () => {
    wb.set(priced(242678284, 1633));
    await app.inject({
      method: "POST",
      url: "/api/watches",
      headers: { cookie },
      payload: { kind: "product", product: "242678284" },
    });

    const response = await app.inject({ method: "GET", url: "/api/watches", headers: { cookie } });
    const withProduct = response.json().watches.find((w: { nm: number | null }) => w.nm !== null);
    assert.ok(withProduct?.image, "клиенту нужна готовая ссылка: таблицы шардов у него нет");
    assert.match(withProduct.image, /^https:\/\/basket-\d{2}\.wbbasket\.ru\//);
  });
});

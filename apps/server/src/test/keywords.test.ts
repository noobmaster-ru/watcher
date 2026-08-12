// Позиции по ключевым словам и выгрузка в Google Таблицу.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WbClient } from "@watcher/wb-core";
import { buildApp } from "../app.js";
import { keywordPositions, keywords, sellerSnapshots, userSheets } from "../db/schema.js";
import { runKeywordTick } from "../scheduler/keywords.js";
import { exportUser } from "../services/export.js";
import { SHEET_KEYWORDS, SHEET_PRODUCTS, SHEET_SELLERS } from "../services/export.js";
import { createTestDb, FakeGoogle, FakeWb } from "./harness.js";
import { makeProduct } from "./fixtures.js";
import type { Db } from "../db/client.js";
import type { GoogleApi } from "../services/google.js";

const MINE = 900000001;
const PHRASE = "шампуры для шашлыка";

let app: FastifyInstance;
let db: Db;
let close: () => Promise<void>;
let wb: FakeWb;
let google: FakeGoogle;
let cookie = "";

/** Выдача: наш товар на 3-м месте среди чужих. */
function searchResults(minePosition: number) {
  const items = [];
  for (let i = 1; i <= 10; i++) {
    items.push(makeProduct({ nm: String(i === minePosition ? MINE : 800000000 + i), supplierId: 500 + i }));
  }
  return items;
}

before(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  wb = new FakeWb();
  google = new FakeGoogle();

  wb.set(makeProduct({ nm: String(MINE), name: "Шампуры набор", supplierId: 777 }));
  wb.setSellerCatalog(777, [makeProduct({ nm: String(MINE), name: "Шампуры набор", supplierId: 777 })]);
  wb.setSearchResults(PHRASE, searchResults(3));

  app = (await buildApp({ wb: wb as unknown as WbClient, google: google as unknown as GoogleApi })).server;
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "kw@example.com", password: "supersecret" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "kw@example.com", password: "supersecret" },
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;

  await app.inject({
    method: "POST",
    url: "/api/watches",
    headers: { cookie },
    payload: { kind: "product", product: String(MINE) },
  });
});

after(async () => {
  await app.close();
  await close();
});

describe("позиции по ключевым словам", () => {
  it("находит позицию отслеживаемого товара при добавлении запроса", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/keywords",
      headers: { cookie },
      payload: { phrase: PHRASE },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().found, 1);

    const [position] = await db.select().from(keywordPositions);
    assert.equal(position?.nm, MINE);
    assert.equal(position?.position, 3, "товар стоял третьим в выдаче");
    assert.equal(position?.page, 1);
  });

  it("чужие товары в историю не попадают", async () => {
    const rows = await db.select().from(keywordPositions);
    assert.ok(
      rows.every((r) => r.nm === MINE),
      "записывать позиции чужих товаров бессмысленно и дорого",
    );
  });

  it("следующая проверка записывает новую позицию", async () => {
    wb.setSearchResults(PHRASE, searchResults(7));
    await db.update(keywords).set({ nextCheckAt: new Date(Date.now() - 60_000) });

    const tick = await runKeywordTick(wb as unknown as WbClient);
    assert.equal(tick.checked, 1);

    const rows = await db.select().from(keywordPositions).orderBy(keywordPositions.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.position, 7, "позиция ухудшилась — это и есть история");
  });

  it("выпадение из выдачи фиксируется отдельной строкой", async () => {
    wb.setSearchResults(PHRASE, searchResults(0)); // нашего товара в выдаче нет
    await db.update(keywords).set({ nextCheckAt: new Date(Date.now() - 60_000) });
    await runKeywordTick(wb as unknown as WbClient);

    const rows = await db.select().from(keywordPositions).orderBy(keywordPositions.id);
    assert.equal(rows.length, 3);
    assert.equal(rows[2]?.position, null, "выпадение из выдачи — это событие, его надо видеть");
  });

  it("повторное выпадение строк не плодит", async () => {
    const before = (await db.select().from(keywordPositions)).length;
    await db.update(keywords).set({ nextCheckAt: new Date(Date.now() - 60_000) });
    await runKeywordTick(wb as unknown as WbClient);

    const after = (await db.select().from(keywordPositions)).length;
    assert.equal(after, before, "товар и так уже был отмечен выпавшим");
  });

  it("не даёт завести один и тот же запрос дважды", async () => {
    await app.inject({ method: "POST", url: "/api/keywords", headers: { cookie }, payload: { phrase: PHRASE } });
    const list = await app.inject({ method: "GET", url: "/api/keywords", headers: { cookie } });
    assert.equal(list.json().keywords.length, 1);
  });

  it("чужой запрос не виден и не удаляется", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "other-kw@example.com", password: "supersecret" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "other-kw@example.com", password: "supersecret" },
    });
    const otherCookie = String(login.headers["set-cookie"]).split(";")[0]!;

    const [mine] = await db.select().from(keywords);
    const list = await app.inject({ method: "GET", url: "/api/keywords", headers: { cookie: otherCookie } });
    assert.equal(list.json().keywords.length, 0);

    const removal = await app.inject({
      method: "DELETE",
      url: `/api/keywords/${mine!.id}`,
      headers: { cookie: otherCookie },
    });
    assert.equal(removal.statusCode, 404);
  });
});

describe("выгрузка в Google Таблицу", () => {
  it("создаёт таблицу с тремя листами и открывает доступ владельцу", async () => {
    const response = await app.inject({ method: "POST", url: "/api/sheet/export", headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);

    const url = response.json().spreadsheetUrl as string;
    assert.match(url, /^https:\/\/docs\.google\.com\/spreadsheets\//);

    const [state] = await db.select().from(userSheets);
    const book = google.spreadsheets.get(state!.spreadsheetId)!;
    assert.deepEqual([...book.keys()].sort(), [SHEET_KEYWORDS, SHEET_PRODUCTS, SHEET_SELLERS].sort());
    assert.deepEqual(google.shared, [{ spreadsheetId: state!.spreadsheetId, email: "kw@example.com" }]);
  });

  it("пишет историю цен и позиций, каждую строку с датой", async () => {
    const [state] = await db.select().from(userSheets);
    const products = google.rows(state!.spreadsheetId, SHEET_PRODUCTS);
    const positions = google.rows(state!.spreadsheetId, SHEET_KEYWORDS);

    assert.ok(products.length > 0, "история цен должна уехать в таблицу");
    assert.ok(positions.length >= 3, "все замеры позиций должны быть в таблице");
    assert.match(String(products[0]?.[0]), /^\d{4}-\d{2}-\d{2} /);
    assert.equal(Number(products[0]?.[1]), MINE);
    assert.ok(
      positions.some((row) => row[4] === "выпал"),
      "выпадение из выдачи должно быть видно и в таблице",
    );
  });

  it("повторная выгрузка не дублирует уже выгруженное", async () => {
    const [state] = await db.select().from(userSheets);
    const before = google.rows(state!.spreadsheetId, SHEET_PRODUCTS).length;

    await exportUser(google as unknown as GoogleApi, state!.userId);
    const after = google.rows(state!.spreadsheetId, SHEET_PRODUCTS).length;
    assert.equal(after, before, "курсор должен отсекать уже отправленные строки");
  });

  it("дописывает только новые строки", async () => {
    const [state] = await db.select().from(userSheets);
    const before = google.rows(state!.spreadsheetId, SHEET_PRODUCTS).length;

    // цена изменилась — появилась новая точка истории
    wb.set(
      makeProduct({
        nm: String(MINE),
        supplierId: 777,
        price: { product: 999, basic: 3000, cashback: null, min: 999, max: 999, pricedSizes: 1 },
      }),
    );
    await app.inject({ method: "GET", url: `/api/product/${MINE}`, headers: { cookie } });
    await exportUser(google as unknown as GoogleApi, state!.userId);

    const after = google.rows(state!.spreadsheetId, SHEET_PRODUCTS);
    assert.equal(after.length, before + 1);
    assert.equal(Number(after[after.length - 1]?.[5]), 999);
  });

  it("срез по продавцу попадает на свой лист", async () => {
    const [state] = await db.select().from(userSheets);
    await app.inject({
      method: "POST",
      url: "/api/watches",
      headers: { cookie },
      payload: { kind: "seller", seller: "777" },
    });
    await db.insert(sellerSnapshots).values({
      supplierId: 777,
      productCount: 5,
      inStockCount: 4,
      minPrice: 100,
      maxPrice: 900,
      avgPrice: 500,
    });

    await exportUser(google as unknown as GoogleApi, state!.userId);
    const rows = google.rows(state!.spreadsheetId, SHEET_SELLERS);
    assert.ok(rows.length > 0, "срезы по продавцам должны уезжать на лист «Продавцы»");
    assert.equal(Number(rows[rows.length - 1]?.[1]), 777);
  });

  it("отказ Google запоминается и не рушит приложение", async () => {
    const [state] = await db.select().from(userSheets);
    google.failWith = new Error("Google говорит нет");

    await assert.rejects(() => exportUser(google as unknown as GoogleApi, state!.userId));
    google.failWith = null;

    const [after] = await db.select().from(userSheets).where(eq(userSheets.userId, state!.userId));
    assert.match(after?.lastError ?? "", /Google говорит нет/);

    const status = await app.inject({ method: "GET", url: "/api/sheet", headers: { cookie } });
    assert.match(status.json().lastError, /Google говорит нет/);
  });
});

describe("повтор после отказа Wildberries", () => {
  it("повторяет раньше обычного срока, а не позже", async () => {
    const { retryDelayMin } = await import("../services/keywords.js");
    const interval = 360; // шесть часов — обычный интервал проверки

    assert.equal(retryDelayMin(1, interval), 10, "первый повтор — через десять минут");
    assert.equal(retryDelayMin(2, interval), 20);
    assert.equal(retryDelayMin(3, interval), 40);
    assert.ok(
      retryDelayMin(10, interval) <= interval,
      "пауза после отказа не должна превышать обычный интервал: иначе один отказ WB оставляет пользователя без позиций на полдня",
    );
  });

  it("при отказе назначает скорый повтор, а не через сутки", async () => {
    const { markKeywordError } = await import("../services/keywords.js");
    const [keyword] = await db.select().from(keywords);

    await markKeywordError(keyword!.id, 360);
    const [after] = await db.select().from(keywords).where(eq(keywords.id, keyword!.id));

    const waitMin = (after!.nextCheckAt.getTime() - Date.now()) / 60_000;
    assert.ok(waitMin < 30, `повтор должен быть скоро, а не через ${Math.round(waitMin)} мин`);
  });
});

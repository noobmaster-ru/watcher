// Смена почты аккаунта. Почта — это и логин, и адрес, на который открыт доступ
// к Гугл-таблице, поэтому проверяются обе стороны: вход и права в Google.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import type { WbClient } from "@watcher/wb-core";
import { buildApp } from "../app.js";
import { userSheets } from "../db/schema.js";
import { createTestDb, FakeGoogle, FakeWb } from "./harness.js";
import { makeProduct } from "./fixtures.js";
import type { Db } from "../db/client.js";
import type { GoogleApi } from "../services/google.js";

const OLD = "old@example.com";
const NEW = "new@example.com";
const PASSWORD = "supersecret";

let app: FastifyInstance;
let db: Db;
let close: () => Promise<void>;
let google: FakeGoogle;
let cookie = "";

before(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  google = new FakeGoogle();
  const wb = new FakeWb();
  wb.set(makeProduct({ nm: "242678284" }));

  app = (await buildApp({ wb: wb as unknown as WbClient, google: google as unknown as GoogleApi })).server;
  await app.ready();

  await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: OLD, password: PASSWORD } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OLD, password: PASSWORD } });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;

  // таблица создаётся до смены почты — её доступ и должен переехать
  await app.inject({ method: "POST", url: "/api/sheet/export", headers: { cookie } });
});

after(async () => {
  await app.close();
  await close();
});

describe("смена почты", () => {
  it("требует текущий пароль", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/email",
      headers: { cookie },
      payload: { current: "неверный", email: NEW },
    });
    assert.equal(response.statusCode, 401, "иначе аккаунт уводят через открытую вкладку");
  });

  it("отклоняет мусор вместо адреса", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/email",
      headers: { cookie },
      payload: { current: PASSWORD, email: "не-почта" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("не даёт занять чужую почту", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "busy@example.com", password: PASSWORD },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/email",
      headers: { cookie },
      payload: { current: PASSWORD, email: "busy@example.com" },
    });
    assert.equal(response.statusCode, 409);
  });

  it("меняет почту и переоткрывает доступ к таблице", async () => {
    const [sheet] = await db.select().from(userSheets);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/email",
      headers: { cookie },
      payload: { current: PASSWORD, email: NEW },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().sheetUpdated, true);

    const emails = google.shared.filter((s) => s.spreadsheetId === sheet!.spreadsheetId).map((s) => s.email);
    assert.deepEqual(emails, [NEW], "старый адрес не должен сохранять доступ к данным аккаунта");
    assert.equal(google.titles.get(sheet!.spreadsheetId), `watcher — ${NEW}`);
  });

  it("вход теперь по новой почте, по старой — нет", async () => {
    const byNew = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: NEW, password: PASSWORD } });
    const byOld = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OLD, password: PASSWORD } });
    assert.equal(byNew.statusCode, 200);
    assert.equal(byOld.statusCode, 401);
  });

  it("текущая сессия не рвётся", async () => {
    const response = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().user.email, NEW);
  });

  it("отказ Google не отменяет смену почты", async () => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: NEW, password: PASSWORD } });
    const fresh = String(login.headers["set-cookie"]).split(";")[0]!;
    google.failWith = new Error("Drive недоступен");

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/email",
      headers: { cookie: fresh },
      payload: { current: PASSWORD, email: "third@example.com" },
    });
    google.failWith = null;

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sheetUpdated, false);
    assert.match(response.json().sheetError, /Drive недоступен/);

    // почта всё равно сменилась: права поправятся следующей выгрузкой
    const byThird = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "third@example.com", password: PASSWORD },
    });
    assert.equal(byThird.statusCode, 200);
  });
});

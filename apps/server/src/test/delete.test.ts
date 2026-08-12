// Fastify разбирает тело у любого запроса с content-type: application/json,
// включая DELETE. Пустое тело при этом даёт 400 — из-за чего отписка из
// интерфейса не работала бы вовсе. Тест фиксирует обе стороны контракта.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import type { WbClient } from "@watcher/wb-core";
import { buildApp } from "../app.js";
import { createTestDb, FakeWb } from "./harness.js";
import { makeProduct } from "./fixtures.js";

let app: FastifyInstance;
let close: () => Promise<void>;
let cookie = "";
let watchId = 0;

before(async () => {
  const created = await createTestDb();
  close = created.close;
  const wb = new FakeWb();
  wb.set(makeProduct({ nm: "242678284" }));
  app = (await buildApp({ wb: wb as unknown as WbClient })).server;
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "del@example.com", password: "supersecret" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "del@example.com", password: "supersecret" },
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;

  const created2 = await app.inject({
    method: "POST",
    url: "/api/watches",
    headers: { cookie },
    payload: { kind: "product", product: "242678284" },
  });
  const list = await app.inject({ method: "GET", url: "/api/watches", headers: { cookie } });
  watchId = list.json().watches[0].id;
  assert.equal(created2.statusCode, 200);
});

after(async () => {
  await app.close();
  await close();
});

describe("удаление подписки", () => {
  it("DELETE с content-type и пустым телом больше не отвергается", async () => {
    // именно такой запрос слал прежний веб-клиент, и Fastify по умолчанию
    // отвечал на него 400 — теперь пустое тело трактуется как его отсутствие
    const response = await app.inject({
      method: "DELETE",
      url: `/api/watches/${watchId}`,
      headers: { cookie, "content-type": "application/json" },
    });
    assert.equal(response.statusCode, 200);
  });

  it("DELETE без заголовка content-type — так шлёт исправленный клиент — работает", async () => {
    // подписку вернули на место, чтобы удалить её вторым способом
    await app.inject({
      method: "POST",
      url: "/api/watches",
      headers: { cookie },
      payload: { kind: "product", product: "242678284" },
    });
    const list = await app.inject({ method: "GET", url: "/api/watches", headers: { cookie } });
    const id = list.json().watches[0].id;

    const response = await app.inject({ method: "DELETE", url: `/api/watches/${id}`, headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
  });

  it("битый JSON по-прежнему честно даёт 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/watches",
      headers: { cookie, "content-type": "application/json" },
      payload: "{не json",
    });
    assert.equal(response.statusCode, 400);
  });
});

// Границы значений в ручке отметки прочитанного. Раньше здесь был отладочный
// файл, который только печатал ответы; он и вскрыл, что огромный id доходит до
// Postgres и превращается в 500.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import type { WbClient } from "@watcher/wb-core";
import { buildApp } from "../app.js";
import { createTestDb, FakeWb } from "./harness.js";

let app: FastifyInstance;
let close: () => Promise<void>;
let cookie = "";

before(async () => {
  const created = await createTestDb();
  close = created.close;
  app = (await buildApp({ wb: new FakeWb() as unknown as WbClient, google: null })).server;
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "bounds@example.com", password: "supersecret" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "bounds@example.com", password: "supersecret" },
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

after(async () => {
  await app.close();
  await close();
});

describe("отметка событий прочитанными", () => {
  const read = (ids: unknown) =>
    app.inject({ method: "POST", url: "/api/alerts/read", headers: { cookie }, payload: { ids } });

  it("строка вместо числа — 400", async () => {
    assert.equal((await read(["x"])).statusCode, 400);
  });

  it("число за пределами разрядности — 400, а не 500", async () => {
    // 1e30 проходит проверки «целое» и «положительное», но столбец bigint такого не примет
    assert.equal((await read([1e30])).statusCode, 400);
  });

  it("дробное — 400", async () => {
    assert.equal((await read([1.5])).statusCode, 400);
  });

  it("нормальные значения принимаются", async () => {
    assert.equal((await read([1, 2, 3])).statusCode, 200);
  });

  it("пустое тело отмечает всё прочитанным", async () => {
    const response = await app.inject({ method: "POST", url: "/api/alerts/read", headers: { cookie } });
    assert.equal(response.statusCode, 200);
  });
});

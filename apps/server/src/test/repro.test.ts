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
  const built = await buildApp({ wb: new FakeWb() as unknown as WbClient });
  app = built.server;
  await app.ready();
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "repro@example.com", password: "supersecret" },
  });
  const setCookie = r.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  cookie = raw.split(";")[0]!;
});

after(async () => {
  await app.close();
  await close();
});

describe("repro", () => {
  it("fractional ids", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/alerts/read",
      headers: { cookie },
      payload: { ids: [1.5] },
    });
    console.log("STATUS", res.statusCode);
    console.log("BODY", res.body);
  });
  it("string ids", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/alerts/read",
      headers: { cookie },
      payload: { ids: ["x"] },
    });
    console.log("STR STATUS", res.statusCode);
    console.log("STR BODY", res.body);
  });
  it("huge ids", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/alerts/read",
      headers: { cookie },
      payload: { ids: [1e30] },
    });
    console.log("HUGE STATUS", res.statusCode);
    console.log("HUGE BODY", res.body);
  });
});

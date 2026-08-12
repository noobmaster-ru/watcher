// Проверка HTTP-слоя целиком: регистрация, сессии, подписки, события.
// Запросы идут через inject() — без сокета, без Postgres и без сети до WB.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import type { WbClient } from "@watcher/wb-core";
import { buildApp } from "../app.js";
import { createTestDb, FakeWb } from "./harness.js";
import { makeProduct } from "./fixtures.js";

const NM = "242678284";

let app: FastifyInstance;
let close: () => Promise<void>;
let wb: FakeWb;
let cookie = "";

before(async () => {
  const created = await createTestDb();
  close = created.close;
  wb = new FakeWb();
  wb.set(makeProduct({ nm: NM }));
  wb.setSellerCatalog(1297346, [makeProduct({ nm: NM })]);
  const built = await buildApp({ wb: wb as unknown as WbClient });
  app = built.server;
  await app.ready();
});

after(async () => {
  await app.close();
  await close();
});

describe("здоровье", () => {
  it("отдаёт состояние базы и WB", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.database, "ok");
    assert.ok(body.wb);
  });
});

describe("авторизация", () => {
  it("не пускает в приватные ручки без сессии", async () => {
    const response = await app.inject({ method: "GET", url: "/api/watches" });
    assert.equal(response.statusCode, 401);
  });

  it("регистрирует и выдаёт сессионную куку", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "user@example.com", password: "supersecret" },
    });
    assert.equal(response.statusCode, 200);

    const setCookie = response.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
    assert.match(raw, /watcher_session=/);
    assert.match(raw, /HttpOnly/i, "кука сессии должна быть httpOnly");
    cookie = raw.split(";")[0]!;
  });

  it("отклоняет короткий пароль", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "short@example.com", password: "123" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("не даёт зарегистрировать тот же email дважды", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "user@example.com", password: "supersecret" },
    });
    assert.equal(response.statusCode, 409);
  });

  it("одинаково отвечает на неверный пароль и на несуществующего пользователя", async () => {
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "wrongpassword" },
    });
    const noUser = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ghost@example.com", password: "wrongpassword" },
    });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(noUser.statusCode, 401);
    assert.equal(wrongPassword.json().error, noUser.json().error);
  });

  it("пускает с правильным паролем", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "supersecret" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().user.email, "user@example.com");
  });
});

describe("подписки", () => {
  it("добавляет товар по артикулу", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/watches",
      headers: { cookie },
      payload: { kind: "product", product: NM },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().nm, Number(NM));
  });

  it("принимает ссылку на товар вместо артикула", async () => {
    wb.set(makeProduct({ nm: "900000123" }));
    const response = await app.inject({
      method: "POST",
      url: "/api/watches",
      headers: { cookie },
      payload: { kind: "product", product: "https://www.wildberries.ru/catalog/900000123/detail.aspx" },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().nm, 900000123);
  });

  it("показывает подписки с текущей ценой", async () => {
    const response = await app.inject({ method: "GET", url: "/api/watches", headers: { cookie } });
    assert.equal(response.statusCode, 200);
    const list = response.json().watches;
    assert.equal(list.length, 2);
    assert.equal(list.find((w: { nm: number }) => w.nm === Number(NM)).lastPrice, 1633);
  });

  it("отклоняет мусор вместо артикула", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/watches",
      headers: { cookie },
      payload: { kind: "product", product: "не-артикул" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("меняет порог срабатывания", async () => {
    const list = await app.inject({ method: "GET", url: "/api/watches", headers: { cookie } });
    const id = list.json().watches[0].id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/watches/${id}`,
      headers: { cookie },
      payload: { minChangePct: 10, onRise: true },
    });
    assert.equal(response.statusCode, 200);

    const updated = await app.inject({ method: "GET", url: "/api/watches", headers: { cookie } });
    const watch = updated.json().watches.find((w: { id: number }) => w.id === id);
    assert.equal(watch.minChangePct, 10);
    assert.equal(watch.onRise, true);
  });

  it("не даёт трогать чужую подписку", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "other@example.com", password: "supersecret" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "other@example.com", password: "supersecret" },
    });
    const otherCookie = String(login.headers["set-cookie"]).split(";")[0]!;

    const list = await app.inject({ method: "GET", url: "/api/watches", headers: { cookie } });
    const id = list.json().watches[0].id;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/watches/${id}`,
      headers: { cookie: otherCookie },
    });
    assert.equal(response.statusCode, 404, "чужая подписка должна быть не видна");
  });
});

describe("карточка и история", () => {
  it("отдаёт товар и признак отслеживания", async () => {
    const response = await app.inject({ method: "GET", url: `/api/product/${NM}`, headers: { cookie } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.product.nm, NM);
    assert.ok(body.watchId, "товар уже отслеживается — watchId должен быть заполнен");
  });

  it("отдаёт историю цен", async () => {
    const response = await app.inject({ method: "GET", url: `/api/product/${NM}/history?range=30d` });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().points.length > 0);
  });

  it("честно отвечает 404 на несуществующий товар", async () => {
    const response = await app.inject({ method: "GET", url: "/api/product/111111111", headers: { cookie } });
    assert.equal(response.statusCode, 404);
  });
});

describe("события", () => {
  it("отдаёт ленту и счётчик непрочитанного", async () => {
    const response = await app.inject({ method: "GET", url: "/api/alerts", headers: { cookie } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(Array.isArray(body.alerts));
    assert.equal(typeof body.unread, "number");
  });
});

describe("выход", () => {
  it("гасит сессию", async () => {
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    const response = await app.inject({ method: "GET", url: "/api/watches", headers: { cookie } });
    assert.equal(response.statusCode, 401);
  });
});

describe("лимиты Wildberries", () => {
  it("отдаёт 503 с флагом degraded, а не пустой результат", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "supersecret" },
    });
    const fresh = String(login.headers["set-cookie"]).split(";")[0]!;

    wb.throttled = "card.wb.ru";
    try {
      const product = await app.inject({ method: "GET", url: `/api/product/${NM}`, headers: { cookie: fresh } });
      assert.equal(product.statusCode, 503);
      assert.equal(product.json().degraded, true);
      assert.ok(product.json().error.includes("Wildberries"));

      const search = await app.inject({ method: "GET", url: "/api/search?q=носки", headers: { cookie: fresh } });
      assert.equal(search.statusCode, 503, "поиск тоже должен честно сказать про лимит");

      const seller = await app.inject({
        method: "GET",
        url: "/api/seller/1297346/products",
        headers: { cookie: fresh },
      });
      assert.equal(seller.statusCode, 503);

      const watch = await app.inject({
        method: "POST",
        url: "/api/watches",
        headers: { cookie: fresh },
        payload: { kind: "product", product: "900999999" },
      });
      assert.equal(watch.statusCode, 503, "добавление подписки при лимите не должно выглядеть как 400");
    } finally {
      wb.throttled = null;
    }
  });

  it("после снятия лимита снова работает", async () => {
    const response = await app.inject({ method: "GET", url: `/api/product/${NM}` });
    assert.equal(response.statusCode, 200);
  });
});

describe("смена пароля", () => {
  it("требует верный текущий пароль и гасит прочие сессии", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "supersecret" },
    });
    const sessionA = String(first.headers["set-cookie"]).split(";")[0]!;

    const second = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "supersecret" },
    });
    const sessionB = String(second.headers["set-cookie"]).split(";")[0]!;

    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: sessionA },
      payload: { current: "неверный", next: "новыйпароль123" },
    });
    assert.equal(wrong.statusCode, 401);

    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: sessionA },
      payload: { current: "supersecret", next: "новыйпароль123" },
    });
    assert.equal(ok.statusCode, 200);

    // текущая сессия жива, вторая — оборвана
    const stillHere = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionA } });
    assert.equal(stillHere.statusCode, 200);
    const killed = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionB } });
    assert.equal(killed.statusCode, 401, "чужая сессия должна быть погашена");

    // вход по новому паролю работает, по старому — нет
    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "supersecret" },
    });
    assert.equal(oldPassword.statusCode, 401);
    const newPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "новыйпароль123" },
    });
    assert.equal(newPassword.statusCode, 200);
  });
});

describe("кука сессии", () => {
  it("не помечается Secure, когда сайт отдаётся по HTTP", async () => {
    // Иначе браузер не сохранит и не отправит её, и вход будет молча не работать:
    // сервер отвечает 200, а пользователь остаётся на форме логина.
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "новыйпароль123" },
    });
    const raw = String(response.headers["set-cookie"]);
    assert.match(raw, /HttpOnly/i);
    assert.doesNotMatch(raw, /;\s*Secure/i, "при HTTP-стенде флаг Secure запирает пользователя снаружи");
  });
});

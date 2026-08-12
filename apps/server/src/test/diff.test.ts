// Логика событий — чистая функция, поэтому проверяется без базы и без сети.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffState, passesRules } from "../services/products.js";
import { makeOutOfStock, makeProduct } from "./fixtures.js";

const NM = "242678284";
const base = { lastPointAt: null };

describe("diffState", () => {
  it("на первом наблюдении не порождает событий", () => {
    const events = diffState({ ...base, lastPrice: null, lastInStock: null }, makeProduct({ nm: NM }));
    assert.deepEqual(events, []);
  });

  it("снижение цены даёт price_drop с обеими ценами", () => {
    const events = diffState(
      { ...base, lastPrice: 2000, lastInStock: true },
      makeProduct({ nm: NM, price: { product: 1633, basic: 3000, cashback: null, min: 1633, max: 1633, pricedSizes: 1 } }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "price_drop");
    assert.equal(events[0]?.oldPrice, 2000);
    assert.equal(events[0]?.newPrice, 1633);
  });

  it("рост цены даёт price_rise", () => {
    const events = diffState({ ...base, lastPrice: 1000, lastInStock: true }, makeProduct({ nm: NM }));
    assert.equal(events[0]?.type, "price_rise");
  });

  it("исчезнувшая цена — это out_of_stock, а не падение до нуля", () => {
    // главная ловушка трекера: у распроданного товара WB не отдаёт price вовсе
    const events = diffState({ ...base, lastPrice: 1633, lastInStock: true }, makeOutOfStock(NM));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "out_of_stock");
    assert.equal(events[0]?.newPrice, null);
    assert.ok(!events.some((e) => e.type === "price_drop"));
  });

  it("возврат в продажу даёт back_in_stock", () => {
    const events = diffState({ ...base, lastPrice: null, lastInStock: false }, makeProduct({ nm: NM }));
    assert.equal(events[0]?.type, "back_in_stock");
  });

  it("возврат в продажу с другой ценой даёт и событие цены", () => {
    const events = diffState({ ...base, lastPrice: 2000, lastInStock: false }, makeProduct({ nm: NM }));
    assert.deepEqual(events.map((e) => e.type), ["back_in_stock", "price_drop"]);
  });

  it("неизменная цена не порождает событий", () => {
    const events = diffState({ ...base, lastPrice: 1633, lastInStock: true }, makeProduct({ nm: NM }));
    assert.deepEqual(events, []);
  });
});

describe("passesRules", () => {
  const rules = {
    minChangePct: 5,
    minChangeAbs: 50,
    onDrop: true,
    onRise: false,
    onStockChange: true,
    onNewProduct: true,
  };
  const drop = (oldPrice: number, newPrice: number) =>
    ({ nm: 1, type: "price_drop" as const, oldPrice, newPrice });

  it("отсекает изменение ниже порога в процентах", () => {
    assert.equal(passesRules(rules, drop(10000, 9700)), false); // −3 %
  });

  it("пропускает изменение выше обоих порогов", () => {
    assert.equal(passesRules(rules, drop(10000, 9000)), true); // −10 %, −1000 ₽
  });

  it("отсекает изменение ниже порога в рублях", () => {
    assert.equal(passesRules(rules, drop(200, 180)), false); // −10 %, но всего −20 ₽
  });

  it("уважает выключенный рост цены", () => {
    assert.equal(passesRules(rules, { nm: 1, type: "price_rise", oldPrice: 1000, newPrice: 2000 }), false);
  });

  it("события наличия порогов не касаются", () => {
    assert.equal(passesRules(rules, { nm: 1, type: "out_of_stock", oldPrice: 1633, newPrice: null }), true);
  });
});

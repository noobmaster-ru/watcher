// Листы-витрины: дни колонками, перенос цены на дни без наблюдений, фото и артикул.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProductGrid, buildSummaryGrid, buildSeries, columnName, dayRange } from "../services/dashboard.js";
import type { ProductSeries } from "../services/dashboard.js";

const days = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];

const series = (over: Partial<ProductSeries> = {}): ProductSeries => ({
  nm: 242678284,
  name: "Шампура с деревянной ручкой",
  brand: "ШАМПУР-ЮГ",
  supplier: "ШАМПУР-ЮГ",
  rating: 4.9,
  reviews: 1057,
  lastPrice: 1786,
  lastBasic: 3515,
  own: true,
  days: [
    { day: days[0]!, price: 2000, inStock: true, quantity: 10 },
    { day: days[1]!, price: 1900, inStock: true, quantity: 8 },
    { day: days[2]!, price: 1786, inStock: true, quantity: 3 },
    { day: days[3]!, price: 1786, inStock: true, quantity: 3 },
  ],
  ...over,
});

describe("раскладка по дням", () => {
  it("переносит цену на дни без наблюдений", () => {
    // цена держится, пока её не изменили: дырка означала бы, что товар пропал
    const built = buildSeries(
      [{ day: "2026-08-02", price: 1500, inStock: true, quantity: 5 }],
      days,
      { price: 2000, inStock: true },
    );
    assert.deepEqual(built.map((d) => d.price), [2000, 1500, 1500, 1500]);
  });

  it("до первого наблюдения оставляет пусто", () => {
    const built = buildSeries([{ day: "2026-08-03", price: 900, inStock: true, quantity: 1 }], days, null);
    assert.deepEqual(built.map((d) => d.price), [null, null, 900, 900]);
  });

  it("окно дней заканчивается сегодняшним днём", () => {
    const range = dayRange(new Date("2026-08-13T10:00:00Z"));
    assert.equal(range[range.length - 1], "2026-08-13");
    assert.equal(range.length, 60);
  });
});

describe("имена колонок", () => {
  it("считает буквенные адреса, включая двухбуквенные", () => {
    assert.equal(columnName(1), "A");
    assert.equal(columnName(26), "Z");
    assert.equal(columnName(27), "AA");
    assert.equal(columnName(70), "BR");
  });
});

describe("сводный лист", () => {
  const grid = buildSummaryGrid([series()], days);

  it("шапка содержит фото, артикул и дни", () => {
    assert.deepEqual(grid[0]?.slice(0, 9), [
      "Фото", "Артикул", "Название", "Бренд", "Продавец", "Цена сейчас", "Минимум", "Максимум", "График цены",
    ]);
    // даты пишем датами: строку «01.08» Google в русской локали превращает в
    // порядковое число вроде 46188, а вид задаётся форматом ячейки
    assert.deepEqual(grid[0]?.slice(9), days);
  });

  it("в строке товара есть картинка, артикул и спарклайн", () => {
    const row = grid[1]!;
    assert.match(String(row[0]), /^=IMAGE\("https:\/\/basket-\d+\.wbbasket\.ru\//);
    assert.equal(row[1], 242678284);
    assert.match(String(row[8]), /^=SPARKLINE\(J2:M2\)$/);
  });

  it("минимум и максимум считаются по дням", () => {
    assert.equal(grid[1]?.[6], 1786);
    assert.equal(grid[1]?.[7], 2000);
  });

  it("цены по дням идут отдельными колонками", () => {
    assert.deepEqual(grid[1]?.slice(9), [2000, 1900, 1786, 1786]);
  });

  it("не использует формул с разделителем аргументов", () => {
    // в русской локали это «;», в английской «,» — угадывать нельзя
    const formulas = grid.flat().filter((cell) => typeof cell === "string" && cell.startsWith("="));
    assert.ok(formulas.length > 0);
    assert.ok(
      formulas.every((formula) => !String(formula).includes(";") && !String(formula).includes(",")),
      `многоаргументные формулы сломаются в чужой локали: ${formulas.find((f) => String(f).includes(";"))}`,
    );
  });
});

describe("лист одного товара", () => {
  const grid = buildProductGrid(series(), days);

  it("сверху фото, название, артикул и ссылка", () => {
    assert.match(String(grid[0]?.[0]), /^=IMAGE\(/);
    assert.equal(grid[0]?.[1], "Шампура с деревянной ручкой");
    assert.equal(grid[1]?.[1], "Артикул 242678284");
    assert.match(String(grid[1]?.[2]), /^=HYPERLINK\("https:\/\/www\.wildberries\.ru\/catalog\/242678284/);
  });

  it("метрики идут строками, дни — колонками", () => {
    const header = grid[3]!;
    assert.deepEqual(header.slice(0, 6), ["Метрика", "График", "Минимум", "Максимум", "Последнее", ""]);
    assert.deepEqual(header.slice(6), days);
    assert.equal(grid[4]?.[0], "Цена, ₽");
    assert.deepEqual(grid[4]?.slice(6), [2000, 1900, 1786, 1786]);
  });

  it("у каждой метрики свой график и сводные числа", () => {
    assert.match(String(grid[4]?.[1]), /^=SPARKLINE\(G5:J5\)$/);
    assert.equal(grid[4]?.[2], 1786, "минимум");
    assert.equal(grid[4]?.[3], 2000, "максимум");
    assert.equal(grid[4]?.[4], 1786, "последнее значение");
  });

  it("считает цену с WB Кошельком", () => {
    assert.equal(grid[5]?.[0], "Цена с WB Кошельком, ₽");
    assert.equal(grid[5]?.[6], 1960);
  });
});

// Разрешение адреса продавца. Wildberries отдаёт страницу продавца и по номеру
// (/seller/809881), и по буквенному адресу (/seller/shampur-yug), но публичного
// способа превратить второй в первый нет — страница закрыта JS-челленджем.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WbClient, WbTransport, deslugify, slugify } from "@watcher/wb-core";

describe("транслитерация адресов", () => {
  it("сворачивает имя продавца в тот же адрес, что и Wildberries", () => {
    assert.equal(slugify("ШАМПУР-ЮГ"), "shampur-yug");
    assert.equal(slugify("ТРЕЙД АП"), "treyd-ap");
    assert.equal(slugify("Электроника (Гарантия 2 Года)"), "elektronika-garantiya-2-goda");
  });

  it("разворачивает адрес в поисковый запрос", () => {
    assert.equal(deslugify("shampur-yug"), "шампур юг");
    assert.equal(deslugify("treyd-ap"), "трейд ап");
  });

  it("не путает длинные сочетания с короткими", () => {
    assert.equal(deslugify("shchi"), "щи");
    assert.equal(slugify("щи"), "shchi");
  });
});

/** Транспорт, отвечающий заранее заданной выдачей поиска. */
function searchTransport(suppliers: Array<{ id: number; name: string }>): WbTransport {
  return {
    async getJson(url: string) {
      if (!url.includes("search.wb.ru")) return { products: [] };
      return {
        products: suppliers.map((s, index) => ({
          id: 900000000 + index,
          name: `Товар ${index}`,
          supplier: s.name,
          supplierId: s.id,
          totalQuantity: 5,
          sizes: [{ price: { basic: 300000, product: 163300 } }],
        })),
      };
    },
    hostStatuses: () => [],
    overallState: () => "ok",
  } as unknown as WbTransport;
}

describe("поиск продавца по буквенному адресу", () => {
  it("подтверждает совпадение обратной свёрткой имени", async () => {
    const client = new WbClient({
      transport: searchTransport([
        { id: 250124970, name: "Юг цветущих облаков" },
        { id: 4025828, name: "ШАМПУР-ЮГ" },
      ]),
    });

    const result = await client.resolveSellerBySlug("shampur-yug");
    assert.equal(result.query, "шампур юг");
    assert.equal(result.exact?.supplierId, 4025828, "имя должно свернуться ровно в запрошенный адрес");
  });

  it("не угадывает, когда точного совпадения нет — отдаёт кандидатов", async () => {
    const client = new WbClient({
      transport: searchTransport([
        { id: 111, name: "Совсем другой продавец" },
        { id: 222, name: "И этот тоже" },
      ]),
    });

    const result = await client.resolveSellerBySlug("shampur-yug");
    assert.equal(result.exact, null, "похожего мало — выбор должен остаться за пользователем");
    assert.equal(result.candidates.length, 2);
  });

  it("на пустой выдаче не падает", async () => {
    const client = new WbClient({ transport: searchTransport([]) });
    const result = await client.resolveSellerBySlug("neizvestnyy-prodavets");
    assert.equal(result.exact, null);
    assert.deepEqual(result.candidates, []);
  });
});

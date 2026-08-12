// Перебор хостов карточек. Дефект был найден на боевом сервере: card.wb.ru
// отдаёт 403 с московского VPS, хотя с ноутбука отвечает 200, — и без запасного
// хоста трекер не получал бы ни одной цены.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WbClient, WbHttpError, WbTransport } from "@watcher/wb-core";

/** Транспорт, у которого часть хостов «заблокирована по IP». */
function fakeTransport(blocked: string[], onCall: (host: string) => void): WbTransport {
  return {
    async getJson(url: string) {
      const host = new URL(url).host;
      onCall(host);
      if (blocked.includes(host)) throw new WbHttpError(403, url);
      return {
        products: [
          {
            id: 242678284,
            name: "Товар",
            supplier: "Продавец",
            supplierId: 1,
            totalQuantity: 5,
            sizes: [{ price: { basic: 300000, product: 163300 } }],
          },
        ],
      };
    },
    hostStatuses: () => [],
    overallState: () => "ok",
  } as unknown as WbTransport;
}

describe("выбор хоста карточек", () => {
  it("переключается на запасной, когда основной отдаёт 403", async () => {
    const calls: string[] = [];
    const client = new WbClient({ transport: fakeTransport(["card.wb.ru"], (h) => calls.push(h)) });

    const products = await client.detailBatch([242678284]);
    assert.equal(products.length, 1);
    assert.equal(products[0]?.price.product, 1633, "цена должна дойти с запасного хоста");
    assert.deepEqual(calls, ["card.wb.ru", "catalog.wb.ru"]);
    assert.equal(client.activeDetailHost(), "catalog.wb.ru");
  });

  it("запоминает рабочий хост и больше не долбится в заблокированный", async () => {
    const calls: string[] = [];
    const client = new WbClient({ transport: fakeTransport(["card.wb.ru"], (h) => calls.push(h)) });

    await client.detailBatch([242678284]);
    calls.length = 0;
    await client.detailBatch([242678284]);

    assert.deepEqual(calls, ["catalog.wb.ru"], "второй запрос должен идти сразу на рабочий хост");
  });

  it("падает понятной ошибкой, когда недоступны все хосты", async () => {
    const client = new WbClient({
      transport: fakeTransport(["card.wb.ru", "catalog.wb.ru", "u-card.wb.ru"], () => {}),
    });
    await assert.rejects(() => client.detailBatch([242678284]));
  });
});

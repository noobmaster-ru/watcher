// Сквозная проверка трекера на настоящем Postgres (PGlite) с подставным WB.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import type { WbClient } from "@watcher/wb-core";
import { alerts, pricePoints, products, sellerProducts, users, watches } from "../db/schema.js";
import { runPriceTick } from "../scheduler/prices.js";
import { syncSellerCatalog, watchProduct, watchSeller } from "../services/watches.js";
import { createTestDb, FakeWb } from "./harness.js";
import { makeOutOfStock, makeProduct } from "./fixtures.js";
import type { Db } from "../db/client.js";

const NM = 242678284;
const SUPPLIER = 1297346;

let db: Db;
let close: () => Promise<void>;
let wb: FakeWb;
let userId: number;

before(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  wb = new FakeWb();
  const [user] = await db
    .insert(users)
    .values({ email: "test@example.com", passwordHash: "scrypt$00$00" })
    .returning({ id: users.id });
  userId = user!.id;
});

after(async () => {
  await close();
});

describe("подписка на товар", () => {
  it("ставит товар на отслеживание и пишет первую точку истории", async () => {
    wb.set(makeProduct({ nm: String(NM), supplierId: SUPPLIER }));
    const watchId = await watchProduct(wb as unknown as WbClient, { userId, kind: "product", nm: NM });
    assert.ok(watchId > 0);

    const [product] = await db.select().from(products).where(eq(products.nm, NM));
    assert.equal(product?.lastPrice, 1633);
    assert.equal(product?.isTracked, true, "товар должен опрашиваться планировщиком");

    const points = await db.select().from(pricePoints).where(eq(pricePoints.nm, NM));
    assert.equal(points.length, 1);
    assert.equal(points[0]?.price, 1633);
    assert.equal(points[0]?.inStock, true);
  });

  it("тик планировщика замечает снижение цены и создаёт уведомление", async () => {
    wb.set(
      makeProduct({
        nm: String(NM),
        supplierId: SUPPLIER,
        price: { product: 1200, basic: 3000, cashback: null, min: 1200, max: 1200, pricedSizes: 1 },
      }),
    );

    // сдвигаем срок проверки в прошлое, чтобы товар попал в партию
    await db.update(products).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(products.nm, NM));
    const result = await runPriceTick(wb as unknown as WbClient);

    assert.equal(result.checked, 1);
    assert.equal(result.events, 1);

    const [alert] = await db.select().from(alerts).where(eq(alerts.nm, NM));
    assert.equal(alert?.type, "price_drop");
    assert.equal(alert?.oldPrice, 1633);
    assert.equal(alert?.newPrice, 1200);

    const points = await db.select().from(pricePoints).where(eq(pricePoints.nm, NM));
    assert.equal(points.length, 2, "новая цена должна дать вторую точку");
  });

  it("пропавший товар даёт out_of_stock, а не падение цены до нуля", async () => {
    wb.set(makeOutOfStock(String(NM)));
    await db.update(products).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(products.nm, NM));
    await runPriceTick(wb as unknown as WbClient);

    const stockAlerts = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.nm, NM), eq(alerts.type, "out_of_stock")));
    assert.equal(stockAlerts.length, 1);

    const drops = await db.select().from(alerts).where(and(eq(alerts.nm, NM), eq(alerts.type, "price_drop")));
    assert.equal(drops.length, 1, "второго price_drop быть не должно");

    const [product] = await db.select().from(products).where(eq(products.nm, NM));
    assert.equal(product?.lastInStock, false);
    assert.equal(product?.lastPrice, null);
  });

  it("неизменная цена не плодит ни точек, ни уведомлений", async () => {
    const before = await db.select().from(pricePoints).where(eq(pricePoints.nm, NM));
    await db.update(products).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(products.nm, NM));
    const result = await runPriceTick(wb as unknown as WbClient);

    assert.equal(result.events, 0);
    const after = await db.select().from(pricePoints).where(eq(pricePoints.nm, NM));
    assert.equal(after.length, before.length);
  });
});

describe("подписка на продавца", () => {
  const CATALOG = [
    makeProduct({ nm: "900000001", supplierId: 777, name: "Товар 1" }),
    makeProduct({ nm: "900000002", supplierId: 777, name: "Товар 2" }),
  ];

  it("подтягивает весь каталог и ставит его на отслеживание", async () => {
    wb.setSellerCatalog(777, CATALOG);
    const result = await watchSeller(wb as unknown as WbClient, { userId, kind: "seller", supplierId: 777 });

    assert.equal(result.productCount, 2);
    const rows = await db.select().from(sellerProducts).where(eq(sellerProducts.supplierId, 777));
    assert.equal(rows.length, 2);

    const tracked = await db.select().from(products).where(eq(products.supplierId, 777));
    assert.ok(tracked.every((p) => p.isTracked), "товары продавца должны опрашиваться");
  });

  it("в момент подписки не заваливает уведомлениями о «новых» товарах", async () => {
    const newProductAlerts = await db.select().from(alerts).where(eq(alerts.type, "new_product"));
    assert.equal(newProductAlerts.length, 0);
  });

  it("замечает появление нового товара при пересинхронизации", async () => {
    wb.setSellerCatalog(777, [...CATALOG, makeProduct({ nm: "900000003", supplierId: 777, name: "Новинка" })]);
    const sync = await syncSellerCatalog(wb as unknown as WbClient, 777, { announceNew: true });

    assert.equal(sync.added, 1);
    const [alert] = await db.select().from(alerts).where(eq(alerts.type, "new_product"));
    assert.equal(alert?.nm, 900000003);
  });

  it("товар, пропавший из каталога, помечается неактивным", async () => {
    wb.setSellerCatalog(777, [CATALOG[0]!]);
    const sync = await syncSellerCatalog(wb as unknown as WbClient, 777, { announceNew: true });

    assert.equal(sync.removed, 2);
    const active = await db
      .select()
      .from(sellerProducts)
      .where(and(eq(sellerProducts.supplierId, 777), eq(sellerProducts.isActive, true)));
    assert.equal(active.length, 1);
  });

  it("подписка на продавца ловит изменение цены его товара", async () => {
    wb.set(
      makeProduct({
        nm: "900000001",
        supplierId: 777,
        price: { product: 900, basic: 3000, cashback: null, min: 900, max: 900, pricedSizes: 1 },
      }),
    );
    await db.update(products).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(products.nm, 900000001));
    await runPriceTick(wb as unknown as WbClient);

    const [alert] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.nm, 900000001), eq(alerts.type, "price_drop")));
    assert.ok(alert, "подписчик продавца должен получить уведомление о цене его товара");
  });
});

describe("отписка", () => {
  it("снимает товар с опроса, когда подписчиков не осталось", async () => {
    const { removeWatch } = await import("../services/watches.js");
    const [watch] = await db
      .select()
      .from(watches)
      .where(and(eq(watches.userId, userId), eq(watches.nm, NM)));
    await removeWatch(userId, watch!.id);

    const [product] = await db.select().from(products).where(eq(products.nm, NM));
    assert.equal(product?.isTracked, false);
  });
});

describe("доставка уведомлений в Telegram", () => {
  it("не отправляет события, случившиеся до подключения чата", async () => {
    const { userChannels } = await import("../db/schema.js");
    const { deliverPendingAlerts } = await import("../services/telegram.js");

    // событие произошло час назад, чат привязан только что
    await db.insert(alerts).values({
      userId,
      nm: NM,
      type: "price_drop",
      oldPrice: 2000,
      newPrice: 1000,
      createdAt: new Date(Date.now() - 3600_000),
    });
    await db.insert(userChannels).values({
      userId,
      telegramChatId: "123456",
      verifiedAt: new Date(),
    });

    // без TELEGRAM_BOT_TOKEN отправка выключена — проверяем, что выборка пуста
    const sent = await deliverPendingAlerts();
    assert.equal(sent, 0);

    const stale = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.nm, NM), eq(alerts.type, "price_drop")));
    assert.ok(stale.every((a) => a.deliveredAt === null), "старые события остаются недоставленными");
  });
});

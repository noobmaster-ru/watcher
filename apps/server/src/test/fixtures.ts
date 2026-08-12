// Снимки товаров для тестов. Форма один в один как у живого card.wb.ru
// (проверено на артикулах 242678284 и 719482347).
import type { WbProduct } from "@watcher/wb-core";

export function makeProduct(overrides: Partial<WbProduct> & { nm: string }): WbProduct {
  const price = overrides.price ?? {
    product: 1633,
    basic: 3000,
    cashback: null,
    min: 1633,
    max: 1633,
    pricedSizes: 1,
  };
  return {
    nm: overrides.nm,
    name: overrides.name ?? "Оплетка на руль",
    brand: overrides.brand ?? "AutoStyle",
    price,
    rating: overrides.rating ?? 4.7,
    reviews: overrides.reviews ?? 120,
    supplier: overrides.supplier ?? "ТРЕЙД АП",
    supplierId: overrides.supplierId ?? 1297346,
    supplierRating: overrides.supplierRating ?? 4.8,
    root: overrides.root ?? "735578975",
    inStock: overrides.inStock ?? true,
    totalQuantity: overrides.totalQuantity ?? 10,
    pics: overrides.pics ?? 4,
    colors: overrides.colors ?? [],
    url: `https://www.wildberries.ru/catalog/${overrides.nm}/detail.aspx`,
    image: `https://basket-16.wbbasket.ru/vol2426/part242678/${overrides.nm}/images/c516x688/1.webp`,
  };
}

/** Товар, которого нет в наличии: WB не отдаёт объект price вообще. */
export function makeOutOfStock(nm: string): WbProduct {
  return makeProduct({
    nm,
    inStock: false,
    totalQuantity: 0,
    price: { product: null, basic: null, cashback: null, min: null, max: null, pricedSizes: 0 },
  });
}

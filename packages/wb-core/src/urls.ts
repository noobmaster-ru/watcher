// Раскладка статики WB по шардам. Перенесено из wb-mcp-server без изменений логики:
// это выстраданные детали, которые проще сохранить, чем переоткрыть.

/**
 * card.json и картинки лежат на basket-NN.wbbasket.ru, где NN выбирается по vol
 * (nm / 100000). Живой источник таблицы: https://cdn.wbbasket.ru/api/v3/upstreams —
 * здесь она закеширована статически (46 шардов, 2026).
 */
const BASKET_RANGES: Array<[number, string]> = [
  [143, "01"], [287, "02"], [431, "03"], [719, "04"], [1007, "05"], [1061, "06"],
  [1115, "07"], [1169, "08"], [1313, "09"], [1601, "10"], [1655, "11"], [1919, "12"],
  [2045, "13"], [2189, "14"], [2405, "15"], [2621, "16"], [2837, "17"], [3053, "18"],
  [3269, "19"], [3485, "20"], [3701, "21"], [3917, "22"], [4133, "23"], [4349, "24"],
  [4565, "25"], [4877, "26"], [5189, "27"], [5501, "28"], [5813, "29"], [6125, "30"],
  [6437, "31"], [6749, "32"], [7061, "33"], [7373, "34"], [7685, "35"], [7997, "36"],
  [8309, "37"], [8741, "38"], [9173, "39"], [9605, "40"], [10373, "41"], [11141, "42"],
  [11909, "43"], [12677, "44"], [13445, "45"], [14213, "46"],
];

export function basketHost(nm: number): string {
  const vol = Math.floor(nm / 100000);
  for (const [threshold, shard] of BASKET_RANGES) {
    if (vol <= threshold) return `basket-${shard}.wbbasket.ru`;
  }
  return "basket-46.wbbasket.ru"; // артикулы выше таблицы — берём последний шард
}

export function cardJsonUrl(nm: number): string {
  const vol = Math.floor(nm / 100000);
  const part = Math.floor(nm / 1000);
  return `https://${basketHost(nm)}/vol${vol}/part${part}/${nm}/info/ru/card.json`;
}

/** Первая картинка товара, размер c516x688. */
export function imageUrl(nm: number | string): string {
  const id = Number(nm);
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  return `https://${basketHost(id)}/vol${vol}/part${part}/${id}/images/c516x688/1.webp`;
}

export function productUrl(nm: number | string): string {
  return `https://www.wildberries.ru/catalog/${nm}/detail.aspx`;
}

export function sellerUrl(supplierId: number | string): string {
  return `https://www.wildberries.ru/seller/${supplierId}`;
}

/**
 * CRC16/ARC от little-endian 8-байтового imtId — так сам фронт WB выбирает шард
 * с отзывами. Нужен как запасной путь, когда резолвер шардов недоступен.
 */
export function crc16Arc(value: number | string): number {
  let v = Number(value);
  let crc = 0;
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) {
    bytes.push(v % 256);
    v = Math.floor(v / 256);
  }
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

/** Артикул из числа, строки или ссылки вида /catalog/{nm}/detail.aspx. */
export function toNm(input: string | number): number {
  const raw = String(input ?? "").trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/catalog\/(\d+)/) ?? raw.match(/(\d{5,})/);
  if (!match?.[1]) throw new Error("Нужен артикул Wildberries (nm) или ссылка на товар");
  return Number(match[1]);
}

/** ID продавца из числа, строки или ссылки вида /seller/{id}. */
export function toSupplierId(input: string | number): number {
  const raw = String(input ?? "").trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/seller\/(\d+)/) ?? raw.match(/(\d{1,})/);
  if (!match?.[1]) throw new Error("Нужен ID продавца или ссылка вида wildberries.ru/seller/123456");
  return Number(match[1]);
}

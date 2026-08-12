// Транслитерация для адресов продавцов.
//
// Страница продавца может открываться и по номеру (/seller/809881), и по
// буквенному адресу (/seller/shampur-yug). Публичного способа превратить второй
// в первый у Wildberries нет: страница закрыта JS-челленджем антибота, а
// supplier-by-id понимает только числа. Поэтому адрес расшифровывается обратно
// в русский текст, по нему ищется товар, а найденный продавец подтверждается
// обратной проверкой: его имя должно сворачиваться ровно в тот же адрес.

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Имя продавца → адрес вида «shampur-yug». Тем же правилом их строит WB. */
export function slugify(value: string): string {
  const lower = (value ?? "").toLowerCase();
  let out = "";
  for (const char of lower) {
    if (char in CYRILLIC_TO_LATIN) out += CYRILLIC_TO_LATIN[char];
    else if (/[a-z0-9]/.test(char)) out += char;
    else out += "-";
  }
  return out.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// Порядок важен: длинные сочетания разбираются раньше коротких, иначе
// «shch» распадётся на «sh» + «ch».
const LATIN_TO_CYRILLIC: Array<[string, string]> = [
  ["shch", "щ"], ["sch", "щ"], ["yo", "ё"], ["yu", "ю"], ["ya", "я"],
  ["zh", "ж"], ["kh", "х"], ["ts", "ц"], ["ch", "ч"], ["sh", "ш"],
  ["a", "а"], ["b", "б"], ["v", "в"], ["g", "г"], ["d", "д"], ["e", "е"],
  ["z", "з"], ["i", "и"], ["y", "й"], ["k", "к"], ["l", "л"], ["m", "м"],
  ["n", "н"], ["o", "о"], ["p", "п"], ["r", "р"], ["s", "с"], ["t", "т"],
  ["u", "у"], ["f", "ф"], ["h", "х"], ["c", "к"], ["j", "дж"], ["q", "к"],
  ["w", "в"], ["x", "кс"],
];

/** Адрес «shampur-yug» → поисковый запрос «шампур юг». */
export function deslugify(slug: string): string {
  const lower = (slug ?? "").toLowerCase().trim();
  let out = "";
  let i = 0;

  while (i < lower.length) {
    const char = lower[i] as string;
    if (char === "-" || char === "_" || char === " ") {
      out += " ";
      i += 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      out += char;
      i += 1;
      continue;
    }

    const match = LATIN_TO_CYRILLIC.find(([latin]) => lower.startsWith(latin, i));
    if (match) {
      out += match[1];
      i += match[0].length;
    } else {
      out += char;
      i += 1;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Похоже ли на буквенный адрес продавца, а не на число. */
export function looksLikeSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value.trim()) && /[a-z]/i.test(value);
}

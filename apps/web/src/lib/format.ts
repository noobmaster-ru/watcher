export const money = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : `${value.toLocaleString("ru-RU")} ₽`;

/** Цена с учётом скидки за оплату WB Кошельком — её и видит покупатель на витрине. */
export const walletPrice = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 0.98);

export function percentChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from === 0) return null;
  return Math.round(((to - from) / from) * 1000) / 10;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  return hours === 24 ? "раз в сутки" : `${hours} ч`;
}

export const ALERT_LABELS: Record<string, string> = {
  price_drop: "Цена снизилась",
  price_rise: "Цена выросла",
  out_of_stock: "Нет в наличии",
  back_in_stock: "Снова в продаже",
  new_product: "Новый товар",
};

export const ALERT_ICONS: Record<string, string> = {
  price_drop: "📉",
  price_rise: "📈",
  out_of_stock: "⚠️",
  back_in_stock: "✅",
  new_product: "🆕",
};

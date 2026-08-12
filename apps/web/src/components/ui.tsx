import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { money, percentChange } from "../lib/format";

export function Spinner({ label = "Загрузка…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-8 text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-wb" />
      {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = (error as Error)?.message ?? "Что-то пошло не так";
  const degraded = (error as { degraded?: boolean })?.degraded;
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        degraded
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          : "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      }`}
    >
      {message}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="muted max-w-md">{children}</p>}
    </div>
  );
}

/** Изменение цены: цвет и знак. Снижение — зелёное, рост — красное. */
export function Delta({ from, to }: { from: number | null; to: number | null }) {
  const pct = percentChange(from, to);
  if (pct === null || pct === 0) return <span className="muted">—</span>;
  const positive = pct > 0;
  return (
    <span className={positive ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}>
      {positive ? "+" : ""}
      {pct}%
    </span>
  );
}

export function PriceTag({ price, basic }: { price: number | null; basic: number | null }) {
  if (price === null) {
    return <span className="font-semibold text-slate-400">нет в продаже</span>;
  }
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-lg font-semibold">{money(price)}</span>
      {basic !== null && basic > price && <s className="muted">{money(basic)}</s>}
    </span>
  );
}

export function ProductThumb({ nm, image, name }: { nm: string | number; image: string; name: string | null }) {
  return (
    <Link to={`/product/${nm}`} className="shrink-0">
      <img
        src={image}
        alt={name ?? String(nm)}
        loading="lazy"
        className="h-16 w-12 rounded-md border border-slate-200 object-cover dark:border-slate-800"
        onError={(event) => {
          (event.target as HTMLImageElement).style.visibility = "hidden";
        }}
      />
    </Link>
  );
}

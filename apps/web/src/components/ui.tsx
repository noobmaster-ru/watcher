import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { money, percentChange } from "../lib/format";

export function Spinner({ label = "Загрузка…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-8 text-slate-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-wb" />
      {label}
    </div>
  );
}

/** Скелетон списка: карточки той же высоты, что настоящие строки, — контент
 *  не прыгает, когда приходят данные. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Загрузка">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="card flex animate-pulse items-center gap-4">
          <div className="h-16 w-12 shrink-0 rounded-md bg-slate-200 dark:bg-slate-800" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/3 rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-3 w-1/3 rounded bg-slate-200 dark:bg-slate-800" />
          </div>
          <div className="h-5 w-20 rounded bg-slate-200 dark:bg-slate-800" />
        </div>
      ))}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = (error as Error)?.message ?? "Что-то пошло не так";
  const degraded = (error as { degraded?: boolean })?.degraded;
  return (
    <div
      role="alert"
      className={`animate-fade-in rounded-lg border p-3 text-sm ${
        degraded
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          : "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      }`}
    >
      {message}
    </div>
  );
}

export function Empty({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 py-12 text-center">
      <div
        aria-hidden="true"
        className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-wb/15 to-fuchsia-500/15 text-xl"
      >
        ✨
      </div>
      <p className="font-semibold">{title}</p>
      {children && <p className="muted max-w-md">{children}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

/** Изменение цены: цвет и знак. Снижение — зелёное, рост — красное. */
export function Delta({ from, to }: { from: number | null; to: number | null }) {
  const pct = percentChange(from, to);
  if (pct === null || pct === 0) return <span className="muted">—</span>;
  const positive = pct > 0;
  return (
    <span className={`nums ${positive ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
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
      <span className="nums text-lg font-semibold">{money(price)}</span>
      {basic !== null && basic > price && <s className="muted nums">{money(basic)}</s>}
    </span>
  );
}

/** Превью товара. Битая картинка (CDN WB отдаёт 404 на часть шардов) не
 *  оставляет дырку, а превращается в серую заглушку той же геометрии. */
export function ProductThumb({ nm, image, name }: { nm: string | number; image: string; name: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <Link
      to={`/product/${nm}`}
      className="block h-16 w-12 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
      tabIndex={-1}
      aria-hidden="true"
    >
      {!broken && image && (
        <img
          src={image}
          alt={name ?? String(nm)}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      )}
    </Link>
  );
}

/**
 * Удаление в два клика вместо window.confirm: первый клик «взводит» кнопку,
 * второй удаляет. Через несколько секунд без второго клика кнопка сама
 * возвращается в исходное состояние — случайный клик ничего не теряет,
 * а модальное окно не нужно.
 */
export function RemoveButton({
  onConfirm,
  pending = false,
  label = "Убрать из отслеживания",
}: {
  onConfirm: () => void;
  pending?: boolean;
  label?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (armed) {
    return (
      <button
        onClick={onConfirm}
        disabled={pending}
        className="btn-danger animate-fade-in px-3 py-1.5 text-xs"
        onBlur={() => setArmed(false)}
      >
        {pending ? "…" : "Точно?"}
      </button>
    );
  }

  return (
    <button
      onClick={() => setArmed(true)}
      aria-label={label}
      title={label}
      className="rounded-md p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** Стили тултипа recharts: SVG-атрибуты не понимают var(), inline-стили — понимают. */
export const chartTooltipStyle: React.CSSProperties = {
  borderRadius: 8,
  border: "1px solid var(--tooltip-border)",
  background: "var(--tooltip-bg)",
  color: "var(--tooltip-text)",
  fontSize: 13,
};

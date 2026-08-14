import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, type SheetSide, type SheetState } from "../lib/api";

/**
 * Кнопка «Гугл-таблица» с выпадающим списком площадок.
 *
 * Таблиц две — своя у Wildberries и своя у Яндекс Маркета, — поэтому кнопка
 * не открывает ничего сама, а раскрывает выбор. Подключённая таблица уходит в
 * новую вкладку; неподключённая ведёт в настройки, где лежит инструкция:
 * создать таблицу за пользователя приложение не может, у сервисных аккаунтов
 * Google нет места на Диске.
 */
export function SheetButton() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const sheet = useQuery({
    queryKey: ["sheet"],
    queryFn: () => api.get<SheetState>("/api/sheet"),
    staleTime: 60_000,
  });

  // клик мимо и Escape закрывают список — иначе он живёт своей жизнью
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (sheet.data && !sheet.data.available) {
    return (
      <span
        className="shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-slate-400"
        title="На сервере не задан ключ сервисного аккаунта Google"
      >
        Гугл-таблица
      </span>
    );
  }

  const openSide = (side: SheetSide | undefined) => {
    setOpen(false);
    if (side?.url) window.open(side.url, "_blank", "noopener,noreferrer");
    else navigate("/settings");
  };

  const connected = (side: SheetSide | undefined) => Boolean(side?.url);

  return (
    <div className="relative shrink-0" ref={box}>
      <button
        onClick={() => setOpen(!open)}
        className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-900/5 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        Гугл-таблица
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          className={`transition ${open ? "rotate-180" : ""}`}
        >
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 w-56 animate-fade-in overflow-hidden rounded-xl border border-slate-200/70 bg-white shadow-card dark:border-slate-700 dark:bg-slate-900"
        >
          <SheetItem
            label="Wildberries"
            side={sheet.data?.wb}
            connected={connected(sheet.data?.wb)}
            onClick={() => openSide(sheet.data?.wb)}
          />
          <SheetItem
            label="Яндекс Маркет"
            side={sheet.data?.ym}
            connected={connected(sheet.data?.ym)}
            onClick={() => openSide(sheet.data?.ym)}
          />
        </div>
      )}
    </div>
  );
}

function SheetItem({
  label,
  side,
  connected,
  onClick,
}: {
  label: string;
  side: SheetSide | undefined;
  connected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition hover:bg-slate-100 dark:hover:bg-slate-800"
    >
      <span className={connected ? "" : "text-slate-500"}>{label}</span>
      <span className="text-xs text-slate-400">
        {side?.lastError ? "⚠" : connected ? "открыть" : "подключить"}
      </span>
    </button>
  );
}

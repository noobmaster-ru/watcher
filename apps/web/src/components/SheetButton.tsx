import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

interface SheetState {
  available: boolean;
  serviceAccountEmail: string | null;
  url: string | null;
  lastExportAt: string | null;
  lastError: string | null;
}

/**
 * Кнопка «Гугл-таблица» рядом с «Событиями».
 *
 * Подключённую таблицу открывает в новой вкладке. Если таблица ещё не
 * подключена, ведёт в настройки: создать её должен сам пользователь — у
 * сервисных аккаунтов Google нет места на Диске, и создать файл за него
 * приложение не может.
 */
export function SheetButton() {
  const navigate = useNavigate();

  const sheet = useQuery({
    queryKey: ["sheet"],
    queryFn: () => api.get<SheetState>("/api/sheet"),
    staleTime: 60_000,
  });

  if (sheet.data && !sheet.data.available) {
    return (
      <span
        className="shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-slate-400"
        title="На сервере не задан ключ сервисного аккаунта Google (GOOGLE_SERVICE_ACCOUNT)"
      >
        Гугл-таблица
      </span>
    );
  }

  const url = sheet.data?.url;

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-emerald-700 transition hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
        title={
          sheet.data?.lastError
            ? `Последняя выгрузка не удалась: ${sheet.data.lastError}`
            : sheet.data?.lastExportAt
              ? `Обновлено ${new Date(sheet.data.lastExportAt).toLocaleString("ru-RU")}`
              : "Таблица создана, данные появятся при ближайшей выгрузке"
        }
      >
        Гугл-таблица{sheet.data?.lastError ? " ⚠" : ""}
      </a>
    );
  }

  return (
    <button
      onClick={() => navigate("/settings")}
      className="shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      title="Таблица не подключена — откроются настройки с инструкцией"
    >
      Гугл-таблица
    </button>
  );
}

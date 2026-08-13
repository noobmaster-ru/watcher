import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

interface SheetState {
  available: boolean;
  url: string | null;
  lastExportAt: string | null;
  lastError: string | null;
}

/**
 * Кнопка «Гугл-таблица» рядом с «Событиями».
 *
 * Если таблица уже создана — открывает её в новой вкладке. Если нет, сначала
 * просит сервер её создать: ссылки до создания попросту не существует, а
 * открывать пустую вкладку и потом в неё что-то дописывать нельзя — браузер
 * блокирует переход, сделанный не по клику.
 */
export function SheetButton() {
  const queryClient = useQueryClient();

  const sheet = useQuery({
    queryKey: ["sheet"],
    queryFn: () => api.get<SheetState>("/api/sheet"),
    staleTime: 60_000,
  });

  const create = useMutation({
    mutationFn: () => api.post<{ spreadsheetUrl: string }>("/api/sheet/export"),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["sheet"] });
      window.open(data.spreadsheetUrl, "_blank", "noopener,noreferrer");
    },
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
      onClick={() => create.mutate()}
      disabled={create.isPending}
      className="shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
      title={create.error ? (create.error as Error).message : "Создать таблицу и выгрузить историю"}
    >
      {create.isPending ? "Создаю таблицу…" : "Гугл-таблица"}
    </button>
  );
}

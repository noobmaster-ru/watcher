import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ErrorBox } from "./ui";

type SessionState = "down" | "needs_human" | "ready" | "network_error";

interface Session {
  available: boolean;
  session: SessionState;
  lastTitle: string;
  lastCheckAt: string | null;
}

/**
 * Состояние сессии браузера Озона. Озон пускает только сессию, прошедшую капчу
 * руками, поэтому иногда нужен человек: панель показывает, что перед
 * браузером агента прямо сейчас, и открывает его окно в новой вкладке.
 */
export function OzonSession() {
  const queryClient = useQueryClient();
  const [showShot, setShowShot] = useState(false);
  const [shotKey, setShotKey] = useState(0);

  const session = useQuery({
    queryKey: ["ozon-session"],
    queryFn: () => api.get<Session>("/api/ozon/session"),
    refetchInterval: 60_000,
  });

  const check = useMutation({
    mutationFn: () => api.post<{ session: SessionState; lastTitle: string }>("/api/ozon/session/check"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ozon-session"] });
      void queryClient.invalidateQueries({ queryKey: ["ozon-watches"] });
      setShotKey((k) => k + 1);
    },
  });

  // Пока вкладка с окном браузера открыта, шлём агенту «человек за рулём»,
  // чтобы он не перезагрузил капчу под руками. Ссылка открывается через
  // window.open, и мы знаем, когда её закрыли.
  const windowRef = useRef<Window | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      if (windowRef.current && !windowRef.current.closed) {
        void api.post("/api/ozon/session/human");
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const openWindow = () => {
    void api.post("/api/ozon/session/human");
    windowRef.current = window.open(
      "/ozon-browser/vnc.html?autoconnect=1&resize=scale&path=ozon-browser/websockify",
      "_blank",
      "noopener,noreferrer",
    );
  };

  const state = session.data?.session ?? "down";
  const styles: Record<SessionState, { dot: string; label: string; hint: string }> = {
    ready: {
      dot: "bg-emerald-500",
      label: "Сессия Озона живая",
      hint: "Цены собираются автоматически. Проверка раз в час.",
    },
    needs_human: {
      dot: "bg-amber-500",
      label: "Озон просит проверку человеком",
      hint: "Откройте окно браузера, пройдите капчу как обычный покупатель и нажмите «Проверить снова». Обычно это нужно раз в несколько дней.",
    },
    down: {
      dot: "bg-slate-400",
      label: "Браузер агента ещё не запускался",
      hint: "Первый запрос к Озону поднимет его. Если Озон покажет капчу — появится кнопка.",
    },
    network_error: {
      dot: "bg-red-500",
      label: "Браузер не дотянулся до Озона",
      hint: "Сеть или прокси не отвечают: если задан OZON_PROXY, он мог протухнуть. Проверьте прокси и нажмите «Проверить снова».",
    },
  };
  const view = styles[state];

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${view.dot}`} />
          <span className="font-medium">{view.label}</span>
          {session.data?.lastCheckAt && (
            <span className="muted">
              · проверено {new Date(session.data.lastCheckAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={openWindow} className={state === "needs_human" ? "btn-primary" : "btn-ghost"}>
            Открыть окно браузера
          </button>
          <button className="btn-ghost" onClick={() => check.mutate()} disabled={check.isPending}>
            {check.isPending ? "Проверяю…" : "Проверить снова"}
          </button>
          <button className="btn-ghost" onClick={() => { setShowShot(!showShot); setShotKey((k) => k + 1); }}>
            {showShot ? "Скрыть экран" : "Показать экран"}
          </button>
        </div>
      </div>

      <p className="muted">{view.hint}</p>
      {session.data?.lastTitle && state !== "ready" && (
        <p className="muted">Что видит браузер: «{session.data.lastTitle}»</p>
      )}
      {check.error != null && <ErrorBox error={check.error} />}

      {showShot && (
        <img
          key={shotKey}
          src={`/api/ozon/session/screenshot?t=${shotKey}`}
          alt="Экран браузера агента"
          className="w-full rounded-lg border border-slate-200 dark:border-slate-800"
          onError={(event) => {
            (event.target as HTMLImageElement).alt = "Браузер ещё не запущен — скриншота нет";
          }}
        />
      )}
    </section>
  );
}

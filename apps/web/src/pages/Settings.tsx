import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Health } from "../lib/api";
import { ErrorBox, Spinner } from "../components/ui";

interface Settings {
  defaults: { intervalMin: number; minIntervalMin: number; maxIntervalMin: number };
}

export function SettingsPage() {
  const queryClient = useQueryClient();

  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/api/health") });


  if (settings.isLoading) return <Spinner />;
  if (settings.error) return <ErrorBox error={settings.error} />;

  return (
    <div className="space-y-6">

      <section className="card space-y-2">
        <h2 className="font-semibold">Проверка цен</h2>
        <p className="muted">
          По умолчанию цены проверяются раз в {settings.data?.defaults.intervalMin} мин. Интервал можно задать для
          каждой подписки: от {settings.data?.defaults.minIntervalMin} мин до{" "}
          {(settings.data?.defaults.maxIntervalMin ?? 1440) / 60} ч.
        </p>
        <p className="muted">
          Артикулы опрашиваются пачками по 100 в одном запросе к Wildberries, поэтому даже сотни отслеживаемых товаров
          почти не нагружают лимиты.
        </p>
      </section>

      <ChangePassword />

      <section className="card space-y-2">
        <h2 className="font-semibold">Состояние сервисов</h2>
        {health.isLoading && <Spinner />}
        {health.data && (
          <div className="space-y-1 text-sm">
            <StatusRow label="База данных" state={health.data.database === "ok" ? "ok" : "down"} />
            <StatusRow label="Wildberries" state={health.data.wb.state} />
            <div className="muted flex justify-between pl-4">
              <span>активный хост карточек</span>
              <span>{health.data.wb.detailHost}</span>
            </div>
            {health.data.wb.hosts.map((host) => (
              <div key={host.host} className="muted flex justify-between pl-4">
                <span>{host.host}</span>
                <span>
                  {host.state}
                  {host.lastStatus !== null && ` (${host.lastStatus})`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () => api.post("/api/auth/password", { current, next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setDone(true);
    },
  });

  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">Смена пароля</h2>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setDone(false);
          change.mutate();
        }}
      >
        <div>
          <label className="label" htmlFor="current">
            Текущий пароль
          </label>
          <input
            id="current"
            type="password"
            className="input"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        <div>
          <label className="label" htmlFor="next">
            Новый пароль
          </label>
          <input
            id="next"
            type="password"
            className="input"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
          <p className="muted mt-1">Минимум 8 символов. Остальные сессии будут завершены.</p>
        </div>

        {change.error != null && <ErrorBox error={change.error} />}
        {done && <p className="text-sm text-emerald-600">Пароль изменён.</p>}

        <button className="btn-primary" disabled={change.isPending || !current || next.length < 8}>
          {change.isPending ? "…" : "Сменить пароль"}
        </button>
      </form>
    </section>
  );
}

function StatusRow({ label, state }: { label: string; state: string }) {
  const color =
    state === "ok"
      ? "text-emerald-600"
      : state === "degraded"
        ? "text-amber-600"
        : state === "off"
          ? "text-slate-400"
          : "text-red-600";
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span className={color}>{state}</span>
    </div>
  );
}

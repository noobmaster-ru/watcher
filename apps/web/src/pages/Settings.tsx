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

      <ChangeEmail />
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

function ChangeEmail() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ user: { email: string } }>("/api/me") });
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [done, setDone] = useState<{ email: string; sheetError: string | null } | null>(null);

  const change = useMutation({
    mutationFn: () => api.post<{ email: string; sheetUpdated: boolean; sheetError: string | null }>("/api/auth/email", { current, email }),
    onSuccess: (data) => {
      setCurrent("");
      setEmail("");
      setDone({ email: data.email, sheetError: data.sheetError });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["sheet"] });
    },
  });

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-semibold">Почта аккаунта</h2>
        <p className="muted">
          Текущая: <span className="font-medium">{me.data?.user.email ?? "…"}</span>. Почта — это и логин, и адрес,
          на который открыт доступ к Гугл-таблице: при смене доступ переоткрывается на новый, а для старого
          закрывается.
        </p>
      </div>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setDone(null);
          change.mutate();
        }}
      >
        <div>
          <label className="label" htmlFor="new-email">
            Новая почта
          </label>
          <input
            id="new-email"
            type="email"
            className="input"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
        </div>
        <div>
          <label className="label" htmlFor="email-password">
            Текущий пароль
          </label>
          <input
            id="email-password"
            type="password"
            className="input"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
            autoComplete="current-password"
          />
        </div>

        {change.error != null && <ErrorBox error={change.error} />}
        {done && (
          <div className="space-y-1 text-sm">
            <p className="text-emerald-600">Почта изменена на {done.email}. Входите теперь по ней.</p>
            {done.sheetError && (
              <p className="text-amber-600">
                Доступ к Гугл-таблице переоткрыть не удалось: {done.sheetError}. Нажмите «Гугл-таблица» —
                выгрузка попробует ещё раз.
              </p>
            )}
          </div>
        )}

        <button className="btn-primary" disabled={change.isPending || !email || !current}>
          {change.isPending ? "…" : "Сменить почту"}
        </button>
      </form>
    </section>
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

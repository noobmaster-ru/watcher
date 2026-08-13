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

      <GoogleSheet />
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

interface SheetSide {
  url: string | null;
  lastExportAt: string | null;
  lastError: string | null;
}

interface SheetState {
  available: boolean;
  serviceAccountEmail: string | null;
  wb: SheetSide;
  ym: SheetSide;
}

function GoogleSheet() {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const sheet = useQuery({ queryKey: ["sheet"], queryFn: () => api.get<SheetState>("/api/sheet") });

  if (sheet.data && !sheet.data.available) {
    return (
      <section className="card space-y-2">
        <h2 className="font-semibold">Гугл-таблица</h2>
        <p className="muted">
          Выгрузка не настроена: на сервере не задан ключ сервисного аккаунта Google.
        </p>
      </section>
    );
  }

  const account = sheet.data?.serviceAccountEmail ?? "";

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-semibold">Гугл-таблицы</h2>
        <p className="muted">
          У каждой площадки своя таблица. Создаёте их вы, в своём Google Диске: у сервисных аккаунтов Google
          нет собственного места на Диске, поэтому создать за вас приложение не может. Зато данные остаются на
          вашем Диске, а не на чужом.
        </p>
      </div>

      <ol className="space-y-2 text-sm">
        <li>
          1. Создайте пустую таблицу:{" "}
          <a className="text-wb underline" href="https://sheets.new" target="_blank" rel="noreferrer">
            sheets.new
          </a>
        </li>
        <li>
          2. «Настройки доступа» → добавьте этот адрес с правом <b>Редактор</b>:
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
              {account}
            </code>
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => {
                void navigator.clipboard.writeText(account);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "скопировано" : "копировать"}
            </button>
          </div>
        </li>
        <li>3. Вставьте ссылку на таблицу сюда:</li>
      </ol>

      <MarketplaceSheet marketplace="wb" label="Wildberries" side={sheet.data?.wb} />
      <MarketplaceSheet marketplace="ym" label="Яндекс Маркет" side={sheet.data?.ym} />
    </section>
  );
}

/** Подключение и обновление таблицы одной площадки. */
function MarketplaceSheet({
  marketplace,
  label,
  side,
}: {
  marketplace: "wb" | "ym";
  label: string;
  side: SheetSide | undefined;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");

  const link = useMutation({
    mutationFn: () => api.post<{ spreadsheetUrl: string }>("/api/sheet/link", { url, marketplace }),
    onSuccess: () => {
      setUrl("");
      void queryClient.invalidateQueries({ queryKey: ["sheet"] });
    },
  });

  const exportNow = useMutation({
    mutationFn: () => api.post<Record<string, number>>("/api/sheet/export", { marketplace }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sheet"] }),
  });

  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-medium">{label}</h3>
        {side?.url ? (
          <a className="text-sm text-wb underline" href={side.url} target="_blank" rel="noreferrer">
            открыть таблицу
          </a>
        ) : (
          <span className="muted text-sm">не подключена</span>
        )}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          link.mutate();
        }}
      >
        <input
          className="input"
          placeholder="https://docs.google.com/spreadsheets/d/…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button className="btn-primary shrink-0" disabled={link.isPending || url.trim().length < 10}>
          {link.isPending ? "…" : side?.url ? "Заменить" : "Подключить"}
        </button>
      </form>

      {link.error != null && <div className="mt-2"><ErrorBox error={link.error} /></div>}

      {side?.url && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={() => exportNow.mutate()} disabled={exportNow.isPending}>
            {exportNow.isPending ? "Выгружаю…" : "Выгрузить сейчас"}
          </button>
          {side.lastExportAt && (
            <span className="muted text-sm">обновлена {new Date(side.lastExportAt).toLocaleString("ru-RU")}</span>
          )}
          {side.lastError && <span className="text-sm text-amber-600">{side.lastError}</span>}
          {exportNow.error != null && <ErrorBox error={exportNow.error} />}
        </div>
      )}
    </div>
  );
}

function ChangeEmail() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ user: { email: string } }>("/api/me") });
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [done, setDone] = useState<{ email: string } | null>(null);

  const change = useMutation({
    mutationFn: () => api.post<{ email: string }>("/api/auth/email", { current, email }),
    onSuccess: (data) => {
      setCurrent("");
      setEmail("");
      setDone({ email: data.email });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["sheet"] });
    },
  });

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-semibold">Почта аккаунта</h2>
        <p className="muted">
          Текущая: <span className="font-medium">{me.data?.user.email ?? "…"}</span>. Это и логин: после смены
          входить нужно по новому адресу. Подключённой Гугл-таблицы смена не касается — ею владеете вы.
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
        {done && <p className="text-sm text-emerald-600">Почта изменена на {done.email}. Входите теперь по ней.</p>}

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

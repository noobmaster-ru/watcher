import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Health } from "../lib/api";
import { ErrorBox, Spinner } from "../components/ui";

interface Settings {
  telegram: { available: boolean; connected: boolean };
  defaults: { intervalMin: number; minIntervalMin: number; maxIntervalMin: number };
}

export function SettingsPage() {
  const queryClient = useQueryClient();

  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/api/health") });

  const bind = useMutation({
    mutationFn: () => api.post<{ url: string }>("/api/telegram/bind"),
    onSuccess: (data) => window.open(data.url, "_blank", "noopener"),
  });

  const unbind = useMutation({
    mutationFn: () => api.post("/api/telegram/unbind"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  if (settings.isLoading) return <Spinner />;
  if (settings.error) return <ErrorBox error={settings.error} />;

  return (
    <div className="space-y-6">
      <section className="card space-y-3">
        <h2 className="font-semibold">Уведомления в Telegram</h2>

        {!settings.data?.telegram.available && (
          <p className="muted">
            Бот не настроен: на сервере не задан <code>TELEGRAM_BOT_TOKEN</code>. События всё равно копятся на вкладке
            «События».
          </p>
        )}

        {settings.data?.telegram.available && (
          <>
            <p className="muted">
              {settings.data.telegram.connected
                ? "Telegram подключён — уведомления приходят в чат с ботом."
                : "Нажмите кнопку: откроется чат с ботом, где нужно нажать «Запустить». Ссылка действует 15 минут."}
            </p>
            <div className="flex gap-2">
              {settings.data.telegram.connected ? (
                <button className="btn-ghost" onClick={() => unbind.mutate()} disabled={unbind.isPending}>
                  Отключить
                </button>
              ) : (
                <button className="btn-primary" onClick={() => bind.mutate()} disabled={bind.isPending}>
                  {bind.isPending ? "…" : "Подключить Telegram"}
                </button>
              )}
              <button className="btn-ghost" onClick={() => queryClient.invalidateQueries({ queryKey: ["settings"] })}>
                Обновить статус
              </button>
            </div>
            {bind.error != null && <ErrorBox error={bind.error} />}
          </>
        )}
      </section>

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

      <section className="card space-y-2">
        <h2 className="font-semibold">Состояние сервисов</h2>
        {health.isLoading && <Spinner />}
        {health.data && (
          <div className="space-y-1 text-sm">
            <StatusRow label="База данных" state={health.data.database === "ok" ? "ok" : "down"} />
            <StatusRow label="Wildberries" state={health.data.wb.state} />
            {health.data.wb.hosts.map((host) => (
              <div key={host.host} className="muted flex justify-between pl-4">
                <span>{host.host}</span>
                <span>
                  {host.state}
                  {host.lastStatus !== null && ` (${host.lastStatus})`}
                </span>
              </div>
            ))}
            <StatusRow label="Telegram" state={health.data.telegram === "on" ? "ok" : "off"} />
          </div>
        )}
      </section>
    </div>
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

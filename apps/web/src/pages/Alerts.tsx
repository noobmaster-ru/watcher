import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Alert } from "../lib/api";
import { ALERT_ICONS, ALERT_LABELS, formatDate, money, percentChange } from "../lib/format";
import { Empty, ErrorBox, Spinner } from "../components/ui";

export function AlertsPage() {
  const queryClient = useQueryClient();

  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: () => api.get<{ alerts: Alert[]; unread: number }>("/api/alerts?limit=100"),
  });

  const markRead = useMutation({
    mutationFn: () => api.post("/api/alerts/read"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });

  if (alerts.isLoading) return <Spinner />;
  if (alerts.error) return <ErrorBox error={alerts.error} />;

  const items = alerts.data?.alerts ?? [];
  if (items.length === 0) {
    return (
      <Empty title="Событий пока нет">
        Как только цена отслеживаемого товара изменится или он пропадёт из наличия — событие появится здесь.
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          События {(alerts.data?.unread ?? 0) > 0 && <span className="muted">· {alerts.data?.unread} новых</span>}
        </h1>
        {(alerts.data?.unread ?? 0) > 0 && (
          <button className="btn-ghost" onClick={() => markRead.mutate()} disabled={markRead.isPending}>
            Отметить прочитанным
          </button>
        )}
      </div>

      <div className="space-y-2">
        {items.map((alert) => {
          const pct = percentChange(alert.oldPrice, alert.newPrice);
          return (
            <div
              key={alert.id}
              className={`card flex items-center gap-4 ${alert.readAt ? "" : "border-l-4 border-l-wb"}`}
            >
              <span className="text-2xl">{ALERT_ICONS[alert.type]}</span>

              <div className="min-w-0 flex-1">
                <Link to={`/product/${alert.nm}`} className="block truncate font-medium hover:text-wb">
                  {alert.name ?? `Артикул ${alert.nm}`}
                </Link>
                <p className="muted truncate">
                  {ALERT_LABELS[alert.type]}
                  {alert.supplierName && ` · ${alert.supplierName}`}
                </p>
              </div>

              <div className="text-right">
                {alert.oldPrice !== null && alert.newPrice !== null ? (
                  <p>
                    <s className="muted">{money(alert.oldPrice)}</s>{" "}
                    <span className="font-semibold">{money(alert.newPrice)}</span>
                    {pct !== null && (
                      <span className={pct > 0 ? " text-red-600" : " text-emerald-600"}>
                        {" "}
                        ({pct > 0 ? "+" : ""}
                        {pct}%)
                      </span>
                    )}
                  </p>
                ) : (
                  <p className="font-semibold">{money(alert.newPrice)}</p>
                )}
                <p className="muted">{formatDate(alert.createdAt)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

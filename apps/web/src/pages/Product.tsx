import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type PricePoint, type Product } from "../lib/api";
import { money, walletPrice } from "../lib/format";
import { ErrorBox, Spinner } from "../components/ui";

const RANGES = [
  { id: "24h", label: "Сутки" },
  { id: "7d", label: "Неделя" },
  { id: "30d", label: "Месяц" },
  { id: "90d", label: "3 месяца" },
  { id: "all", label: "Всё" },
] as const;

export function ProductPage() {
  const { nm } = useParams<{ nm: string }>();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("30d");

  const product = useQuery({
    queryKey: ["product", nm],
    queryFn: () => api.get<{ product: Product; watchId: number | null }>(`/api/product/${nm}`),
    enabled: Boolean(nm),
  });

  const history = useQuery({
    queryKey: ["history", nm, range],
    queryFn: () =>
      api.get<{ points: PricePoint[]; stats: { min: number | null; max: number | null; count: number } }>(
        `/api/product/${nm}/history?range=${range}`,
      ),
    enabled: Boolean(nm),
  });

  const watch = useMutation({
    mutationFn: () => api.post("/api/watches", { kind: "product", product: nm }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["product", nm] });
      void queryClient.invalidateQueries({ queryKey: ["watches"] });
    },
  });

  const unwatch = useMutation({
    mutationFn: (id: number) => api.delete(`/api/watches/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["product", nm] });
      void queryClient.invalidateQueries({ queryKey: ["watches"] });
    },
  });

  if (product.isLoading) return <Spinner label="Спрашиваю Wildberries…" />;
  if (product.error) return <ErrorBox error={product.error} />;
  if (!product.data) return null;

  const item = product.data.product;
  const watchId = product.data.watchId;

  const chartData = (history.data?.points ?? [])
    .filter((point) => point.price !== null)
    .map((point) => ({
      time: new Date(point.checkedAt).getTime(),
      price: point.price,
    }));

  return (
    <div className="space-y-6">
      <div className="card flex flex-col gap-4 sm:flex-row">
        <img
          src={item.image}
          alt={item.name ?? ""}
          className="h-48 w-36 shrink-0 rounded-lg border border-slate-200 object-cover dark:border-slate-800"
        />

        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <h1 className="text-xl font-semibold">{item.name}</h1>
            <p className="muted">
              {item.brand} · артикул {item.nm}
            </p>
          </div>

          {item.supplierId && (
            <p className="text-sm">
              Продавец:{" "}
              <Link to={`/seller/${item.supplierId}`} className="text-wb hover:underline">
                {item.supplier}
              </Link>
            </p>
          )}

          <div className="flex items-baseline gap-3">
            {item.price.product === null ? (
              <span className="text-lg font-semibold text-slate-400">нет в продаже</span>
            ) : (
              <>
                <span className="text-3xl font-bold">{money(item.price.product)}</span>
                {item.price.basic !== null && <s className="muted text-lg">{money(item.price.basic)}</s>}
              </>
            )}
          </div>

          {item.price.product !== null && (
            <p className="muted">
              с WB Кошельком ≈ {money(walletPrice(item.price.product))}
              {item.price.min !== item.price.max &&
                ` · по размерам от ${money(item.price.min)} до ${money(item.price.max)}`}
            </p>
          )}

          <p className="text-sm">
            {item.inStock ? (
              <span className="text-emerald-600">в наличии: {item.totalQuantity} шт.</span>
            ) : (
              <span className="text-amber-600">нет в наличии</span>
            )}
            {item.rating !== null && <span className="muted"> · ★ {item.rating} ({item.reviews} отзывов)</span>}
          </p>

          <div className="flex flex-wrap gap-2 pt-2">
            {watchId ? (
              <button className="btn-ghost" onClick={() => unwatch.mutate(watchId)} disabled={unwatch.isPending}>
                Не отслеживать
              </button>
            ) : (
              <button className="btn-primary" onClick={() => watch.mutate()} disabled={watch.isPending}>
                {watch.isPending ? "…" : "Отслеживать цену"}
              </button>
            )}
            <a className="btn-ghost" href={item.url} target="_blank" rel="noreferrer">
              Открыть на WB
            </a>
          </div>
        </div>
      </div>

      <section className="card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">История цены</h2>
          <div className="flex gap-1">
            {RANGES.map((option) => (
              <button
                key={option.id}
                onClick={() => setRange(option.id)}
                className={`rounded-md px-2.5 py-1 text-xs transition ${
                  range === option.id
                    ? "bg-wb text-white"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {history.isLoading && <Spinner />}
        {history.error != null && <ErrorBox error={history.error} />}

        {chartData.length === 0 && !history.isLoading && history.error == null && (
          <p className="muted py-8 text-center">
            {watchId
              ? "История пока пустая — первая точка появится после следующей проверки."
              : "Поставьте товар на отслеживание, и здесь появится график изменения цены."}
          </p>
        )}

        {chartData.length > 0 && (
          <>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#7b32c9" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#7b32c9" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#94a3b833" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  scale="time"
                  tickFormatter={(value: number) =>
                    new Date(value).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" })
                  }
                  fontSize={12}
                  stroke="#94a3b8"
                />
                <YAxis
                  domain={["dataMin - 100", "dataMax + 100"]}
                  tickFormatter={(value: number) => value.toLocaleString("ru-RU")}
                  fontSize={12}
                  width={64}
                  stroke="#94a3b8"
                />
                <Tooltip
                  labelFormatter={(value) => new Date(value as number).toLocaleString("ru-RU")}
                  formatter={(value) => [money(value as number), "Цена"]}
                  contentStyle={{ borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 13 }}
                />
                <Area
                  type="stepAfter"
                  dataKey="price"
                  stroke="#7b32c9"
                  strokeWidth={2}
                  fill="url(#priceFill)"
                  dot={chartData.length < 40}
                />
              </AreaChart>
            </ResponsiveContainer>

            <div className="muted mt-3 flex flex-wrap gap-4">
              <span>минимум {money(history.data?.stats.min ?? null)}</span>
              <span>максимум {money(history.data?.stats.max ?? null)}</span>
              <span>точек: {history.data?.stats.count ?? 0}</span>
            </div>
          </>
        )}
      </section>

      {item.characteristics && Object.keys(item.characteristics).length > 0 && (
        <section className="card">
          <h2 className="mb-3 font-semibold">Характеристики</h2>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {Object.entries(item.characteristics).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4 border-b border-dashed border-slate-200 py-1 dark:border-slate-800">
                <dt className="muted">{key}</dt>
                <dd className="text-right text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {item.description && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Описание</h2>
          <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">{item.description}</p>
        </section>
      )}
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDate, money } from "../lib/format";
import { Delta, Empty, ErrorBox, Spinner } from "../components/ui";

interface OzonWatch {
  id: number;
  sku: string;
  name: string | null;
  image: string | null;
  url: string | null;
  lastPrice: number | null;
  lastCardPrice: number | null;
  lastInStock: boolean | null;
  lastCheckedAt: string | null;
  priceDayAgo: number | null;
  priceWeekAgo: number | null;
}

interface OzonItem {
  sku: string;
  name: string | null;
  price: number | null;
  image: string | null;
  url: string;
}

export function OzonPage() {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");

  const watches = useQuery({
    queryKey: ["ozon-watches"],
    queryFn: () => api.get<{ available: boolean; watches: OzonWatch[] }>("/api/ozon/watches"),
  });

  const add = useMutation({
    mutationFn: (product: string) => api.post("/api/ozon/watches", { product }),
    onSuccess: () => {
      setInput("");
      void queryClient.invalidateQueries({ queryKey: ["ozon-watches"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/ozon/watches/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ozon-watches"] }),
  });

  const search = useMutation({
    mutationFn: (q: string) => api.get<{ items: OzonItem[] }>(`/api/ozon/search?q=${encodeURIComponent(q)}`),
  });

  if (watches.data && !watches.data.available) {
    return (
      <Empty title="Озон не подключён">
        На сервере не настроен агент Озона (OZON_AGENT_URL). Остальные площадки работают как обычно.
      </Empty>
    );
  }

  const items = watches.data?.watches ?? [];

  return (
    <div className="space-y-6">
      <form
        className="card space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate(input.trim());
        }}
      >
        <div>
          <label className="label" htmlFor="ozon">
            Номер товара Озона (SKU) или ссылка на него
          </label>
          <input
            id="ozon"
            className="input"
            placeholder="1587315442 или https://www.ozon.ru/product/…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            required
          />
          <p className="muted mt-1">
            Проверка идёт через встроенный браузер: Озон закрыт антиботом, и обычные запросы он отбивает.
            Первое добавление может занять до полуминуты — браузер проходит проверку Озона.
          </p>
        </div>
        {add.error != null && <ErrorBox error={add.error} />}
        <button className="btn-primary" disabled={add.isPending || input.trim().length < 5}>
          {add.isPending ? "Прохожу антибот Озона…" : "Отслеживать цену"}
        </button>
      </form>

      <form
        className="card space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          search.mutate(query.trim());
        }}
      >
        <label className="label" htmlFor="ozq">
          Не знаете номер — найдите товар
        </label>
        <div className="flex gap-2">
          <input
            id="ozq"
            className="input"
            placeholder="шампуры для шашлыка"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="btn-ghost shrink-0" disabled={search.isPending || query.trim().length < 2}>
            {search.isPending ? "…" : "Найти"}
          </button>
        </div>
        {search.error != null && <ErrorBox error={search.error} />}

        {search.data && (
          <div className="space-y-2">
            {search.data.items.map((item) => (
              <div key={item.sku} className="flex items-center gap-3 border-t border-slate-100 pt-2 dark:border-slate-800">
                {item.image && <img src={item.image} alt="" className="h-12 w-12 rounded object-cover" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{item.name}</p>
                  <p className="muted">№ {item.sku}</p>
                </div>
                <span className="font-semibold">{money(item.price)}</span>
                <button className="btn-ghost" onClick={() => add.mutate(item.sku)} disabled={add.isPending}>
                  Отслеживать
                </button>
              </div>
            ))}
            {search.data.items.length === 0 && <p className="muted">Ничего не нашлось.</p>}
          </div>
        )}
      </form>

      {watches.isLoading && <Spinner />}
      {watches.error != null && <ErrorBox error={watches.error} />}

      {!watches.isLoading && items.length === 0 && (
        <Empty title="С Озона пока ничего не отслеживается">
          Добавьте товар — его цена (обычная и с Ozon Картой) начнёт попадать в историю и в отдельную
          Гугл-таблицу Озона.
        </Empty>
      )}

      {items.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Товары Озона ({items.length})</h2>
          {items.map((watch) => (
            <div key={watch.id} className="card flex items-center gap-4">
              {watch.image ? (
                <img src={watch.image} alt="" className="h-16 w-12 rounded-md object-cover" />
              ) : (
                <div className="h-16 w-12 rounded-md bg-slate-100 dark:bg-slate-800" />
              )}

              <div className="min-w-0 flex-1">
                <a
                  href={watch.url ?? `https://www.ozon.ru/product/${watch.sku}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-medium hover:text-wb"
                >
                  {watch.name ?? `Товар ${watch.sku}`}
                </a>
                <p className="muted">№ {watch.sku}</p>
                <p className="muted">последняя проверка {formatDate(watch.lastCheckedAt)}</p>
              </div>

              <div className="text-right">
                <p className="text-lg font-semibold">
                  {watch.lastPrice === null ? <span className="text-slate-400">нет в продаже</span> : money(watch.lastPrice)}
                </p>
                {watch.lastCardPrice !== null && (
                  <p className="muted">с Ozon Картой {money(watch.lastCardPrice)}</p>
                )}
                <div className="muted flex justify-end gap-3">
                  <span>
                    сутки <Delta from={watch.priceDayAgo} to={watch.lastPrice} />
                  </span>
                  <span>
                    неделя <Delta from={watch.priceWeekAgo} to={watch.lastPrice} />
                  </span>
                </div>
              </div>

              <button onClick={() => remove.mutate(watch.id)} className="muted hover:text-red-600" title="Убрать">
                ✕
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

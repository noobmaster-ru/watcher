import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDate, money } from "../lib/format";
import { Delta, Empty, ErrorBox, Spinner } from "../components/ui";

interface YmWatch {
  id: number;
  sku: string;
  name: string | null;
  image: string | null;
  url: string | null;
  lastPrice: number | null;
  lastInStock: boolean | null;
  lastCheckedAt: string | null;
  intervalMin: number;
  priceDayAgo: number | null;
  priceWeekAgo: number | null;
}

interface YmProduct {
  sku: string;
  name: string | null;
  price: number | null;
  inStock: boolean;
  image: string | null;
  url: string;
}

export function MarketPage() {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");

  const watches = useQuery({
    queryKey: ["ym-watches"],
    queryFn: () => api.get<{ watches: YmWatch[] }>("/api/ym/watches"),
  });

  const [candidates, setCandidates] = useState<{ query: string; items: YmProduct[] } | null>(null);

  const add = useMutation({
    mutationFn: (product: string) => api.post("/api/ym/watches", { product }),
    onSuccess: () => {
      setInput("");
      setCandidates(null);
      void queryClient.invalidateQueries({ queryKey: ["ym-watches"] });
    },
    onError: (error) => {
      // По ссылке товар определяется неточно, поэтому сервер возвращает
      // кандидатов, а выбирает человек
      const payload = (error as { payload?: { candidates?: YmProduct[]; query?: string } }).payload;
      if (payload?.candidates?.length) setCandidates({ query: payload.query ?? "", items: payload.candidates });
      else setCandidates(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/ym/watches/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ym-watches"] }),
  });

  const search = useMutation({
    mutationFn: (q: string) => api.get<{ items: YmProduct[] }>(`/api/ym/search?q=${encodeURIComponent(q)}`),
  });

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
          <label className="label" htmlFor="ym">
            Номер товара Яндекс Маркета или ссылка на него
          </label>
          <input
            id="ym"
            className="input"
            placeholder="103522724497 или https://market.yandex.ru/card/…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            required
          />
          <p className="muted mt-1">
            Надёжнее всего номер товара. Ссылку тоже можно вставить, но по ней товар определяется неточно —
            число в адресе Маркета не совпадает с номером товара, — поэтому приложение покажет найденное и
            попросит выбрать. Не знаете номер — воспользуйтесь поиском ниже.
          </p>
        </div>
        {add.error != null && <ErrorBox error={add.error} />}
        <button className="btn-primary" disabled={add.isPending || input.trim().length < 4}>
          {add.isPending ? "Смотрю на Маркете…" : "Отслеживать цену"}
        </button>

        {candidates && (
          <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <p className="muted">Найдено по запросу «{candidates.query}» — выберите нужный товар:</p>
            {candidates.items.map((item) => (
              <div key={item.sku} className="flex items-center gap-3">
                {item.image && <img src={item.image} alt="" className="h-10 w-10 rounded object-cover" />}
                <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                <span className="font-semibold">{money(item.price)}</span>
                <button type="button" className="btn-ghost" onClick={() => add.mutate(item.sku)}>
                  Это он
                </button>
              </div>
            ))}
          </div>
        )}
      </form>

      <form
        className="card space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          search.mutate(query.trim());
        }}
      >
        <label className="label" htmlFor="ymq">
          Не знаете номер — найдите товар
        </label>
        <div className="flex gap-2">
          <input
            id="ymq"
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
        <Empty title="С Яндекс Маркета пока ничего не отслеживается">
          Добавьте товар — и его цена начнёт попадать в историю и в отдельную Гугл-таблицу Маркета.
        </Empty>
      )}

      {items.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Товары Маркета ({items.length})</h2>
          {items.map((watch) => (
            <div key={watch.id} className="card flex items-center gap-4">
              {watch.image ? (
                <img src={watch.image} alt="" className="h-16 w-12 rounded-md object-cover" />
              ) : (
                <div className="h-16 w-12 rounded-md bg-slate-100 dark:bg-slate-800" />
              )}

              <div className="min-w-0 flex-1">
                <a
                  href={watch.url ?? `https://market.yandex.ru/search?text=${watch.sku}`}
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

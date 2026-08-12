import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, type Product } from "../lib/api";
import { money } from "../lib/format";
import { ErrorBox, PriceTag, ProductThumb, Spinner } from "../components/ui";

type Tab = "product" | "seller" | "search";

export function AddPage() {
  const [tab, setTab] = useState<Tab>("product");

  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        <TabButton active={tab === "product"} onClick={() => setTab("product")}>
          По артикулу
        </TabButton>
        <TabButton active={tab === "seller"} onClick={() => setTab("seller")}>
          По продавцу
        </TabButton>
        <TabButton active={tab === "search"} onClick={() => setTab("search")}>
          Поиском
        </TabButton>
      </div>

      {tab === "product" && <AddProduct />}
      {tab === "seller" && <AddSeller />}
      {tab === "search" && <SearchProducts />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-4 py-2 text-sm transition ${
        active
          ? "bg-wb text-white"
          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
      }`}
    >
      {children}
    </button>
  );
}

function AddProduct() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");

  const add = useMutation({
    mutationFn: (product: string) =>
      api.post<{ nm: number }>("/api/watches", { kind: "product", product }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["watches"] });
      navigate(`/product/${data.nm}`);
    },
  });

  return (
    <form
      className="card space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(value.trim());
      }}
    >
      <div>
        <label className="label" htmlFor="nm">
          Артикул или ссылка на товар
        </label>
        <input
          id="nm"
          className="input"
          placeholder="242678284 или https://www.wildberries.ru/catalog/242678284/detail.aspx"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          required
        />
        <p className="muted mt-1">Артикул виден в адресе карточки после /catalog/</p>
      </div>

      {add.error != null && <ErrorBox error={add.error} />}

      <button className="btn-primary" disabled={add.isPending || !value.trim()}>
        {add.isPending ? "Проверяю на Wildberries…" : "Отслеживать"}
      </button>
    </form>
  );
}

function AddSeller() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");

  return (
    <form
      className="card space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const match = value.trim().match(/seller\/(\d+)/) ?? value.trim().match(/(\d+)/);
        if (match?.[1]) navigate(`/seller/${match[1]}`);
      }}
    >
      <div>
        <label className="label" htmlFor="seller">
          ID продавца или ссылка на его страницу
        </label>
        <input
          id="seller"
          className="input"
          placeholder="809881 или https://www.wildberries.ru/seller/809881"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          required
        />
        <p className="muted mt-1">
          Откроется страница продавца: там можно посмотреть каталог и поставить на отслеживание весь ассортимент или
          отдельные товары.
        </p>
      </div>

      <button className="btn-primary" disabled={!value.trim()}>
        Открыть продавца
      </button>
    </form>
  );
}

function SearchProducts() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const queryClient = useQueryClient();

  const search = useMutation({
    mutationFn: (q: string) => api.get<{ items: Product[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=24`),
  });

  const add = useMutation({
    mutationFn: (nm: string) => api.post("/api/watches", { kind: "product", product: nm }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["watches"] }),
  });

  return (
    <div className="space-y-4">
      <form
        className="card space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
          search.mutate(query.trim());
        }}
      >
        <div>
          <label className="label" htmlFor="q">
            Поисковый запрос
          </label>
          <input
            id="q"
            className="input"
            placeholder="носки мужские"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            required
          />
          <p className="muted mt-1">
            Поиск Wildberries жёстко ограничивает частые запросы. Если выдача пустая — подождите минуту и повторите.
          </p>
        </div>
        <button className="btn-primary" disabled={search.isPending || !query.trim()}>
          {search.isPending ? "Ищу…" : "Найти"}
        </button>
      </form>

      {search.isPending && <Spinner label="Спрашиваю Wildberries…" />}
      {search.error != null && <ErrorBox error={search.error} />}

      {search.data && (
        <div className="space-y-2">
          <p className="muted">
            Найдено {search.data.items.length} по запросу «{submitted}»
          </p>
          {search.data.items.map((item) => (
            <div key={item.nm} className="card flex items-center gap-4">
              <ProductThumb nm={item.nm} image={item.image} name={item.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{item.name}</p>
                <p className="muted truncate">
                  {item.brand} · {item.supplier}
                </p>
                <p className="muted">Артикул {item.nm}</p>
              </div>
              <div className="text-right">
                <PriceTag price={item.price.product} basic={item.price.basic} />
                {item.rating !== null && <p className="muted">★ {item.rating}</p>}
              </div>
              <button className="btn-ghost" onClick={() => add.mutate(item.nm)} disabled={add.isPending}>
                Отслеживать
              </button>
            </div>
          ))}
          {search.data.items.length === 0 && <p className="muted">Ничего не нашлось — попробуйте другой запрос.</p>}
        </div>
      )}
    </div>
  );
}

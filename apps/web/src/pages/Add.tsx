import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, type Product } from "../lib/api";
import { ErrorBox, PriceTag, ProductThumb, Spinner } from "../components/ui";

type Tab = "product" | "seller" | "search";

export function AddPage() {
  const [tab, setTab] = useState<Tab>("product");

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Способ добавления" className="flex gap-1">
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
      role="tab"
      aria-selected={active}
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
          autoFocus
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

  const resolve = useMutation({
    mutationFn: (input: string) =>
      api.get<{
        supplierId: number | null;
        name: string | null;
        source: string;
        query?: string;
        productName?: string;
        candidates?: Array<{ supplierId: number; name: string; products: number }>;
      }>(`/api/seller/resolve?input=${encodeURIComponent(input)}`),
    onSuccess: (data) => {
      if (data.supplierId) navigate(`/seller/${data.supplierId}`);
    },
  });

  const candidates = resolve.data?.candidates ?? [];

  return (
    <div className="space-y-4">
      <form
        className="card space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          resolve.mutate(value.trim());
        }}
      >
        <div>
          <label className="label" htmlFor="seller">
            Продавец: ID, ссылка на страницу или на любой его товар
          </label>
          <input
            id="seller"
            className="input"
            placeholder="wildberries.ru/seller/shampur-yug"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            autoFocus
          />
          <p className="muted mt-1">
            Подходит и числовой адрес (<code>/seller/809881</code>), и буквенный (
            <code>/seller/shampur-yug</code>). Буквенный Wildberries по своему API не отдаёт, поэтому продавец
            ищется по названию — если совпадение неточное, покажу варианты. Самый надёжный способ: вставить
            ссылку на любой товар этого продавца.
          </p>
        </div>

        {resolve.error != null && <ErrorBox error={resolve.error} />}

        <button className="btn-primary" disabled={resolve.isPending || !value.trim()}>
          {resolve.isPending ? "Ищу продавца…" : "Найти продавца"}
        </button>
      </form>

      {resolve.isPending && <Spinner label="Спрашиваю Wildberries…" />}

      {candidates.length > 0 && (
        <div className="card space-y-3">
          <div>
            <p className="font-medium">Точного совпадения нет — выберите продавца</p>
            <p className="muted">
              Искал по запросу «{resolve.data?.query}». Если нужного нет в списке, вставьте ссылку на любой
              товар этого продавца — тогда он определится точно.
            </p>
          </div>
          <div className="space-y-2">
            {candidates.map((candidate) => (
              <button
                key={candidate.supplierId}
                onClick={() => navigate(`/seller/${candidate.supplierId}`)}
                className="btn-ghost w-full justify-between"
              >
                <span>{candidate.name}</span>
                <span className="muted">
                  ID {candidate.supplierId} · {candidate.products} товаров в выдаче
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SearchProducts() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const queryClient = useQueryClient();

  const search = useMutation({
    mutationFn: (q: string) => api.get<{ items: Product[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=24`),
  });

  // Какие артикулы уже поставлены на отслеживание из этой выдачи: кнопка
  // превращается в галочку, иначе непонятно, сработал клик или нет.
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());

  const add = useMutation({
    mutationFn: (nm: string) => api.post("/api/watches", { kind: "product", product: nm }),
    onSuccess: (_data, nm) => {
      setAdded((prev) => new Set(prev).add(nm));
      void queryClient.invalidateQueries({ queryKey: ["watches"] });
    },
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
            autoFocus
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
      {add.error != null && <ErrorBox error={add.error} />}

      {search.data && (
        <div className="space-y-2">
          <p className="muted">
            Найдено {search.data.items.length} по запросу «{submitted}»
          </p>
          {search.data.items.map((item) => (
            <div key={item.nm} className="card flex flex-wrap items-center gap-x-4 gap-y-2">
              <ProductThumb nm={item.nm} image={item.image} name={item.name} />
              <div className="min-w-[12rem] flex-1">
                <p className="truncate font-medium">{item.name}</p>
                <p className="muted truncate">
                  {item.brand} · {item.supplier}
                </p>
                <p className="muted nums">Артикул {item.nm}</p>
              </div>
              <div className="ml-auto text-right">
                <PriceTag price={item.price.product} basic={item.price.basic} />
                {item.rating !== null && <p className="muted">★ {item.rating}</p>}
              </div>
              {added.has(item.nm) ? (
                <span className="btn-ghost pointer-events-none text-emerald-600 dark:text-emerald-400">
                  Отслеживается ✓
                </span>
              ) : (
                <button className="btn-ghost" onClick={() => add.mutate(item.nm)} disabled={add.isPending}>
                  Отслеживать
                </button>
              )}
            </div>
          ))}
          {search.data.items.length === 0 && <p className="muted">Ничего не нашлось — попробуйте другой запрос.</p>}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api, type Product, type Seller } from "../lib/api";
import { ErrorBox, ListSkeleton, PriceTag, ProductThumb, Spinner } from "../components/ui";

export function SellerPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);

  const seller = useQuery({
    queryKey: ["seller", id],
    queryFn: () => api.get<{ seller: Seller; watchId: number | null }>(`/api/seller/${id}`),
    enabled: Boolean(id),
  });

  const catalog = useQuery({
    queryKey: ["seller", id, "products", page],
    queryFn: () =>
      api.get<{ products: Product[]; total: number | null }>(`/api/seller/${id}/products?page=${page}`),
    enabled: Boolean(id),
  });

  const watchSeller = useMutation({
    mutationFn: () => api.post<{ productCount: number }>("/api/watches", { kind: "seller", seller: id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["seller", id] });
      void queryClient.invalidateQueries({ queryKey: ["watches"] });
    },
  });

  const unwatch = useMutation({
    mutationFn: (watchId: number) => api.delete(`/api/watches/${watchId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["seller", id] });
      void queryClient.invalidateQueries({ queryKey: ["watches"] });
    },
  });

  // Какие артикулы уже добавлены с этой страницы — кнопка меняется на галочку
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());

  const watchProduct = useMutation({
    mutationFn: (nm: string) => api.post("/api/watches", { kind: "product", product: nm }),
    onSuccess: (_data, nm) => {
      setAdded((prev) => new Set(prev).add(nm));
      void queryClient.invalidateQueries({ queryKey: ["watches"] });
    },
  });

  if (seller.isLoading) return <Spinner label="Спрашиваю Wildberries…" />;
  if (seller.error) return <ErrorBox error={seller.error} />;
  if (!seller.data) return null;

  const info = seller.data.seller;
  const watchId = seller.data.watchId;

  return (
    <div className="space-y-6">
      <div className="card space-y-2">
        <h1 className="text-xl font-semibold">{info.name ?? `Продавец ${info.supplierId}`}</h1>
        {info.fullName && info.fullName !== info.name && <p className="muted">{info.fullName}</p>}
        <div className="muted flex flex-wrap gap-4">
          <span>ID {info.supplierId}</span>
          {info.inn && <span>ИНН {info.inn}</span>}
          {info.trademark && <span>Марка: {info.trademark}</span>}
          {catalog.data?.total != null && <span>Товаров: {catalog.data.total.toLocaleString("ru-RU")}</span>}
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          {watchId ? (
            <button className="btn-ghost" onClick={() => unwatch.mutate(watchId)} disabled={unwatch.isPending}>
              Не отслеживать каталог
            </button>
          ) : (
            <button className="btn-primary" onClick={() => watchSeller.mutate()} disabled={watchSeller.isPending}>
              {watchSeller.isPending ? "Загружаю каталог…" : "Отслеживать весь каталог"}
            </button>
          )}
          <a
            className="btn-ghost"
            href={`https://www.wildberries.ru/seller/${info.supplierId}`}
            target="_blank"
            rel="noreferrer"
          >
            Открыть на WB
          </a>
        </div>

        {watchSeller.error != null && <ErrorBox error={watchSeller.error} />}
        {unwatch.error != null && <ErrorBox error={unwatch.error} />}
        {watchSeller.data && (
          <p className="text-sm text-emerald-600">
            Под наблюдением {watchSeller.data.productCount} товаров. Новые позиции продавца будут добавляться сами.
          </p>
        )}
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Каталог</h2>
          <div className="flex items-center gap-2">
            <button
              className="btn-ghost px-3 py-1"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
              aria-label="Предыдущая страница"
            >
              ←
            </button>
            <span className="muted">стр. {page}</span>
            <button
              className="btn-ghost px-3 py-1"
              disabled={(catalog.data?.products.length ?? 0) < 100}
              onClick={() => setPage(page + 1)}
              aria-label="Следующая страница"
            >
              →
            </button>
          </div>
        </div>

        {catalog.isLoading && <ListSkeleton rows={5} />}
        {catalog.error != null && <ErrorBox error={catalog.error} />}
        {watchProduct.error != null && <ErrorBox error={watchProduct.error} />}

        {catalog.data?.products.length === 0 && (
          <p className="muted card">
            Wildberries не вернул товары этого продавца. Это бывает и когда каталог действительно пуст, и когда WB
            ограничивает запросы — попробуйте через минуту.
          </p>
        )}

        {catalog.data?.products.map((item) => (
          <div key={item.nm} className="card flex flex-wrap items-center gap-x-4 gap-y-2">
            <ProductThumb nm={item.nm} image={item.image} name={item.name} />
            <div className="min-w-[12rem] flex-1">
              <p className="truncate font-medium">{item.name}</p>
              <p className="muted truncate">
                {item.brand} · артикул <span className="nums">{item.nm}</span>
              </p>
            </div>
            <div className="ml-auto text-right">
              <PriceTag price={item.price.product} basic={item.price.basic} />
              {!item.inStock && <p className="text-xs text-amber-600">нет в наличии</p>}
            </div>
            {added.has(item.nm) ? (
              <span className="btn-ghost pointer-events-none text-emerald-600 dark:text-emerald-400">
                Отслеживается ✓
              </span>
            ) : (
              <button
                className="btn-ghost"
                onClick={() => watchProduct.mutate(item.nm)}
                disabled={watchProduct.isPending}
              >
                Отслеживать
              </button>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

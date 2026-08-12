import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Watch } from "../lib/api";
import { formatDate, formatInterval, money } from "../lib/format";
import { Delta, Empty, ErrorBox, PriceTag, ProductThumb, Spinner } from "../components/ui";

export function DashboardPage() {
  const queryClient = useQueryClient();
  const watches = useQuery({
    queryKey: ["watches"],
    queryFn: () => api.get<{ watches: Watch[] }>("/api/watches"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/watches/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["watches"] }),
  });

  if (watches.isLoading) return <Spinner />;
  if (watches.error) return <ErrorBox error={watches.error} />;

  const items = watches.data?.watches ?? [];
  const products = items.filter((w) => w.kind === "product");
  const sellers = items.filter((w) => w.kind === "seller");

  if (items.length === 0) {
    return (
      <Empty title="Пока ничего не отслеживается">
        Добавьте артикул товара или продавца целиком — и watcher начнёт следить за ценой.{" "}
        <Link to="/add" className="text-wb underline">
          Добавить
        </Link>
      </Empty>
    );
  }

  return (
    <div className="space-y-8">
      {products.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Товары ({products.length})</h2>
          <div className="space-y-2">
            {products.map((watch) => (
              <ProductRow key={watch.id} watch={watch} onRemove={() => remove.mutate(watch.id)} />
            ))}
          </div>
        </section>
      )}

      {sellers.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Продавцы ({sellers.length})</h2>
          <div className="space-y-2">
            {sellers.map((watch) => (
              <SellerRow key={watch.id} watch={watch} onRemove={() => remove.mutate(watch.id)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ProductRow({ watch, onRemove }: { watch: Watch; onRemove: () => void }) {
  const nm = watch.nm!;
  // Ссылку на картинку считает сервер: шард CDN выбирается по таблице из 46
  // хостов, и угадать его на клиенте нельзя — почти все превью были бы 404.
  const image = watch.image ?? "";

  return (
    <div className="card flex items-center gap-4">
      <ProductThumb nm={nm} image={image} name={watch.productName} />

      <div className="min-w-0 flex-1">
        <Link to={`/product/${nm}`} className="block truncate font-medium hover:text-wb">
          {watch.productName ?? watch.title ?? `Артикул ${nm}`}
        </Link>
        <p className="muted truncate">
          {watch.brand && <span>{watch.brand} · </span>}
          {watch.supplierName ?? "продавец неизвестен"}
        </p>
        <p className="muted">
          Проверка {formatInterval(watch.intervalMin)} · последняя {formatDate(watch.lastCheckedAt)}
        </p>
      </div>

      <div className="text-right">
        <PriceTag price={watch.lastPrice} basic={watch.lastBasic} />
        <div className="muted flex justify-end gap-3">
          <span>
            сутки <Delta from={watch.priceDayAgo} to={watch.lastPrice} />
          </span>
          <span>
            неделя <Delta from={watch.priceWeekAgo} to={watch.lastPrice} />
          </span>
        </div>
        {watch.lastInStock === false && <p className="text-sm text-amber-600">нет в наличии</p>}
      </div>

      <button onClick={onRemove} className="muted hover:text-red-600" title="Убрать из отслеживания">
        ✕
      </button>
    </div>
  );
}

function SellerRow({ watch, onRemove }: { watch: Watch; onRemove: () => void }) {
  return (
    <div className="card flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <Link to={`/seller/${watch.supplierId}`} className="block truncate font-medium hover:text-wb">
          {watch.sellerName ?? watch.title ?? `Продавец ${watch.supplierId}`}
        </Link>
        <p className="muted">
          {watch.trackedProducts ?? 0} товаров под наблюдением · проверка {formatInterval(watch.intervalMin)}
        </p>
      </div>

      <div className="text-right">
        <p className="muted">
          порог {watch.minChangePct}%{watch.minChangeAbs > 0 && ` / ${money(watch.minChangeAbs)}`}
        </p>
      </div>

      <button onClick={onRemove} className="muted hover:text-red-600" title="Убрать из отслеживания">
        ✕
      </button>
    </div>
  );
}

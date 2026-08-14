import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Watch } from "../lib/api";
import { formatDate, formatInterval, money, percentChange } from "../lib/format";
import { Delta, Empty, ErrorBox, ListSkeleton, PriceTag, ProductThumb, RemoveButton } from "../components/ui";

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

  if (watches.isLoading) return <ListSkeleton rows={4} />;
  if (watches.error) return <ErrorBox error={watches.error} />;

  const items = watches.data?.watches ?? [];
  const products = items.filter((w) => w.kind === "product");
  const sellers = items.filter((w) => w.kind === "seller");

  if (items.length === 0) {
    return (
      <Empty
        title="Пока ничего не отслеживается"
        action={
          <Link to="/add" className="btn-primary">
            Добавить товар или продавца
          </Link>
        }
      >
        Добавьте артикул товара или продавца целиком — и watcher начнёт следить за ценой.
      </Empty>
    );
  }

  return (
    <div className="space-y-8">
      {remove.error != null && <ErrorBox error={remove.error} />}

      {products.length > 0 && (
        <section>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Товары ({products.length})</h2>
            <DaySummary products={products} />
          </div>
          <div className="space-y-2">
            {products.map((watch) => (
              <ProductRow
                key={watch.id}
                watch={watch}
                pending={remove.isPending && remove.variables === watch.id}
                onRemove={() => remove.mutate(watch.id)}
              />
            ))}
          </div>
        </section>
      )}

      {sellers.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Продавцы ({sellers.length})</h2>
          <div className="space-y-2">
            {sellers.map((watch) => (
              <SellerRow
                key={watch.id}
                watch={watch}
                pending={remove.isPending && remove.variables === watch.id}
                onRemove={() => remove.mutate(watch.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Сводка за сутки: сколько позиций подешевело, подорожало и выпало из наличия.
 *  Считается из уже загруженных строк — отдельного запроса не нужно. */
function DaySummary({ products }: { products: Watch[] }) {
  let dropped = 0;
  let risen = 0;
  let outOfStock = 0;
  for (const watch of products) {
    const pct = percentChange(watch.priceDayAgo, watch.lastPrice);
    if (pct !== null && pct < 0) dropped += 1;
    if (pct !== null && pct > 0) risen += 1;
    if (watch.lastInStock === false) outOfStock += 1;
  }
  if (dropped === 0 && risen === 0 && outOfStock === 0) return null;

  return (
    <p className="muted flex flex-wrap gap-3">
      {dropped > 0 && <span className="text-emerald-600 dark:text-emerald-400">↓ подешевело: {dropped}</span>}
      {risen > 0 && <span className="text-red-600 dark:text-red-400">↑ подорожало: {risen}</span>}
      {outOfStock > 0 && <span className="text-amber-600 dark:text-amber-400">нет в наличии: {outOfStock}</span>}
    </p>
  );
}

function ProductRow({ watch, pending, onRemove }: { watch: Watch; pending: boolean; onRemove: () => void }) {
  const nm = watch.nm!;
  // Ссылку на картинку считает сервер: шард CDN выбирается по таблице из 46
  // хостов, и угадать его на клиенте нельзя — почти все превью были бы 404.
  const image = watch.image ?? "";

  return (
    <div className="card flex flex-wrap items-center gap-x-4 gap-y-2">
      <ProductThumb nm={nm} image={image} name={watch.productName} />

      <div className="min-w-[12rem] flex-1">
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

      <div className="ml-auto text-right">
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

      <RemoveButton onConfirm={onRemove} pending={pending} />
    </div>
  );
}

function SellerRow({ watch, pending, onRemove }: { watch: Watch; pending: boolean; onRemove: () => void }) {
  return (
    <div className="card flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-[12rem] flex-1">
        <Link to={`/seller/${watch.supplierId}`} className="block truncate font-medium hover:text-wb">
          {watch.sellerName ?? watch.title ?? `Продавец ${watch.supplierId}`}
        </Link>
        <p className="muted">
          {watch.trackedProducts ?? 0} товаров под наблюдением · проверка {formatInterval(watch.intervalMin)}
        </p>
      </div>

      <div className="ml-auto text-right">
        <p className="muted">
          порог {watch.minChangePct}%{watch.minChangeAbs > 0 && ` / ${money(watch.minChangeAbs)}`}
        </p>
      </div>

      <RemoveButton onConfirm={onRemove} pending={pending} />
    </div>
  );
}

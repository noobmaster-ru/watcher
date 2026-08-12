import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { formatDate, formatInterval } from "../lib/format";
import { Empty, ErrorBox, Spinner } from "../components/ui";

interface Position {
  nm: number;
  position: number | null;
  page: number | null;
  checkedAt: string;
  name: string | null;
}

interface Keyword {
  id: number;
  phrase: string;
  isActive: boolean;
  maxPages: number;
  intervalMin: number;
  lastCheckedAt: string | null;
  lastTotal: number | null;
  positions: Position[];
}

export function KeywordsPage() {
  const queryClient = useQueryClient();
  const [phrase, setPhrase] = useState("");

  const keywords = useQuery({
    queryKey: ["keywords"],
    queryFn: () => api.get<{ keywords: Keyword[] }>("/api/keywords"),
  });

  const add = useMutation({
    mutationFn: (value: string) => api.post<{ found: number; scanned: number; note?: string }>("/api/keywords", { phrase: value }),
    onSuccess: () => {
      setPhrase("");
      void queryClient.invalidateQueries({ queryKey: ["keywords"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/keywords/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["keywords"] }),
  });

  const items = keywords.data?.keywords ?? [];

  return (
    <div className="space-y-6">
      <form
        className="card space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate(phrase.trim());
        }}
      >
        <div>
          <label className="label" htmlFor="phrase">
            Ключевое слово
          </label>
          <input
            id="phrase"
            className="input"
            placeholder="шампуры для шашлыка"
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            required
            minLength={2}
          />
          <p className="muted mt-1">
            Watcher будет искать по этому запросу и записывать, на каком месте выдачи стоят ваши отслеживаемые
            товары. Просматриваются первые 300 позиций — дальше в выдаче Wildberries смысла мало.
          </p>
        </div>

        {add.error != null && <ErrorBox error={add.error} />}
        {add.data?.note && <p className="text-sm text-amber-600">{add.data.note}</p>}

        <button className="btn-primary" disabled={add.isPending || phrase.trim().length < 2}>
          {add.isPending ? "Проверяю выдачу…" : "Отслеживать позиции"}
        </button>
      </form>

      {keywords.isLoading && <Spinner />}
      {keywords.error != null && <ErrorBox error={keywords.error} />}

      {!keywords.isLoading && items.length === 0 && (
        <Empty title="Ключевых слов пока нет">
          Добавьте запрос — и увидите, как ваши товары двигаются в выдаче Wildberries. История позиций попадает и
          в Гугл-таблицу, на лист «Ключевые слова».
        </Empty>
      )}

      {items.map((keyword) => (
        <section key={keyword.id} className="card space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">{keyword.phrase}</h2>
              <p className="muted">
                проверка {formatInterval(keyword.intervalMin)} · последняя {formatDate(keyword.lastCheckedAt)}
                {keyword.lastTotal !== null && ` · просмотрено ${keyword.lastTotal} позиций выдачи`}
              </p>
            </div>
            <button onClick={() => remove.mutate(keyword.id)} className="muted hover:text-red-600" title="Удалить">
              ✕
            </button>
          </div>

          {keyword.positions.length === 0 ? (
            <p className="muted">
              Ваших товаров в просмотренной части выдачи нет. Это тоже данные: значит, по этому запросу вы ниже
              трёхсотого места.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="muted text-left">
                  <th className="pb-1 font-normal">Позиция</th>
                  <th className="pb-1 font-normal">Товар</th>
                  <th className="pb-1 text-right font-normal">Артикул</th>
                </tr>
              </thead>
              <tbody>
                {keyword.positions.map((position) => (
                  <tr key={position.nm} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5">
                      {position.position === null ? (
                        <span className="text-amber-600">выпал</span>
                      ) : (
                        <span className="font-semibold">
                          {position.position}
                          <span className="muted font-normal"> · стр. {position.page}</span>
                        </span>
                      )}
                    </td>
                    <td className="max-w-xs truncate py-1.5">
                      <Link to={`/product/${position.nm}`} className="hover:text-wb">
                        {position.name ?? "—"}
                      </Link>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{position.nm}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}

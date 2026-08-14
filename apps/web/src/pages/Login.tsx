import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ErrorBox } from "../components/ui";

export function LoginPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/auth/${mode}`, { email, password });
      await queryClient.invalidateQueries();
      window.location.href = "/";
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-semibold">
        <span className="text-wb">watcher</span>
      </h1>
      <p className="muted mb-6">Отслеживание цен Wildberries</p>

      <form onSubmit={submit} className="card space-y-4">
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            autoComplete="email"
          />
        </div>

        <div>
          <label className="label" htmlFor="password">
            Пароль
          </label>
          <input
            id="password"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
          {mode === "register" && <p className="muted mt-1">Минимум 8 символов</p>}
        </div>

        {error != null && <ErrorBox error={error} />}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Войти" : "Зарегистрироваться"}
        </button>

        <button
          type="button"
          className="muted w-full hover:underline"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "Нет аккаунта? Зарегистрироваться" : "Уже есть аккаунт? Войти"}
        </button>
      </form>
    </div>
  );
}

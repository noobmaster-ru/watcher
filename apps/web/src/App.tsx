import { useQuery } from "@tanstack/react-query";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, type Alert, type Health } from "./lib/api";
import { Spinner } from "./components/ui";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { AddPage } from "./pages/Add";
import { ProductPage } from "./pages/Product";
import { SellerPage } from "./pages/Seller";
import { AlertsPage } from "./pages/Alerts";
import { SettingsPage } from "./pages/Settings";

interface Me {
  user: { id: number; email: string };
}

export function App() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<Me>("/api/me"),
    retry: false,
  });

  if (me.isLoading) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Spinner />
      </div>
    );
  }

  if (!me.data) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <div className="min-h-screen">
      <Header email={me.data.user.email} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/add" element={<AddPage />} />
          <Route path="/product/:nm" element={<ProductPage />} />
          <Route path="/seller/:id" element={<SellerPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Header({ email }: { email: string }) {
  const navigate = useNavigate();

  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<Health>("/api/health"),
    refetchInterval: 60_000,
  });

  const alerts = useQuery({
    queryKey: ["alerts", "unread"],
    queryFn: () => api.get<{ alerts: Alert[]; unread: number }>("/api/alerts?limit=1&unreadOnly=true"),
    refetchInterval: 60_000,
  });

  const logout = async () => {
    await api.post("/api/auth/logout");
    window.location.href = "/login";
  };

  const degraded = health.data && health.data.wb.state !== "ok";

  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3">
        <button onClick={() => navigate("/")} className="text-lg font-semibold">
          <span className="text-wb">watcher</span>
        </button>

        <nav className="flex flex-1 flex-wrap gap-1 text-sm">
          <Tab to="/">Отслеживание</Tab>
          <Tab to="/add">Добавить</Tab>
          <Tab to="/alerts">
            События
            {(alerts.data?.unread ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-wb px-1.5 py-0.5 text-xs text-white">
                {alerts.data?.unread}
              </span>
            )}
          </Tab>
          <Tab to="/settings">Настройки</Tab>
        </nav>

        <div className="flex items-center gap-3">
          <span className="muted hidden sm:inline">{email}</span>
          <button onClick={logout} className="muted hover:underline">
            Выйти
          </button>
        </div>
      </div>

      {degraded && (
        <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Wildberries сейчас ограничивает запросы — часть данных может не загрузиться. Это лимит на стороне WB, а не
          ошибка приложения.
        </div>
      )}
    </header>
  );
}

function Tab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `rounded-lg px-3 py-1.5 transition ${
          isActive
            ? "bg-wb-light font-medium text-wb-dark dark:bg-wb-dark/30 dark:text-wb-light"
            : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

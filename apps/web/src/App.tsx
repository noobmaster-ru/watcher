import { Suspense, lazy } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, type Alert, type Health, type Me } from "./lib/api";
import { Spinner } from "./components/ui";
import { SheetButton } from "./components/SheetButton";

// Страницы грузятся лениво: тяжёлый recharts нужен только карточке товара,
// и без code splitting он попадал бы в бандл каждого экрана, включая логин.
const LoginPage = lazy(() => import("./pages/Login").then((m) => ({ default: m.LoginPage })));
const DashboardPage = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.DashboardPage })));
const AddPage = lazy(() => import("./pages/Add").then((m) => ({ default: m.AddPage })));
const ProductPage = lazy(() => import("./pages/Product").then((m) => ({ default: m.ProductPage })));
const SellerPage = lazy(() => import("./pages/Seller").then((m) => ({ default: m.SellerPage })));
const AlertsPage = lazy(() => import("./pages/Alerts").then((m) => ({ default: m.AlertsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const KeywordsPage = lazy(() => import("./pages/Keywords").then((m) => ({ default: m.KeywordsPage })));
const MarketPage = lazy(() => import("./pages/Market").then((m) => ({ default: m.MarketPage })));
const OzonPage = lazy(() => import("./pages/Ozon").then((m) => ({ default: m.OzonPage })));

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
      <Suspense fallback={null}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <div className="min-h-screen">
      <Header email={me.data.user.email} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/add" element={<AddPage />} />
            <Route path="/product/:nm" element={<ProductPage />} />
            <Route path="/seller/:id" element={<SellerPage />} />
            <Route path="/market" element={<MarketPage />} />
          <Route path="/ozon" element={<OzonPage />} />
            <Route path="/keywords" element={<KeywordsPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
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
    <header className="sticky top-0 z-30 border-b border-slate-200/60 bg-white/70 backdrop-blur-xl dark:border-slate-800/60 dark:bg-slate-950/70">
      {/*
        Шапка во всю ширину: логотип прижат к левому краю, за ним сразу вкладки.
        Ничего не переносится на вторую строку — при нехватке места вкладки
        прокручиваются по горизонтали, а длинная почта обрезается многоточием.
        Раньше здесь были flex-wrap и max-w-5xl, и почта подлиннее выталкивала
        «Настройки» на второй ряд.
      */}
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <button onClick={() => navigate("/")} className="shrink-0 text-lg">
          <span className="wordmark">watcher</span>
        </button>

        <nav
          aria-label="Основная навигация"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <Tab to="/">Отслеживание</Tab>
          <Tab to="/add">Добавить</Tab>
          <Tab to="/market">Яндекс Маркет</Tab>
          <Tab to="/ozon">Озон</Tab>
          <Tab to="/keywords">Ключевые слова</Tab>
          <Tab to="/alerts">
            События
            {(alerts.data?.unread ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-gradient-to-r from-wb to-fuchsia-500 px-1.5 py-0.5 text-xs font-semibold text-white">
                {alerts.data?.unread}
              </span>
            )}
          </Tab>
          <SheetButton />
          <Tab to="/settings">Настройки</Tab>
        </nav>

        <div className="flex shrink-0 items-center gap-3">
          <span className="muted hidden max-w-[14rem] truncate lg:inline-block" title={email}>
            {email}
          </span>
          <button onClick={logout} className="muted shrink-0 hover:underline">
            Выйти
          </button>
        </div>
      </div>

      {degraded && (
        <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Wildberries сейчас ограничивает запросы. Чаще всего это поиск: он лимитируется жёстче остального, и
          пауза может доходить до часа. Цены и каталоги при этом обычно продолжают обновляться. Подробности — в
          настройках, раздел «Состояние сервисов».
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
        `whitespace-nowrap rounded-full px-3 py-1.5 transition ${
          isActive
            ? "bg-wb/10 font-semibold text-wb dark:bg-wb/25 dark:text-wb-light"
            : "text-slate-600 hover:bg-slate-900/5 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

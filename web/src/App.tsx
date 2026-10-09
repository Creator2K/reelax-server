// 路由与鉴权门
//
// 三种状态：加载中 → 未登录（去登录页）→ 已登录（进外壳）。
// 「等待审批」提示由 AppLayout 根据当前用户状态渲染，不占一条路由。
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { IconLoader2 } from "@tabler/icons-react";
import { AppLayout } from "./components/layout/AppLayout.tsx";
import { useSession } from "./lib/session.ts";
import { RealtimeProvider } from "./lib/realtime.tsx";
import LoginPage from "./pages/Login.tsx";
import RegisterPage from "./pages/Register.tsx";
import DashboardPage from "./pages/Dashboard.tsx";
import AccountsPage from "./pages/Accounts.tsx";
import AccountDetailPage from "./pages/AccountDetail.tsx";
import ProxiesPage from "./pages/Proxies.tsx";
import NotifyPage from "./pages/Notify.tsx";
import LogsPage from "./pages/Logs.tsx";
import SettingsPage from "./pages/Settings.tsx";
import AdminPage from "./pages/Admin.tsx";
import NotFoundPage from "./pages/NotFound.tsx";

function FullPageLoader({ label = "载入中" }: { label?: string }) {
  return (
    <div className="flex h-svh w-full items-center justify-center">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <IconLoader2 className="size-4 animate-spin" />
        {label}…
      </div>
    </div>
  );
}

function RequireAuth() {
  const { data: user, isPending } = useSession();
  const location = useLocation();

  if (isPending) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return (
    <RealtimeProvider enabled>
      <AppLayout />
    </RealtimeProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route element={<RequireAuth />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/accounts/:id" element={<AccountDetailPage />} />
        <Route path="/proxies" element={<ProxiesPage />} />
        <Route path="/notify" element={<NotifyPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export { FullPageLoader };

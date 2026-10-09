// 路由与鉴权门
//
// 三种状态：加载中 → 未登录（去登录页）→ 已登录（进外壳）。
//
// ★ 管理员与普通用户看到的是**完全不同的应用**：
//   管理员 = 纯后台（用户 / 邀请码 / 系统 / 在线更新）
//   普通用户 = 挂机控制台（账号 / 代理 / 推送 / 日志）
//   两者不共用页面，管理员的入口页就是 /admin，且不会被重定向到挂机面板。
//
// 为什么这么分：管理员账号是给机主管服务器用的，它自己不该有游戏账号，
// 「登录后台却先看到挂机面板」既混乱也容易误操作。
import { createElement, type ReactNode, type ReactElement } from "react";
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

/** 页面级角色门：普通用户访问管理员页面 → 回自己的首页（不是 404，避免困惑） */
function RoleGate({ role, children }: { role: "admin" | "user"; children: ReactNode }) {
  const { data: user, isPending } = useSession();
  if (isPending) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={user.role === "admin" ? "/admin" : "/dashboard"} replace />;
  return <>{children}</>;
}

const adminOnly = (el: ReactElement) => <RoleGate role="admin">{el}</RoleGate>;
const userOnly = (el: ReactElement) => <RoleGate role="user">{el}</RoleGate>;

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route element={<RequireAuth />}>
        {/*
          根路径按角色分流：
            管理员 → /admin（后台）
            普通用户 → 挂机总览
        */}
        <Route path="/" element={<HomeRedirect />} />

        {/* 挂机控制台：仅普通用户 */}
        <Route path="/dashboard" element={userOnly(createElement(DashboardPage))} />
        <Route path="/accounts" element={userOnly(createElement(AccountsPage))} />
        <Route path="/accounts/:id" element={userOnly(createElement(AccountDetailPage))} />
        <Route path="/proxies" element={userOnly(createElement(ProxiesPage))} />
        <Route path="/notify" element={userOnly(createElement(NotifyPage))} />
        <Route path="/logs" element={userOnly(createElement(LogsPage))} />

        {/* 两者都能访问 */}
        <Route path="/settings" element={<SettingsPage />} />

        {/* 纯后台：仅管理员 */}
        <Route path="/admin" element={adminOnly(createElement(AdminPage))} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/** 根路径：按角色跳到各自首页 */
function HomeRedirect() {
  const { data: user, isPending } = useSession();
  if (isPending) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === "admin" ? "/admin" : "/dashboard"} replace />;
}

export { FullPageLoader };

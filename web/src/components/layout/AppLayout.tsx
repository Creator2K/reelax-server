// 受保护的路由外壳：侧边栏 + 顶栏 + 内容区
//
// 鉴权状态由 session.ts 的 useSession 提供；未登录时由 RequireAuth 重定向，
// 因此这里假定 user 一定存在。
// 「等待审批」提示在这里统一渲染（每页都有，不重复写）。
import { Outlet } from "react-router-dom";
import { IconClockHour4 } from "@tabler/icons-react";
import { AppHeader } from "./AppHeader.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { PageHeaderProvider, usePageHeaderContext } from "./page-header.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { useSession, useAuthActions } from "@/lib/session.ts";
import { useRealtime } from "@/lib/realtime.tsx";

function PendingNotice() {
  const { data: user } = useSession();
  // 注册即用（邀请码即门槛），所以正常流程下不会有 pending 状态。
  // 保留这条提示是为了覆盖「被管理员临时改为待审批」这类边界情况。
  if (!user || user.status !== "pending") return null;
  return (
    <div className="px-6 pt-5">
      <Alert variant="warn">
        <IconClockHour4 />
        <AlertTitle>账号处于待审批状态</AlertTitle>
        <AlertDescription>
          管理员已把你的账号设为待审批，暂时无法添加游戏账号。请联系管理员处理。
        </AlertDescription>
      </Alert>
    </div>
  );
}

function Shell() {
  const { header } = usePageHeaderContext();
  const { data: user } = useSession();
  const { logout } = useAuthActions();
  const { connected } = useRealtime();

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <Sidebar
        isAdmin={user?.role === "admin"}
        wsConnected={connected}
        footer={
          user?.accountLimit ? (
            <div className="text-muted-foreground text-[11px]">
              账号 {user.accountCount ?? 0} / {user.accountLimit}
            </div>
          ) : null
        }
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader
          title={header.title}
          description={header.description}
          user={user}
          onLogout={() => void logout()}
          actions={header.actions}
        />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <PendingNotice />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function AppLayout() {
  return (
    <PageHeaderProvider>
      <Shell />
    </PageHeaderProvider>
  );
}

// 受保护的路由外壳：侧边栏 + 顶栏 + 内容区
//
// 鉴权状态由 session.ts 的 useSession 提供；未登录时由 RequireAuth 重定向，
// 因此这里假定 user 一定存在。
// 「待确认」提示在这里统一渲染（每页都有，不重复写）。
//
// 内容区带**按路由的淡入位移**（对标 workbuddy-manager 的页面切换观感）：
// key 用 location.pathname，所以每次换页都会重新播一次入场。
import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { motion } from "motion/react";
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
  // 保留这条提示是为了覆盖「被管理员临时改为待确认」这类边界情况。
  if (!user || user.status !== "pending") return null;
  return (
    <div className="px-6 pt-5">
      <Alert variant="warn">
        <IconClockHour4 />
        <AlertTitle>账号处于待确认状态</AlertTitle>
        <AlertDescription>
          管理员已把你的账号设为待确认，暂时无法添加游戏账号。请联系管理员处理。
        </AlertDescription>
      </Alert>
    </div>
  );
}

/** 内容区：换页时播一次淡入位移（用 pathname 作 key，页面切换才有动效） */
function AnimatedOutlet() {
  const location = useLocation();
  return (
    <motion.div
      key={location.pathname}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
    >
      <Outlet />
    </motion.div>
  );
}

function Shell() {
  const { header } = usePageHeaderContext();
  const { data: user } = useSession();
  const { logout } = useAuthActions();
  const { connected } = useRealtime();
  /** 移动端抽屉开关（桌面不显示抽屉，此状态无副作用） */
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // 换页时自动收起抽屉（桌面端本来就不显示，无影响）
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <Sidebar
        isAdmin={user?.role === "admin"}
        wsConnected={connected}
        mobileOpen={menuOpen}
        onCloseMobile={() => setMenuOpen(false)}
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
          onOpenMenu={() => setMenuOpen(true)}
        />
        {/* scroll-slim：细滚动条，嵌在卡片里的长列表观感更好 */}
        <main className="scroll-slim min-h-0 flex-1 overflow-y-auto">
          <PendingNotice />
          <AnimatedOutlet />
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

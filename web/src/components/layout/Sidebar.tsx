// 侧边栏
//
// 两种形态：
//  · 桌面（≥lg）：固定左侧栏，与 LDC 一致（bg-gray-50、去边框、活跃态浅灰底）
//  · 移动（<lg）：抽屉式 —— 平时收起，点顶栏汉堡按钮滑出，带遮罩，选中后自动关闭
//
// 移动端要点：
//  · 抽屉用 fixed + translate 动画，不占布局宽度
//  · 遮罩点击关闭、项目点击关闭、按 Esc 关闭
//  · 抽屉内可滚动（菜单项多时不会溢出）
import { useEffect, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import {
  type Icon,
  IconBroadcast,
  IconChartDots,
  IconCloudNetwork,
  IconHistory,
  IconLayoutDashboard,
  IconListDetails,
  IconSettings,
  IconShieldLock,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils.ts";

export type NavItem = {
  to: string;
  label: string;
  icon: Icon;
  /** 精确匹配（首页需要，否则永远选中） */
  end?: boolean;
};

/**
 * 普通用户的导航（挂机控制台）。
 * 注意「总览」指向 /dashboard 而不是 / —— 根路径是按角色分流的跳板。
 */
export const USER_NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "总览", icon: IconLayoutDashboard, end: true },
  { to: "/accounts", label: "账号", icon: IconUsers },
  { to: "/proxies", label: "代理", icon: IconCloudNetwork },
  { to: "/notify", label: "推送", icon: IconBroadcast },
  { to: "/logs", label: "运行日志", icon: IconListDetails },
  { to: "/changelog", label: "更新记录", icon: IconHistory },
  { to: "/settings", label: "设置", icon: IconSettings },
];

/**
 * 管理员的导航（纯后台）。
 *
 * ★ 管理员**不出现**挂机相关入口：账号 / 代理 / 推送 / 运行日志都是用户自己的，
 *   管理员进后台只做用户与系统管理。设置页保留（改自己的口令）。
 */
export const ADMIN_NAV_ITEMS: NavItem[] = [
  { to: "/admin", label: "后台管理", icon: IconShieldLock, end: true },
  { to: "/changelog", label: "更新记录", icon: IconHistory },
  { to: "/settings", label: "设置", icon: IconSettings },
];

/** @deprecated 保留给测试与旧引用；按角色取用上面的两个数组 */
export const NAV_ITEMS: NavItem[] = [...USER_NAV_ITEMS, ...ADMIN_NAV_ITEMS];

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav className="scroll-slim flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1">
      {items.map((item, i) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className="group"
          children={({ isActive }) => (
            // 错峰入场：每项延后 30ms，进页面时是一条从上往下铺开的动效
            <motion.span
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.28, delay: 0.04 + i * 0.03, ease: [0.16, 1, 0.3, 1] }}
              data-slot="sidebar-menu-button"
              data-active={isActive ? "true" : "false"}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2.5 text-sm font-medium transition-colors lg:py-2",
                "hover:bg-accent hover:text-accent-foreground",
                !isActive && "text-muted-foreground",
              )}
            >
              <item.icon className="size-4 shrink-0 opacity-80" />
              <span>{item.label}</span>
            </motion.span>
          )}
        />
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-4 py-4">
      <div className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
        <IconChartDots className="size-4" />
      </div>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-semibold">摸鱼大师</div>
        <div className="text-muted-foreground truncate text-[11px]">智能助手</div>
      </div>
    </div>
  );
}

function Footer({ wsConnected, footer }: { wsConnected: boolean; footer?: ReactNode }) {
  return (
    <div className="border-sidebar-border mt-auto space-y-2 border-t px-4 py-3">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="status-dot" data-status={wsConnected ? "online" : "error"} data-pulse={!wsConnected} />
        <span className="text-muted-foreground">{wsConnected ? "实时连接正常" : "实时连接断开"}</span>
      </div>
      {footer}
    </div>
  );
}

export function Sidebar({
  isAdmin,
  wsConnected,
  footer,
  mobileOpen = false,
  onCloseMobile,
}: {
  isAdmin: boolean;
  wsConnected: boolean;
  footer?: ReactNode;
  /** 移动端抽屉是否打开 */
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}) {
  // 管理员只看后台导航；普通用户看挂机导航（两者不混）
  const items = isAdmin ? ADMIN_NAV_ITEMS : USER_NAV_ITEMS;

  // Esc 关闭抽屉
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseMobile?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  // 抽屉打开时锁住背景滚动（否则手指滑动会把背后的页面带着滚）
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  return (
    <>
      {/* ---------- 桌面：固定侧栏 ---------- */}
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden h-svh w-56 shrink-0 flex-col border-r lg:flex">
        <Brand />
        <NavList items={items} />
        <Footer wsConnected={wsConnected} footer={footer} />
      </aside>

      {/* ---------- 移动：抽屉 + 遮罩 ---------- */}
      <AnimatePresence>
        {mobileOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              // 遮罩用纯半透明黑（不用 backdrop-blur：规范禁止玻璃拟态）
              className="absolute inset-0 bg-black/50"
              onClick={onCloseMobile}
              aria-hidden
            />
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 34 }}
              className="bg-sidebar text-sidebar-foreground border-sidebar-border relative flex h-full w-[17rem] max-w-[86vw] flex-col border-r shadow-2xl"
              role="dialog"
              aria-label="导航菜单"
            >
              <div className="flex items-start justify-between">
                <Brand />
                <button
                  type="button"
                  onClick={onCloseMobile}
                  aria-label="关闭菜单"
                  className="text-muted-foreground hover:text-foreground mt-4 mr-2 rounded-md p-2"
                >
                  <IconX className="size-4" />
                </button>
              </div>
              <NavList items={items} onNavigate={onCloseMobile} />
              <Footer wsConnected={wsConnected} footer={footer} />
            </motion.aside>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

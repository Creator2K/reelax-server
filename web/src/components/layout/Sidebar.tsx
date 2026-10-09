// 侧边栏：与 LDC 一致的结构（顶部品牌、中部导航、底部状态）
//
// 选中态样式依赖 `[data-slot="sidebar-menu-button"][data-active="true"]`（见 styles.css），
// 而 NavLink 的 className 函数拿不到这个属性，所以用 children 渲染函数把 data-active
// 打在 <a> 自身，再把同一个 slot 属性带上。
import {
  type Icon,
  IconBroadcast,
  IconChartDots,
  IconCloudNetwork,
  IconLayoutDashboard,
  IconListDetails,
  IconSettings,
  IconShieldLock,
  IconUsers,
} from "@tabler/icons-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils.ts";

export type NavItem = {
  to: string;
  label: string;
  icon: Icon;
  /** 仅管理员可见 */
  adminOnly?: boolean;
  /** 精确匹配（首页需要，否则永远选中） */
  end?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "总览", icon: IconLayoutDashboard, end: true },
  { to: "/accounts", label: "账号", icon: IconUsers },
  { to: "/proxies", label: "代理", icon: IconCloudNetwork },
  { to: "/notify", label: "推送", icon: IconBroadcast },
  { to: "/logs", label: "运行日志", icon: IconListDetails },
  { to: "/settings", label: "设置", icon: IconSettings },
  { to: "/admin", label: "管理", icon: IconShieldLock, adminOnly: true },
];

export function Sidebar({
  isAdmin,
  wsConnected,
  footer,
}: {
  isAdmin: boolean;
  wsConnected: boolean;
  footer?: React.ReactNode;
}) {
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex h-svh w-56 shrink-0 flex-col border-r">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
          <IconChartDots className="size-4" />
        </div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold">摸鱼大师</div>
          <div className="text-muted-foreground truncate text-[11px]">智能助手</div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className="group"
            children={({ isActive }) => (
              <span
                data-slot="sidebar-menu-button"
                data-active={isActive ? "true" : "false"}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  !isActive && "text-muted-foreground",
                )}
              >
                <item.icon className="size-4 shrink-0 opacity-80" />
                <span>{item.label}</span>
              </span>
            )}
          />
        ))}
      </nav>

      <div className="border-sidebar-border mt-auto space-y-2 border-t px-4 py-3">
        <div className="flex items-center gap-2 text-[11px]">
          <span
            className="status-dot"
            data-status={wsConnected ? "online" : "error"}
            data-pulse={!wsConnected}
          />
          <span className="text-muted-foreground">{wsConnected ? "实时连接正常" : "实时连接断开"}</span>
        </div>
        {footer}
      </div>
    </aside>
  );
}

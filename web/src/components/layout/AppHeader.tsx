// 顶栏：移动端汉堡按钮 + 页面标题 + 右侧操作区（主题切换、用户菜单）
//
// 移动端要点：
//  · 左侧是打开抽屉的汉堡按钮（桌面隐藏）
//  · 标题与副标题都允许截断，右侧操作区不换行
//  · 顶部留 safe-area，避免 iPhone 刘海/圆角挡住内容
//  · 主操作按钮在窄屏折叠成图标（只保留标题里最关键的入口）
import { IconLogout, IconMenu2, IconMoon, IconSun, IconUserCircle } from "@tabler/icons-react";
import { Button } from "@/components/ui/button.tsx";
import { useTheme } from "@/lib/theme.tsx";
import type { SessionUser } from "@/lib/session.tsx";

export function AppHeader({
  title,
  description,
  user,
  onLogout,
  actions,
  onOpenMenu,
}: {
  title: string;
  description?: string;
  user?: SessionUser | null;
  onLogout?: () => void;
  actions?: React.ReactNode;
  /** 移动端：点汉堡按钮打开侧栏抽屉 */
  onOpenMenu?: () => void;
}) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header
      // 不用 backdrop-blur：项目视觉规范禁止玻璃拟态，层次用 border + 实色表达
      className="bg-background sticky top-0 z-20 border-b"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-6">
        {/* 移动端汉堡：桌面隐藏 */}
        {onOpenMenu ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenMenu}
            className="shrink-0 lg:hidden"
            aria-label="打开菜单"
          >
            <IconMenu2 className="size-4.5" />
          </Button>
        ) : null}

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] leading-tight font-semibold">{title}</h1>
          {description ? (
            <p className="text-muted-foreground truncate text-xs leading-tight">{description}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleTheme}
            title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
            aria-label={theme === "dark" ? "切换到亮色" : "切换到暗色"}
          >
            {theme === "dark" ? <IconSun className="size-4" /> : <IconMoon className="size-4" />}
          </Button>

          {user ? (
            <div className="flex items-center gap-2 sm:ml-1 sm:border-l sm:pl-2.5">
              <IconUserCircle className="text-muted-foreground hidden size-4 sm:block" />
              <div className="hidden leading-tight sm:block">
                <div className="max-w-32 truncate text-xs font-medium">{user.displayName}</div>
                <div className="text-muted-foreground text-[10px]">{user.role === "admin" ? "管理员" : "用户"}</div>
              </div>
              {onLogout ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onLogout}
                  title="退出登录"
                  aria-label="退出登录"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <IconLogout className="size-4" />
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

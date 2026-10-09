// 顶栏：页面标题 + 右侧操作区（主题切换、用户菜单）
import { IconLogout, IconMoon, IconSun, IconUserCircle } from "@tabler/icons-react";
import { Button } from "@/components/ui/button.tsx";
import { useTheme } from "@/lib/theme.tsx";
import type { SessionUser } from "@/lib/session.tsx";

export function AppHeader({
  title,
  description,
  user,
  onLogout,
  actions,
}: {
  title: string;
  description?: string;
  user?: SessionUser | null;
  onLogout?: () => void;
  actions?: React.ReactNode;
}) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="bg-background/95 sticky top-0 z-10 border-b">
      <div className="flex h-14 items-center gap-3 px-6">
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
            <div className="ml-1 flex items-center gap-2 border-l pl-2.5">
              <IconUserCircle className="text-muted-foreground size-4" />
              <div className="hidden leading-tight sm:block">
                <div className="max-w-32 truncate text-xs font-medium">{user.displayName}</div>
                <div className="text-muted-foreground text-[10px]">{user.role === "admin" ? "管理员" : "用户"}</div>
              </div>
              {onLogout ? (
                <Button variant="ghost" size="icon-sm" onClick={onLogout} title="退出登录" aria-label="退出登录">
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

// 可折叠卡片（只在移动端折叠）
//
// 为什么需要：账号详情页左栏现在有「实时状态 / 地图与天气 / 船队 / 账号信息」四张卡片，
// 手机上叠起来要滚很久；这几张卡片都是"看一眼就走"或"偶尔点一下"的，折叠起来更省地方。
// 桌面端空间够，永远展开（连箭头都不显示）——所以折叠开关只在 `lg` 以下生效。
import { useState, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";

export function CollapsibleCard({
  title,
  icon,
  /** 折叠时显示在标题旁的摘要（例如「雷痕峡湾 · 雷暴」），桌面端也可以显示 */
  summary,
  /** 标题右侧的附加内容（例如「刚刚」「点地图即切换」） */
  headerRight,
  /** 移动端初始是否展开；桌面端一律展开 */
  defaultOpen = false,
  contentClassName,
  children,
}: {
  title: string;
  icon?: ReactNode;
  summary?: ReactNode;
  headerRight?: ReactNode;
  defaultOpen?: boolean;
  contentClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {/* 手机上点标题即折叠；桌面端不响应点击（内容永远展开） */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex min-w-0 items-center gap-2 lg:pointer-events-none"
          >
            {icon}
            <span className="truncate">{title}</span>
            <IconChevronDown
              className={cn(
                "text-muted-foreground size-3.5 shrink-0 transition-transform lg:hidden",
                !open && "-rotate-90",
              )}
            />
          </button>
          {summary ? (
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px] font-normal">{summary}</span>
          ) : (
            <span className="flex-1" />
          )}
          {headerRight ? <span className="flex shrink-0 items-center gap-2">{headerRight}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className={cn(contentClassName, !open && "hidden lg:block")}>{children}</CardContent>
    </Card>
  );
}

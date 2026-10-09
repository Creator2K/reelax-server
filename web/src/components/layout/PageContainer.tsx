import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

/**
 * 页面内容容器：统一内边距与最大宽度。
 *
 * 移动端要点：
 *  · 左右内边距在窄屏收到 px-4（桌面 px-6），给小屏让出宽度
 *  · 底部留 safe-area，避免 iPhone 底部横条压住最后一个按钮
 */
export function PageContainer({
  children,
  className,
  wide = false,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div
      className={cn("mx-auto w-full px-4 py-5 sm:px-6 sm:py-6", wide ? "max-w-[1600px]" : "max-w-6xl", className)}
      style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
    >
      {children}
    </div>
  );
}

/** 区块标题（比卡片标题轻一档）；窄屏允许换行，不挤掉右侧操作 */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium">{children}</h2>
      {action}
    </div>
  );
}

/** 空状态 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="border-border flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-5 py-10 text-center sm:px-6 sm:py-12">
      {icon ? <div className="text-muted-foreground [&>svg]:size-6">{icon}</div> : null}
      <div className="text-sm font-medium">{title}</div>
      {description ? <div className="text-muted-foreground max-w-md text-sm">{description}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

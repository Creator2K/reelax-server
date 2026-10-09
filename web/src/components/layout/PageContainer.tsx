import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

/** 页面内容容器：统一内边距与最大宽度 */
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
    <div className={cn("mx-auto w-full px-6 py-6", wide ? "max-w-[1600px]" : "max-w-6xl", className)}>{children}</div>
  );
}

/** 区块标题（比卡片标题轻一档） */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
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
    <div className="border-border flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
      {icon ? <div className="text-muted-foreground [&>svg]:size-6">{icon}</div> : null}
      <div className="text-sm font-medium">{title}</div>
      {description ? <div className="text-muted-foreground max-w-md text-sm">{description}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

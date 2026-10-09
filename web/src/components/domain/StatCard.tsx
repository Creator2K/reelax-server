import type { ReactNode } from "react";
import { Card } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";

/** 总览指标卡：数值大、标签小，无装饰 */
export function StatCard({
  label,
  value,
  sub,
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0 py-4", className)}>
      <div className="flex items-start justify-between gap-2 px-4">
        <div className="min-w-0">
          <div className="text-muted-foreground text-xs">{label}</div>
          <div className="mono-num mt-1 text-xl font-semibold tracking-tight">{value}</div>
          {sub ? <div className="text-muted-foreground mt-0.5 truncate text-[11px]">{sub}</div> : null}
        </div>
        {icon ? <div className="text-muted-foreground shrink-0 [&>svg]:size-4">{icon}</div> : null}
      </div>
    </Card>
  );
}

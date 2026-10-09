import type { AccountStatus } from "@/lib/queries.ts";
import { Badge } from "@/components/ui/badge.tsx";

const STATUS_TEXT: Record<AccountStatus, string> = {
  stopped: "已停止",
  starting: "启动中",
  online: "在线",
  reconnecting: "重连中",
  error: "出错",
  expired: "凭证失效",
};

const STATUS_VARIANT: Record<AccountStatus, "online" | "warn" | "error" | "idle"> = {
  stopped: "idle",
  starting: "warn",
  online: "online",
  reconnecting: "warn",
  error: "error",
  expired: "error",
};

export function statusText(status: AccountStatus | string): string {
  return STATUS_TEXT[status as AccountStatus] ?? String(status);
}

export function StatusDot({ status, pulse = false }: { status: AccountStatus | string; pulse?: boolean }) {
  return <span className="status-dot" data-status={status} data-pulse={pulse} />;
}

export function StatusBadge({ status }: { status: AccountStatus | string }) {
  const variant = STATUS_VARIANT[status as AccountStatus] ?? "idle";
  const animated = status === "starting" || status === "reconnecting";
  return (
    <Badge variant={variant} className="gap-1.5">
      <StatusDot status={status} pulse={animated} />
      {statusText(status)}
    </Badge>
  );
}

/** 运行状态色（用于地图/天气等徽章） */
export function MetricBadge({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <Badge variant="outline" className="font-normal" title={title}>
      {children}
    </Badge>
  );
}

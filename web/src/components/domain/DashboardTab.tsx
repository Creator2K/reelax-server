// 后台仪表盘：进后台先看总览，而不是直接掉进用户列表
//
// 数据来自已有的三个接口（users / invites / audit / system），不新增后端接口：
//  · 用户    → /api/admin/users（含 counts 与每人的账号数）
//  · 邀请码  → /api/admin/invites
//  · 审计    → /api/admin/audit（最近动态）
//  · 系统    → /api/admin/system（运行容量、存储占用、版本）
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconClockHour4,
  IconKey,
  IconServer,
  IconTicket,
  IconUserCheck,
  IconUserX,
  IconUsers,
} from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { StatCard, ProgressBar } from "@/components/domain/StatCard.tsx";
import { CountingNumber } from "@/components/animate-ui/counting-number.tsx";
import { api } from "@/lib/api.ts";
import { fmtDuration, fmtRelative } from "@/lib/utils.ts";

type AdminUsersResponse = {
  users: {
    id: string;
    email: string;
    displayName: string;
    role: string;
    status: string;
    createdAt: number;
    lastLoginAt: number | null;
    accountCount?: number;
  }[];
  counts: { total: number; pending: number; approved: number; banned: number };
};

type InviteRow = {
  id: string;
  code: string;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  note: string | null;
  created_at: number;
};

type AuditRow = {
  id: number;
  user_id: string | null;
  action: string;
  target: string | null;
  created_at: number;
};

type SystemInfo = {
  version: string;
  startedAt: number;
  uptime: number;
  baseUrl: string;
  limits: { maxAccountsPerUser: number; maxRunningAccounts: number; allowRegistration: boolean; logRetentionDays: number };
  runtime: { runningAccounts: number; capacity: number; available: number; totalAccounts: number };
  storage: { logs: number; auditEvents: number };
};

/** 审计动作 → 人话（未知动作原样显示，不至于丢信息） */
const ACTION_TEXT: Record<string, string> = {
  "user.register": "注册账号",
  "user.login": "登录",
  "user.logout": "退出登录",
  "user.password_changed": "修改口令",
  "user.profile_updated": "修改资料",
  "admin.seeded": "创建初始管理员",
  "admin.user.approved": "批准用户",
  "admin.user.rejected": "拒绝用户",
  "admin.user.status_changed": "调整用户状态",
  "admin.user.role_changed": "调整用户角色",
  "admin.user.password_reset": "重置用户口令",
  "admin.user.created": "创建用户",
  "admin.invite.created": "生成邀请码",
  "admin.invite.deleted": "删除邀请码",
  "admin.update.applied": "触发在线更新",
  "notify.created": "添加推送通道",
  "notify.updated": "修改推送通道",
  "notify.deleted": "删除推送通道",
};

export function DashboardTab({ myId, onGoUsers }: { myId: string; onGoUsers: () => void }) {
  // myId 目前只用于「最近动态」里标记自己；保留参数以免调用方按需扩展时改签名
  void myId;
  const usersQ = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.get<AdminUsersResponse>("/api/admin/users"),
  });
  const invitesQ = useQuery({
    queryKey: ["admin", "invites"],
    queryFn: () => api.get<InviteRow[]>("/api/admin/invites"),
  });
  const auditQ = useQuery({
    queryKey: ["admin", "audit", "recent"],
    queryFn: () => api.get<AuditRow[]>("/api/admin/audit?limit=12"),
  });
  const sysQ = useQuery({
    queryKey: ["admin", "system"],
    queryFn: () => api.get<SystemInfo>("/api/admin/system"),
  });

  if (usersQ.isPending || sysQ.isPending) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-[20px]" />
          ))}
        </div>
        <Skeleton className="h-56" />
      </div>
    );
  }

  if (usersQ.error) {
    return (
      <Alert variant="destructive">
        <IconAlertTriangle />
        <AlertDescription>读取概览失败：{(usersQ.error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const users = usersQ.data?.users ?? [];
  const counts = usersQ.data?.counts;
  const invites = invitesQ.data ?? [];
  const sys = sysQ.data;
  const audit = auditQ.data ?? [];

  const admins = users.filter((u) => u.role === "admin");
  const normalUsers = users.filter((u) => u.role !== "admin");
  const totalAccounts = sys?.runtime.totalAccounts ?? 0;
  const usableInvites = invites.filter(
    (i) => i.used_count < i.max_uses && (i.expires_at == null || i.expires_at > Date.now()),
  );
  // 最近 7 天内的活跃（有登录记录）
  const weekAgo = Date.now() - 7 * 86_400_000;
  const activeRecently = users.filter((u) => (u.lastLoginAt ?? 0) > weekAgo).length;

  return (
    <div className="space-y-4">
      {/* ---------- 关键指标 ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="用户总数"
          icon={<IconUsers className="size-3.5" />}
          value={<CountingNumber number={counts?.total ?? users.length} />}
          hint={`近 7 天活跃 ${activeRecently} 人`}
        />
        <StatCard
          label="在线挂机"
          icon={<IconActivity className="size-3.5" />}
          tone={(sys?.runtime.runningAccounts ?? 0) > 0 ? "success" : "neutral"}
          value={
            <span>
              {sys?.runtime.runningAccounts ?? 0}
              <span className="text-muted-foreground text-base font-normal"> / {sys?.runtime.capacity ?? 0}</span>
            </span>
          }
          hint={`共 ${totalAccounts} 个游戏账号`}
          delay={0.04}
        />
        <StatCard
          label="可用邀请码"
          icon={<IconTicket className="size-3.5" />}
          tone={usableInvites.length > 0 ? "info" : "warning"}
          value={<CountingNumber number={usableInvites.length} />}
          hint={usableInvites.length > 0 ? `共生成 ${invites.length} 个` : "没有可用的邀请码"}
          delay={0.08}
        />
        <StatCard
          label="管理员"
          icon={<IconKey className="size-3.5" />}
          tone="accent"
          value={<CountingNumber number={admins.length} />}
          hint={`普通用户 ${normalUsers.length} 人`}
          delay={0.12}
        />
      </div>

      {/* ---------- 需要处理的事 ---------- */}
      <NeedsAttention
        counts={counts}
        bannedCount={counts?.banned ?? 0}
        hasUsableInvite={usableInvites.length > 0}
        onGoUsers={onGoUsers}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------- 运行状态 ---------- */}
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <IconServer className="size-4" />
              运行状态
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">挂机并发</span>
                <span className="mono-num">
                  {sys?.runtime.runningAccounts ?? 0} / {sys?.runtime.capacity ?? 0}
                </span>
              </div>
              <ProgressBar
                value={sys?.runtime.runningAccounts ?? 0}
                max={Math.max(1, sys?.runtime.capacity ?? 1)}
                tone="info"
              />
            </div>

            <Row label="运行时长" value={sys ? fmtDuration(sys.uptime) : "—"} />
            <Row label="版本" value={sys?.version ?? "—"} />
            <Row label="单用户账号上限" value={String(sys?.limits.maxAccountsPerUser ?? "—")} />
            <Row label="自助注册" value={sys?.limits.allowRegistration ? "已开启" : "已关闭"} />
            <Row label="日志条数" value={String(sys?.storage.logs ?? 0)} />
            <Row label="日志保留" value={`${sys?.limits.logRetentionDays ?? 14} 天`} />
          </CardContent>
        </Card>

        {/* ---------- 最近动态 ---------- */}
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <IconClockHour4 className="size-4" />
              最近动态
            </CardTitle>
          </CardHeader>
          <CardContent>
            {auditQ.isPending ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-6" />
                ))}
              </div>
            ) : audit.length === 0 ? (
              <p className="text-muted-foreground text-xs">暂无记录。</p>
            ) : (
              <ol className="scroll-slim max-h-64 space-y-2 overflow-y-auto pr-1">
                {audit.map((a, i) => {
                  const actor = a.user_id ? users.find((u) => u.id === a.user_id) : null;
                  return (
                    <motion.li
                      key={a.id}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.24, delay: Math.min(i * 0.02, 0.2) }}
                      className="flex items-start justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-medium">{ACTION_TEXT[a.action] ?? a.action}</span>
                        {actor ? <span className="text-muted-foreground"> · {actor.displayName}</span> : null}
                      </div>
                      <span className="text-muted-foreground shrink-0 text-[11px]">{fmtRelative(a.created_at)}</span>
                    </motion.li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** 待办提示：只列出真的需要管理员动手的事 */
function NeedsAttention({
  counts,
  bannedCount,
  hasUsableInvite,
  onGoUsers,
}: {
  counts?: { total: number; pending: number; approved: number; banned: number };
  bannedCount: number;
  hasUsableInvite: boolean;
  onGoUsers: () => void;
}) {
  const items: { icon: React.ReactNode; text: string; action?: () => void; actionLabel?: string }[] = [];

  if ((counts?.pending ?? 0) > 0) {
    items.push({
      icon: <IconUserCheck className="size-3.5" />,
      text: `有 ${counts?.pending} 个账号在等待审批`,
      action: onGoUsers,
      actionLabel: "去处理",
    });
  }
  if (!hasUsableInvite && (counts?.total ?? 0) > 0) {
    items.push({
      icon: <IconTicket className="size-3.5" />,
      text: "当前没有可用的邀请码，新用户无法注册",
    });
  }
  if (bannedCount > 0) {
    items.push({
      icon: <IconUserX className="size-3.5" />,
      text: `有 ${bannedCount} 个账号处于封禁状态`,
    });
  }

  if (items.length === 0) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 rounded-2xl bg-emerald-500/[0.07] px-3.5 py-2.5 text-xs ring-1 ring-emerald-500/20">
        <IconCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        一切正常，没有待处理的事项
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, delay: i * 0.04 }}
          className="bg-muted flex flex-wrap items-center gap-2 rounded-2xl px-3.5 py-2.5 text-xs"
        >
          {it.icon}
          <span>{it.text}</span>
          {it.action ? (
            <button type="button" onClick={it.action} className="text-foreground ml-auto underline underline-offset-2">
              {it.actionLabel}
            </button>
          ) : null}
        </motion.div>
      ))}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "mono-num truncate" : "mono-num"}>{value}</span>
    </div>
  );
}

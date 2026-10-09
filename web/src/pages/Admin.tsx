// 管理页：用户审批 / 角色 / 封禁、邀请码、系统信息
//
// 仅 role === "admin" 可见（侧边栏按角色过滤，后端也会再拦一次）。
import { useState } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconDownload,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldLock,
  IconTrash,
  IconUserCheck,
  IconUserX,
  IconUsers,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageContainer, EmptyState, SectionTitle } from "@/components/layout/PageContainer.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { api } from "@/lib/api.ts";
import { useSession, type SessionUser } from "@/lib/session.ts";
import {
  useApproveUser,
  useApplyUpdate,
  useCheckUpdate,
  useCreateInvite,
  useDeleteInvite,
  useSetUserRole,
  useSetUserStatus,
} from "@/lib/mutations.ts";
import { fmtDateTime, fmtDuration, fmtRelative } from "@/lib/utils.ts";

type AdminUsersResponse = {
  users: SessionUser[];
  counts: { total: number; pending: number; approved: number; banned: number };
};

type InviteRow = {
  id: string;
  code: string;
  max_uses: number | null;
  used_count: number;
  expires_at: number | null;
  note: string | null;
  created_at: number;
};

type AdminSystem = {
  version: string;
  uptime: number;
  baseUrl: string;
  limits: {
    maxAccountsPerUser: number;
    maxRunningAccounts: number;
    allowRegistration: boolean;
    logRetentionDays: number;
  };
  runtime: {
    runningAccounts: number;
    capacity: number;
    available: number;
    totalAccounts: number;
  };
  storage: { logs: number; auditEvents: number };
};

export default function AdminPage() {
  const { data: me } = useSession();
  usePageHeader("管理", "用户审批、邀请码与系统状态");

  if (me && me.role !== "admin") {
    return (
      <PageContainer>
        <EmptyState
          icon={<IconShieldLock />}
          title="需要管理员权限"
          description="当前账号不是管理员，无法访问管理功能。"
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer wide>
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">用户</TabsTrigger>
          <TabsTrigger value="invites">邀请码</TabsTrigger>
          <TabsTrigger value="system">系统</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="pt-4">
          <UsersTab myId={me?.id ?? ""} />
        </TabsContent>
        <TabsContent value="invites" className="pt-4">
          <InvitesTab />
        </TabsContent>
        <TabsContent value="system" className="pt-4">
          <SystemTab />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

/* ---------------- 用户 ---------------- */

function UsersTab({ myId }: { myId: string }) {
  const { data, isPending, error } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.get<AdminUsersResponse>("/api/admin/users"),
  });
  const approve = useApproveUser();
  const setStatus = useSetUserStatus();
  const setRole = useSetUserRole();

  if (isPending) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <IconAlertTriangle />
        <AlertDescription>读取用户失败：{(error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const users = data?.users ?? [];
  const counts = data?.counts;

  return (
    <div className="space-y-4">
      {counts ? (
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">共 {counts.total}</Badge>
          {counts.pending > 0 ? <Badge variant="warn">待审批 {counts.pending}</Badge> : null}
          <Badge variant="online">已审批 {counts.approved}</Badge>
          {counts.banned > 0 ? <Badge variant="error">已封禁 {counts.banned}</Badge> : null}
        </div>
      ) : null}

      <Card className="gap-0 overflow-hidden py-0">
        <div className="divide-border divide-y">
          {users.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{u.displayName}</span>
                  {u.role === "admin" ? <Badge variant="secondary">管理员</Badge> : null}
                  {u.status === "pending" ? (
                    <Badge variant="warn">待审批</Badge>
                  ) : u.status === "banned" ? (
                    <Badge variant="error">已封禁</Badge>
                  ) : (
                    <Badge variant="online">已审批</Badge>
                  )}
                  {u.id === myId ? <Badge variant="outline">你</Badge> : null}
                </div>
                <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 text-[11px]">
                  <span>{u.email}</span>
                  <span>注册 {fmtRelative(u.createdAt)}</span>
                  {u.lastLoginAt ? <span>上次登录 {fmtRelative(u.lastLoginAt)}</span> : null}
                  {u.accountCount != null ? (
                    <span>
                      账号 {u.accountCount} / {u.accountLimit}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {u.status === "pending" ? (
                  <Button size="xs" onClick={() => approve.mutate(u.id)} disabled={approve.isPending}>
                    <IconUserCheck className="size-3.5" />
                    批准
                  </Button>
                ) : null}
                {u.status === "approved" && u.id !== myId ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setStatus.mutate({ id: u.id, status: "banned" })}
                    disabled={setStatus.isPending}
                  >
                    <IconUserX className="size-3.5" />
                    封禁
                  </Button>
                ) : null}
                {u.status === "banned" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setStatus.mutate({ id: u.id, status: "approved" })}
                    disabled={setStatus.isPending}
                  >
                    解封
                  </Button>
                ) : null}
                {u.id !== myId ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setRole.mutate({ id: u.id, role: u.role === "admin" ? "user" : "admin" })}
                    disabled={setRole.isPending}
                    title={u.role === "admin" ? "降级为普通用户" : "提升为管理员"}
                  >
                    {u.role === "admin" ? "降级" : "设为管理员"}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ---------------- 邀请码 ---------------- */

function InvitesTab() {
  const { data, isPending } = useQuery({
    queryKey: ["admin", "invites"],
    queryFn: () => api.get<InviteRow[]>("/api/admin/invites"),
  });
  const create = useCreateInvite();
  const del = useDeleteInvite();

  const [maxUses, setMaxUses] = useState<string>("1");
  const [expiresInDays, setExpiresInDays] = useState<string>("7");
  const [note, setNote] = useState("");

  const list = data ?? [];

  return (
    <div className="space-y-4">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-sm">生成邀请码</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="inv-uses">可用次数</Label>
              <Input
                id="inv-uses"
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder="留空 = 不限"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-days">有效天数</Label>
              <Input
                id="inv-days"
                type="number"
                min={1}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="留空 = 永不过期"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-note">备注</Label>
              <Input id="inv-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="给谁用" />
            </div>
          </div>
          <Button
            size="sm"
            onClick={() =>
              create.mutate({
                maxUses: maxUses === "" ? null : Number(maxUses),
                expiresInDays: expiresInDays === "" ? null : Number(expiresInDays),
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            }
            disabled={create.isPending}
          >
            <IconPlus className="size-3.5" />
            生成
          </Button>
          <p className="text-muted-foreground text-xs">
            注册流程：用户凭邀请码注册 → 状态为「等待审批」→ 你在上面的「用户」页批准后即可使用。
          </p>
        </CardContent>
      </Card>

      <SectionTitle>{`已有 ${list.length} 个邀请码`}</SectionTitle>

      {isPending ? (
        <Skeleton className="h-24" />
      ) : list.length === 0 ? (
        <EmptyState title="还没有邀请码" description="生成一个发给要注册的人。" />
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <div className="divide-border divide-y">
            {list.map((inv) => {
              const exhausted = inv.max_uses != null && inv.used_count >= inv.max_uses;
              const expired = inv.expires_at != null && inv.expires_at < Date.now();
              const usable = !exhausted && !expired;
              return (
                <div key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-sm font-medium">{inv.code}</code>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="复制"
                        aria-label="复制邀请码"
                        onClick={() => {
                          void navigator.clipboard
                            ?.writeText(inv.code)
                            .then(() => toast.success("已复制"))
                            .catch(() => toast.error("复制失败，请手动选中"));
                        }}
                      >
                        <IconCopy className="size-3.5" />
                      </Button>
                      {usable ? (
                        <Badge variant="online" className="gap-1">
                          <IconCircleCheck className="size-3" />
                          可用
                        </Badge>
                      ) : (
                        <Badge variant="idle">{exhausted ? "已用尽" : "已过期"}</Badge>
                      )}
                    </div>
                    <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 text-[11px]">
                      <span>
                        已用 {inv.used_count}
                        {inv.max_uses != null ? ` / ${inv.max_uses}` : "（不限）"}
                      </span>
                      <span>
                        {inv.expires_at ? `${fmtDateTime(inv.expires_at)} 过期` : "永不过期"}
                      </span>
                      {inv.note ? <span>备注：{inv.note}</span> : null}
                      <span>创建于 {fmtRelative(inv.created_at)}</span>
                    </div>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => del.mutate(inv.id)}
                    disabled={del.isPending}
                    title="删除"
                    aria-label="删除邀请码"
                  >
                    <IconTrash className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ---------------- 系统 ---------------- */

function SystemTab() {
  const { data, isPending, error } = useQuery({
    queryKey: ["admin", "system"],
    queryFn: () => api.get<AdminSystem>("/api/admin/system"),
  });

  if (isPending) return <Skeleton className="h-48" />;
  if (error) {
    return (
      <Alert variant="destructive">
        <IconAlertTriangle />
        <AlertDescription>读取系统信息失败：{(error as Error).message}</AlertDescription>
      </Alert>
    );
  }
  if (!data) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <IconUsers className="size-4" />
            运行状态
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <Row label="版本" value={data.version} />
          <Row label="已运行" value={fmtDuration(data.uptime)} />
          <Row label="游戏地址" value={data.baseUrl} />
          <Row label="账号总数" value={String(data.runtime.totalAccounts)} />
          <Row
            label="正在运行"
            value={`${data.runtime.runningAccounts} / ${data.runtime.capacity}`}
          />
          <Row label="剩余并发额度" value={String(data.runtime.available)} />
        </CardContent>
      </Card>

      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="text-sm">限额与存储</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <Row label="单用户账号上限" value={String(data.limits.maxAccountsPerUser)} />
          <Row label="全局并发上限" value={String(data.limits.maxRunningAccounts)} />
          <Row label="允许自助注册" value={data.limits.allowRegistration ? "是" : "否"} />
          <Row label="日志保留" value={`${data.limits.logRetentionDays} 天`} />
          <Row label="日志条数" value={String(data.storage.logs)} />
          <Row label="审计事件" value={String(data.storage.auditEvents)} />
        </CardContent>
      </Card>

      <div className="sm:col-span-2">
        <UpdatePanel />
      </div>

      <div className="sm:col-span-2">
        <Alert variant="info">
          <AlertDescription>
            这些限额通过环境变量配置（<code className="font-mono">MAX_ACCOUNTS_PER_USER</code>、
            <code className="font-mono">MAX_RUNNING_ACCOUNTS</code>、
            <code className="font-mono">ALLOW_REGISTRATION</code>、
            <code className="font-mono">LOG_RETENTION_DAYS</code>），改动需要重启容器。
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}

/** 在线更新面板：检查 → 一键更新 */
function UpdatePanel() {
  const check = useCheckUpdate();
  const apply = useApplyUpdate();
  const r = check.data;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <IconRefresh className="size-4" />
          在线更新
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => check.mutate()} disabled={check.isPending || apply.isPending}>
            <IconSearch className="size-3.5" />
            {check.isPending ? "检查中…" : "检查更新"}
          </Button>
          {r?.hasUpdate ? (
            <Button
              size="sm"
              onClick={() => apply.mutate()}
              disabled={apply.isPending || (!r.updaterAvailable && !r.canApplyLocal)}
            >
              <IconDownload className="size-3.5" />
              {apply.isPending ? "更新中…" : "立即更新"}
            </Button>
          ) : null}
        </div>

        {!r && !check.isPending ? (
          <p className="text-muted-foreground text-xs">点「检查更新」对比当前提交与 GitHub 上的最新提交。</p>
        ) : null}

        {r ? (
          <div className="space-y-3 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="bg-muted/40 rounded-md border px-3 py-2">
                <div className="text-muted-foreground">当前版本</div>
                <div className="font-mono">{r.current ? r.current.short : "读不到（非 git 工作区）"}</div>
                {r.current?.message ? <div className="truncate text-[11px]" title={r.current.message}>{r.current.message}</div> : null}
              </div>
              <div className="bg-muted/40 rounded-md border px-3 py-2">
                <div className="text-muted-foreground">GitHub 最新</div>
                <div className="font-mono">{r.latest ? r.latest.short : "读不到"}</div>
                {r.latest?.message ? <div className="truncate text-[11px]" title={r.latest.message}>{r.latest.message}</div> : null}
              </div>
            </div>

            {r.hasUpdate ? (
              <Alert variant="warn">
                <IconAlertTriangle />
                <AlertDescription>
                  有新版本
                  {r.behindBy ? `（落后 ${r.behindBy} 个提交）` : ""}。
                  {r.updaterAvailable
                    ? " 点「立即更新」会拉取代码并重建容器，服务约 1 分钟后重启。"
                    : r.canApplyLocal
                      ? " 点「立即更新」会拉取代码并重建前端，之后需要重启进程。"
                      : " 当前部署未开启自动更新，请看下方命令。"}
                </AlertDescription>
              </Alert>
            ) : (
              <Badge variant="online" className="gap-1">
                <IconCheck className="size-3" />
                已是最新
              </Badge>
            )}

            {r.note ? <div className="text-muted-foreground">{r.note}</div> : null}

            {/* 更新能力说明：让用户知道为什么按钮不可点 */}
            <div className="text-muted-foreground space-y-1">
              <div>
                旁路更新器：{r.updaterAvailable ? "在线可用" : "未启用"}
                {!r.updaterAvailable ? "（docker compose --profile update up -d 可开启）" : ""}
              </div>
              <div>容器内直接 pull：{r.canApplyLocal ? "允许" : "不允许（Docker 部署下正常）"}</div>
            </div>

            {r.manualHint ? (
              <pre className="bg-muted/40 overflow-x-auto rounded-md border px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
                {r.manualHint}
              </pre>
            ) : null}
          </div>
        ) : null}

        {apply.data?.log ? (
          <details className="text-xs">
            <summary className="text-muted-foreground cursor-pointer">更新输出</summary>
            <pre className="bg-muted/40 mt-2 max-h-64 overflow-auto rounded-md border px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
              {apply.data.log}
            </pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

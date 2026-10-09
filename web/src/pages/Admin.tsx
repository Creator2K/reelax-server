// 后台管理页：概览仪表盘、用户管理、邀请码、在线设置、系统信息、更新记录
//
// 仅 role === "admin" 可见。管理员是**纯后台**角色：这里不出现任何挂机面板，
// 因为管理员账号本身不挂游戏（挂机是普通用户的事）。
//
// 用户管理与后台设置体量较大，各自拆成独立组件（domain/UsersTab、AdminSettingsTab）。
import { useState } from "react";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCopy,
  IconPlus,
  IconShieldLock,
  IconTrash,
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
import { UpdatePanel } from "@/components/domain/UpdatePanel.tsx";
import { DashboardTab } from "@/components/domain/DashboardTab.tsx";
import { UsersTab } from "@/components/domain/UsersTab.tsx";
import { AdminSettingsTab } from "@/components/domain/AdminSettingsTab.tsx";
import { ChangelogList } from "@/components/domain/Changelog.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { api } from "@/lib/api.ts";
import { useSession } from "@/lib/session.ts";
import { useCreateInvite, useDeleteInvite } from "@/lib/mutations.ts";
import { fmtDateTime, fmtDuration, fmtRelative } from "@/lib/utils.ts";

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
  usePageHeader("后台管理", "用户、邀请码与系统状态");
  // 受控 tab：仪表盘里的「去处理」需要能跳到用户页
  const [tab, setTab] = useState("overview");

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
      {/* 默认落在仪表盘：进后台先看总览，而不是直接掉进一张用户表格 */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="users">用户</TabsTrigger>
          <TabsTrigger value="invites">邀请码</TabsTrigger>
          <TabsTrigger value="settings">设置</TabsTrigger>
          <TabsTrigger value="system">系统</TabsTrigger>
          <TabsTrigger value="changelog">更新记录</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <DashboardTab myId={me?.id ?? ""} onGoUsers={() => setTab("users")} />
        </TabsContent>
        <TabsContent value="users" className="pt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="invites" className="pt-4">
          <InvitesTab />
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          <AdminSettingsTab />
        </TabsContent>
        <TabsContent value="system" className="pt-4">
          <SystemTab />
        </TabsContent>
        <TabsContent value="changelog" className="pt-4">
          <ChangelogList />
        </TabsContent>
      </Tabs>
    </PageContainer>
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
            把邀请码发给要注册的人，对方填上就能直接使用，不需要审批。
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
                    className="row-actions sm:ml-auto"
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
    </div>
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

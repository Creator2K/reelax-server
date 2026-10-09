// 账号详情：左侧实时状态，右侧 11 个内置功能的开关与配置
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconLock,
  IconPlayerPlay,
  IconPlayerStop,
  IconSettings,
} from "@tabler/icons-react";
import { PageContainer, EmptyState } from "@/components/layout/PageContainer.tsx";
import { StatusPanelCard } from "@/components/domain/StatusPanel.tsx";
import { ModuleForm, ModuleHeader } from "@/components/domain/ModuleForm.tsx";
import { StatusBadge } from "@/components/domain/StatusBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useAccounts, useModuleDefinitions, type Account, type ModuleRuntimeState } from "@/lib/queries.ts";
import { useResetModule, useStartAccount, useStopAccount, useUpdateModule } from "@/lib/mutations.ts";
import { fmtNum } from "@/lib/utils.ts";

export default function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: accounts, isPending } = useAccounts();
  const { data: definitions } = useModuleDefinitions();
  const account = accounts?.find((a) => a.id === id) ?? null;

  const start = useStartAccount();
  const stop = useStopAccount();

  usePageHeader(
    account?.label ?? "账号详情",
    account ? `${account.email || "Cookie 导入"} · ${account.proxyLabel ?? "直连"}` : undefined,
    account ? (
      <div className="flex items-center gap-1.5">
        <Button asChild size="sm" variant="outline">
          <Link to="/accounts">
            <IconArrowLeft className="size-3.5" />
            返回列表
          </Link>
        </Button>
        {account.status === "stopped" ? (
          <Button size="sm" onClick={() => start.mutate(account.id)} disabled={start.isPending}>
            <IconPlayerPlay className="size-3.5" />
            启动
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => stop.mutate(account.id)} disabled={stop.isPending}>
            <IconPlayerStop className="size-3.5" />
            停止
          </Button>
        )}
      </div>
    ) : undefined,
  );

  if (isPending) {
    return (
      <PageContainer wide>
        <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </PageContainer>
    );
  }

  if (!account) {
    return (
      <PageContainer>
        <EmptyState
          title="账号不存在"
          description="它可能已被删除，或者链接有误。"
          action={
            <Button asChild size="sm">
              <Link to="/accounts">返回账号列表</Link>
            </Button>
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer wide>
      {account.credentialOk ? null : (
        <Alert variant="destructive" className="mb-4">
          <IconLock />
          <AlertTitle>凭证无法解密</AlertTitle>
          <AlertDescription>
            {account.credentialError ?? "MASTER_KEY 与数据不匹配。"}
            <br />
            请在下方「凭证与代理」里重新填写游戏密码或 Cookie。
          </AlertDescription>
        </Alert>
      )}

      {account.lastError && account.status !== "online" ? (
        <Alert variant="warn" className="mb-4">
          <IconAlertTriangle />
          <AlertTitle>最近一次错误</AlertTitle>
          <AlertDescription>{account.lastError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <div className="space-y-4">
          <StatusPanelCard panel={account.statusPanel} />
          <AccountMetaCard account={account} />
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <IconSettings className="size-4" />
            <h2 className="text-sm font-medium">功能</h2>
            <span className="text-muted-foreground text-xs">
              {account.modules.filter((m) => m.enabled).length} / {account.modules.length} 已启用
            </span>
          </div>

          {account.modules.map((state) => {
            const def = definitions?.find((d) => d.id === state.id);
            return (
              <ModuleCard
                key={state.id}
                accountId={account.id}
                state={state}
                schema={def?.configSchema ?? []}
                description={def?.description ?? ""}
                unavailable={def?.unavailable ?? null}
              />
            );
          })}
        </div>
      </div>
    </PageContainer>
  );
}

function AccountMetaCard({ account }: { account: Account }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">账号信息</span>
          <StatusBadge status={account.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <Row label="凭证方式" value={account.authType === "cookie" ? "Cookie 导入" : "账号密码"} />
        <Row label="游戏邮箱" value={account.email || "—"} />
        <Row label="出口代理" value={account.proxyLabel ?? "直连"} />
        <Row label="自动启动" value={account.autoStart ? "是" : "否"} />
        <Row
          label="本轮结算"
          value={`${fmtNum(account.stats.castsResolved)} 杆 · ${fmtNum(account.stats.fishCount)} 条 · ${fmtNum(account.stats.gold)} 金币`}
        />
        {account.player ? (
          <Row
            label="角色"
            value={`${account.player.nickname ?? "—"}${account.player.level ? ` · Lv ${fmtNum(account.player.level)}` : ""}`}
          />
        ) : null}
        {account.run ? (
          <Row
            label="当前一轮"
            value={`${fmtNum(account.run.remainingCasts ?? 0)} / ${fmtNum(account.run.totalCasts ?? 0)} 杆`}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="truncate text-right" title={value}>
        {value}
      </span>
    </div>
  );
}

function ModuleCard({
  accountId,
  state,
  schema,
  description,
  unavailable,
}: {
  accountId: string;
  state: ModuleRuntimeState;
  schema: import("@/lib/queries.ts").ConfigField[];
  description: string;
  /** 非 null 表示该功能当前不可用（例如日报缺少推送通道），开关会被禁用 */
  unavailable: string | null;
}) {
  const [open, setOpen] = useState(false);
  const update = useUpdateModule(accountId);
  const reset = useResetModule(accountId);
  const blocked = Boolean(unavailable);

  return (
    <Card className="gap-3">
      <CardHeader>
        <ModuleHeader
          state={state}
          toggling={update.isPending}
          // 不可用时不允许打开：服务端也会拒（这里是体验层）
          onToggle={(enabled) => {
            if (blocked && enabled) return;
            update.mutate({ moduleId: state.id, patch: { enabled } });
          }}
          disabled={blocked}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>

        {/* 前置条件未满足：说清楚缺什么、去哪补 */}
        {blocked ? (
          <Alert variant="warn">
            <IconLock />
            <AlertTitle>暂不可用</AlertTitle>
            <AlertDescription>{unavailable}</AlertDescription>
          </Alert>
        ) : null}

        {/* 启动失败原因必须显眼：例如与官方航线助手硬冲突 */}
        {state.startError ? (
          <Alert variant="destructive">
            <IconAlertTriangle />
            <AlertDescription>{state.startError}</AlertDescription>
          </Alert>
        ) : null}

        <Button
          size="xs"
          variant="ghost"
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground"
          disabled={blocked}
        >
          {open ? "收起配置" : `展开配置（${schema.length} 项）`}
        </Button>

        {open && !blocked ? (
          <div className="border-t pt-3">
            <ModuleForm
              fields={schema}
              values={state.config}
              configIssues={state.configIssues}
              onSave={async (draft) => {
                await update.mutateAsync({ moduleId: state.id, patch: { config: draft } });
              }}
              onReset={async () => {
                await reset.mutateAsync(state.id);
              }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

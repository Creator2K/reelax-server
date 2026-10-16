// 账号管理页：概览统计 + 列表 + 新建 + 启停 + 删除
//
// 与原来的「总览」页合并：两页展示的是同一批账号（一个卡片网格、一个管理列表），
// 菜单里出现两个入口容易混淆。现在只保留这一页，统计卡放在列表上方。
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  IconActivity,
  IconAlertTriangle,
  IconCoin,
  IconFish,
  IconGauge,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { PageContainer, EmptyState, SectionTitle } from "@/components/layout/PageContainer.tsx";import { StatCard } from "@/components/domain/StatCard.tsx";
import { CountingNumber } from "@/components/animate-ui/counting-number.tsx";
import { StatusBadge } from "@/components/domain/StatusBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { PageHeaderActions, usePageHeader } from "@/components/layout/page-header.tsx";
import { useAccounts, useProxies, type Account, type SyncHealth } from "@/lib/queries.ts";
import {
  useCreateAccount,
  useDeleteAccount,
  useStartAccount,
  useStopAccount,
} from "@/lib/mutations.ts";
import { fmtCompact, fmtExact, fmtNum, fmtRelative } from "@/lib/utils.ts";

export default function AccountsPage() {
  const { data: accounts, isPending, error } = useAccounts();
  const { data: proxies } = useProxies();
  const start = useStartAccount();
  const stop = useStopAccount();
  const del = useDeleteAccount();

  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null);

  usePageHeader("账号管理", "每个账号独立运行、独立配置功能；建议为每个账号绑定代理以隔离出口 IP");

  const list = accounts ?? [];

  // 概览数字（原来在「总览」页，这次合并到本页顶部）
  const online = list.filter((a) => a.status === "online").length;
  const engineRunning = list.filter((a) => a.status !== "stopped").length;
  const totalCasts = list.reduce((s, a) => s + (a.stats?.castsResolved ?? 0), 0);
  const totalGold = list.reduce((s, a) => s + (a.stats?.gold ?? 0), 0);
  const totalFish = list.reduce((s, a) => s + (a.stats?.fishCount ?? 0), 0);

  return (
    <PageContainer wide>
      <PageHeaderActions>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <IconPlus className="size-3.5" />
          添加账号
        </Button>
      </PageHeaderActions>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="在线账号"
          tone={online > 0 ? "success" : "neutral"}
          value={
            <span>
              {online} <span className="text-muted-foreground text-base font-normal">/ {list.length}</span>
            </span>
          }
          hint={`${engineRunning} 个引擎运行中`}
          icon={<IconActivity className="size-3.5" />}
        />
        <StatCard
          label="累计结算"
          value={<CountingNumber number={totalCasts} />}
          hint="引擎启动以来（杆）"
          icon={<IconActivity className="size-3.5" />}
          delay={0.04}
        />
        <StatCard
          label="累计金币"
          tone="warning"
          value={<CountingNumber number={totalGold} />}
          hint="税后净金币"
          icon={<IconCoin className="size-3.5" />}
          delay={0.08}
        />
        <StatCard
          label="累计渔获"
          value={<CountingNumber number={totalFish} />}
          hint="鱼条数"
          icon={<IconFish className="size-3.5" />}
          delay={0.12}
        />
      </div>
      {error ? (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertDescription>读取账号失败：{(error as Error).message}</AlertDescription>
        </Alert>
      ) : null}

      {isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<IconUsers />}
          title="还没有游戏账号"
          description="可以用游戏账号密码（凭证失效能自动重登），也可以导入 Cookie（不保存密码，失效后需重新导入）。"
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              添加账号
            </Button>
          }
        />
      ) : (
        <>
          <SectionTitle>{`${list.length} 个账号`}</SectionTitle>
          {/* 账号卡片：一屏看清「状态 / 金币 / 结算 / 链路」，不用点进详情 */}
          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {list.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                onStart={() => start.mutate(a.id)}
                onStop={() => stop.mutate(a.id)}
                onDelete={() => setPendingDelete(a)}
                busy={start.isPending || stop.isPending}
              />
            ))}
          </div>
        </>
      )}

      <CreateAccountDialog open={createOpen} onOpenChange={setCreateOpen} proxies={proxies ?? []} />

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除账号「{pendingDelete?.label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              会停止引擎并删除该账号的全部配置与统计。此操作不可撤销（游戏内的角色数据不受影响）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) del.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}

function AccountCard({
  account,
  onStart,
  onStop,
  onDelete,
  busy,
}: {
  account: Account;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const running = account.status !== "stopped";
  const panel = account.statusPanel;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="px-4 pt-3.5 pb-3">
        {/* 标题行：备注名 + 状态 */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              to={`/accounts/${account.id}`}
              className="block truncate text-sm font-medium hover:underline"
            >
              {account.label}
            </Link>
            <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
              {account.email || "Cookie 导入"}
              <span className="mx-1.5">·</span>
              {account.proxyLabel ? `代理 ${account.proxyLabel}` : "直连"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <StatusBadge status={account.status} />
            {account.credentialOk ? null : (
              <Badge variant="error" title={account.credentialError ?? ""}>
                凭证异常
              </Badge>
            )}
          </div>
        </div>

        {/* 关键数字 */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Metric label="金币" value={fmtNum(account.stats.gold)} />
          <Metric label="结算" value={`${fmtNum(account.stats.castsResolved)} 杆`} />
          <Metric label="渔获" value={`${fmtNum(account.stats.fishCount)} 条`} />
        </div>

        {/* 位置与链路 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {panel?.biomeName ? <Badge variant="secondary">{panel.biomeName}</Badge> : null}
          {panel?.weatherName ? <Badge variant="warn">{panel.weatherName}</Badge> : null}
          {panel?.level ? <Badge variant="secondary">Lv {fmtNum(panel.level)}</Badge> : null}
          {panel?.xpRate ? (
            <Badge
              variant="idle"
              title={`近 ${Math.max(1, Math.round(panel.xpRate.windowSec / 60))} 分钟实测：${fmtExact(panel.xpRate.perHour)} 经验/时`}
            >
              经验 +{fmtCompact(panel.xpRate.perHour)}/时
            </Badge>
          ) : null}
          <LinkBadge running={running} sync={panel?.sync ?? null} />
          <span className="text-muted-foreground text-[11px]">
            上次同步 {account.lastSyncAt ? fmtRelative(account.lastSyncAt) : "—"}
          </span>
        </div>

        {account.lastError ? (
          <div
            className="text-[var(--status-error)] mt-2 line-clamp-2 text-[11px]"
            title={account.lastError}
          >
            {account.lastError}
          </div>
        ) : null}
      </div>

      <div className="border-border/60 flex items-center justify-end gap-1.5 border-t px-3 py-2">
        {running ? (
          <Button size="sm" variant="outline" onClick={onStop} disabled={busy}>
            <IconPlayerStop className="size-3.5" />
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={onStart} disabled={busy}>
            <IconPlayerPlay className="size-3.5" />
            启动
          </Button>
        )}
        <Button asChild size="sm" variant="outline">
          <Link to={`/accounts/${account.id}`}>配置</Link>
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onDelete} title="删除账号" aria-label="删除账号">
          <IconTrash className="size-4" />
        </Button>
      </div>
    </Card>
  );
}

/** 卡片里的一个小数字（金币 / 结算 / 渔获） */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/50 rounded-xl px-2.5 py-2">
      <div className="text-muted-foreground text-[10px]">{label}</div>
      <div className="mono-num mt-0.5 text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

/**
 * 链路质量徽章：近 10 分钟的同步成功率。
 *
 * 为什么放在卡片上：链路抖动的唯一表现常常只是「这个号结算杆数比别的号少」，
 * 在列表页就能看到成功率，才能一眼分辨「该修代理」还是「该调玩法配置」——
 * 不必逐个点进详情页找那一块。
 */
function LinkBadge({ running, sync }: { running: boolean; sync: SyncHealth | null }) {
  if (!running) {
    return <Badge variant="idle">链路 —（未运行）</Badge>;
  }
  if (!sync || sync.attempts === 0) {
    return <Badge variant="idle">链路 待采样</Badge>;
  }

  const rate = sync.successRate;
  // 与详情页同一套阈值：≥95% 正常、≥80% 注意、其余告警
  const variant = rate === null ? "idle" : rate >= 95 ? "online" : rate >= 80 ? "warn" : "error";
  const detail =
    `近 ${Math.round(sync.windowSec / 60)} 分钟：尝试 ${sync.attempts} · 成功 ${sync.ok} · 失败 ${sync.failed}` +
    ` · 超时 ${sync.timeouts}` +
    (sync.failStreak ? ` · 连续失败 ${sync.failStreak} 次` : "") +
    (sync.lastError ? `\n最近一次失败：${sync.lastError}` : "");

  return (
    <Badge variant={variant} title={detail}>
      <IconGauge className="size-3" />
      链路 {rate === null ? "—" : `${rate}%`}
      {sync.failStreak ? ` · 连续失败 ${sync.failStreak}` : ""}
    </Badge>
  );
}

function CreateAccountDialog({
  open,
  onOpenChange,
  proxies,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  proxies: { id: string; label: string; protocol: string; host: string; port: number }[];
}) {
  const create = useCreateAccount();
  const [authType, setAuthType] = useState<"credentials" | "cookie">("credentials");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [cookie, setCookie] = useState("");
  const [proxyId, setProxyId] = useState<string>("");
  const [autoStart, setAutoStart] = useState(true);

  const reset = () => {
    setLabel("");
    setEmail("");
    setPassword("");
    setCookie("");
    setProxyId("");
    setAutoStart(true);
    setAuthType("credentials");
  };

  const submit = async () => {
    await create.mutateAsync({
      label: label.trim() || undefined,
      authType,
      ...(authType === "credentials" ? { email: email.trim(), password } : { cookie: cookie.trim() }),
      proxyId: proxyId || null,
      autoStart,
    });
    reset();
    onOpenChange(false);
  };

  const invalid =
    authType === "credentials" ? !email.trim() || !password : !cookie.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加游戏账号</DialogTitle>
          <DialogDescription>
            用账号密码登录，凭证失效时能自动重登；用 Cookie 导入则不保存密码，但失效后需要重新导入。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="acc-label">备注名</Label>
            <Input
              id="acc-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="留空则用邮箱作为名称"
            />
          </div>

          <div className="space-y-2">
            <Label>凭证方式</Label>
            <div className="flex gap-1.5">
              {(
                [
                  ["credentials", "账号密码"],
                  ["cookie", "Cookie 导入"],
                ] as const
              ).map(([value, text]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={authType === value ? "secondary" : "outline"}
                  onClick={() => setAuthType(value)}
                >
                  {text}
                </Button>
              ))}
            </div>
          </div>

          {authType === "credentials" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="acc-email">游戏邮箱</Label>
                <Input
                  id="acc-email"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="登录游戏的邮箱"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="acc-password">游戏密码</Label>
                <Input
                  id="acc-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  密码会用 AES-256-GCM 加密后保存，之后任何地方都无法再读回明文。
                </p>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="acc-cookie">Cookie</Label>
              <Input
                id="acc-cookie"
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
                placeholder="登录游戏 → F12 → Network → 任意 /api/ 请求 → 复制 Cookie 整行"
              />
              <p className="text-muted-foreground text-xs">
                Cookie 同样会加密存储。失效后需要重新导入（无法自动重登）。
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="acc-proxy">代理（可选）</Label>
            <Select value={proxyId || "__none__"} onValueChange={(v) => setProxyId(v === "__none__" ? "" : v)}>
              <SelectTrigger id="acc-proxy">
                <SelectValue placeholder="直连" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">直连（不使用代理）</SelectItem>
                {proxies.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}（{p.protocol}://{p.host}:{p.port}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              每个账号一个独立出口，建议多账号分别绑定不同代理。
            </p>
          </div>

          <details className="text-xs">
            <summary className="text-muted-foreground cursor-pointer">高级设置</summary>
            <div className="mt-3 space-y-3">
              {/* 游戏地址固定用服务端配置（默认 https://reelax.cn），不给用户改也不显示 */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="acc-autostart">添加后自动启动</Label>
                  <p className="text-muted-foreground text-xs">关闭则只添加不启动，稍后手动开启</p>
                </div>
                <Switch id="acc-autostart" checked={autoStart} onCheckedChange={setAutoStart} />
              </div>
            </div>
          </details>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={invalid || create.isPending}>
            {create.isPending ? "添加中…" : "添加并启动"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

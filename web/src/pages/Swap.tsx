// 交换助手（专精换鱼）
//
// 移植自浏览器脚本《专精交换助手 v1.2.0》：扫全市场的交换单，找出「用我手上的鱼、
// 经几手以物易物换到专精目标」的所有可行链，然后由**我手动点执行**。
//
// 与脚本一致的三件事：目标自动取专精进度（还差多少）、扫的是全部在售单（不是只扫我能响应的）、
// 执行前重新确认鱼还在背包里。区别：账号由页面顶部选择（脚本跑在游戏页面上，只能用当前登录的号）。
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconChevronRight,
  IconCircleCheck,
  IconFish,
  IconInfoCircle,
  IconLoader2,
  IconRefresh,
  IconTarget,
} from "@tabler/icons-react";
import { PageContainer, EmptyState } from "@/components/layout/PageContainer.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
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
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useAccounts, useSwapState, type SwapPathView } from "@/lib/queries.ts";
import { useExecuteSwapPath, useStartSwapScan } from "@/lib/mutations.ts";
import { fmtRelative } from "@/lib/utils.ts";

/** 「B2 雾语湿地」这种地图说法（只有编号时退回编号） */
const place = (code: string | null, name: string | null) => (code ? `${code}${name ? ` ${name}` : ""}` : "未知地图");

export default function SwapPage() {
  const { data: accounts, isPending } = useAccounts();
  const [params, setParams] = useSearchParams();

  const list = useMemo(() => accounts ?? [], [accounts]);
  const accountId = params.get("account") ?? list[0]?.id ?? "";

  // 账号列表到手后把默认账号写进地址栏：刷新 / 分享链接都能停在同一账号
  useEffect(() => {
    if (!params.get("account") && list[0]) {
      const next = new URLSearchParams(params);
      next.set("account", list[0].id);
      setParams(next, { replace: true });
    }
  }, [params, list, setParams]);

  usePageHeader(
    "交换助手",
    "扫全市场交换单，找出能换到专精目标的链，手动执行",
    list.length ? (
      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">账号</span>
        <select
          className="border-input bg-background h-8 min-w-36 rounded-md border px-2 text-xs"
          value={accountId}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            next.set("account", e.target.value);
            setParams(next, { replace: true });
          }}
        >
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
              {a.player?.nickname ? `（${a.player.nickname}）` : ""}
            </option>
          ))}
        </select>
      </label>
    ) : undefined,
  );

  if (isPending) {
    return (
      <PageContainer>
        <Skeleton className="h-64" />
      </PageContainer>
    );
  }

  if (!list.length) {
    return (
      <PageContainer>
        <EmptyState
          icon={<IconFish />}
          title="还没有游戏账号"
          description="交换助手要用某个账号的会话与背包来扫描和执行，先添加一个账号。"
          action={
            <Button asChild size="sm">
              <Link to="/accounts">去添加账号</Link>
            </Button>
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer wide>
      {accountId ? <SwapPanel key={accountId} accountId={accountId} /> : null}
    </PageContainer>
  );
}

function SwapPanel({ accountId }: { accountId: string }) {
  const { data: state, isPending, error } = useSwapState(accountId);
  const scan = useStartSwapScan(accountId);
  const exec = useExecuteSwapPath(accountId);
  const [confirming, setConfirming] = useState<SwapPathView | null>(null);

  const scanning = state?.status === "scanning";
  const result = state?.result ?? null;

  return (
    <div className="space-y-4">
      {/* 操作条：扫描 / 进度 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="gap-1.5" disabled={scanning || scan.isPending} onClick={() => scan.mutate()}>
          {scanning ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconRefresh className="size-3.5" />}
          {state?.result ? "重新扫描" : "开始扫描"}
        </Button>
        {scanning ? (
          <span className="text-muted-foreground text-xs">
            {state.progress.phase}
            {state.progress.pages ? ` · 第 ${state.progress.pages} 页 · 已收 ${state.progress.orders} 张单` : ""}
          </span>
        ) : null}
        {!scanning && result ? (
          <span className="text-muted-foreground text-xs" title={new Date(result.stats.scannedAt).toLocaleString("zh-CN")}>
            上次扫描：{fmtRelative(result.stats.scannedAt)} · {result.stats.orders} 张单 / {result.stats.edges} 条边 /{" "}
            {result.stats.paths} 条可行链
            {result.stats.truncated ? "（达到翻页上限，可能还有没扫到的单）" : ""}
          </span>
        ) : null}
        {exec.isPending ? (
          <span className="text-muted-foreground flex items-center gap-1 text-xs">
            <IconLoader2 className="size-3.5 animate-spin" />
            正在执行…
          </span>
        ) : null}
      </div>

      {/* 状态提示 */}
      {error ? (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertDescription>读取扫描状态失败：{(error as Error).message}</AlertDescription>
        </Alert>
      ) : null}

      {state?.status === "error" ? (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertDescription>扫描失败：{state.error ?? "未知原因"}</AlertDescription>
        </Alert>
      ) : null}

      {state?.stale && !scanning ? (
        <Alert variant="warn">
          <IconInfoCircle />
          <AlertDescription>执行过交换之后数据已经旧了（单子剩余量与背包都变了），建议重新扫描一次。</AlertDescription>
        </Alert>
      ) : null}

      {isPending ? <Skeleton className="h-40" /> : null}

      {!isPending && state?.status === "idle" ? (
        <EmptyState
          icon={<IconArrowsExchange />}
          title="还没有扫描过"
          description="点「开始扫描」：助手会拉取全部在售交换单、读一次专精进度与背包，找出所有能换到专精目标的链。"
        />
      ) : null}

      {result ? (
        <>
          {/* 专精目标概览 */}
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <IconTarget className="size-4" />
                专精目标 {result.targets.length} 个
                <span className="text-muted-foreground text-xs font-normal">
                  共 {result.stats.paths} 条可行链
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {result.targets.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  现在没有需要换的专精目标（可能都已备齐，或专精目标还没轮到）。
                </p>
              ) : (
                result.targets.map((t) => (
                  <div key={t.fishId} className="bg-muted/30 flex flex-wrap items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs">
                    <Badge variant="outline" className="shrink-0">
                      {t.rarityLabel || t.rarity}
                    </Badge>
                    <span className="font-medium">{t.name}</span>
                    <span className="text-muted-foreground text-[11px]">{place(t.biomeCode, t.biomeName)}</span>
                    <span className="text-muted-foreground ml-auto text-[11px]">
                      还差 {t.remaining} 条 · 现有 {t.available} 条 ·{" "}
                      {t.pathCount ? (
                        <span className="text-foreground">{t.pathCount} 条链可换</span>
                      ) : (
                        "暂无可换的链"
                      )}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* 可行链 */}
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <IconArrowsExchange className="size-4" />
                可行交换链
                <span className="text-muted-foreground text-xs font-normal">按跳数从少到多</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {result.paths.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  当前市场上没有能换到这些专精目标的链（只接别人挂出的现成单；中间某一手没人挂单就会走不通）。
                </p>
              ) : (
                result.paths.map((p) => (
                  <PathCard
                    key={p.key}
                    path={p}
                    targetName={result.targets.find((t) => t.fishId === p.targetFishId)?.name ?? p.targetFishId}
                    busy={exec.isPending}
                    onExecute={() => setConfirming(p)}
                  />
                ))
              )}
            </CardContent>
          </Card>

          <p className="text-muted-foreground flex items-start gap-1 text-xs">
            <IconInfoCircle className="mt-0.5 size-3 shrink-0" />
            链由「别人挂出的现成交换单」串起来：执行时会逐跳响应，中途被抢单 / 缺鱼会停在那一步并说明，
            已经换到的鱼留在背包里。交换来的鱼不计入图鉴，但命中专精目标且开着自动锁定时仍受专精锁保护。
          </p>
        </>
      ) : null}

      <AlertDialog open={Boolean(confirming)} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>执行这条交换链？</AlertDialogTitle>
            <AlertDialogDescription>
              会真的把鱼换出去（{confirming?.hops.length ?? 0} 跳）：交出 {confirming?.hops[0]?.give.name}
              {confirming && confirming.hops.length > 1 ? ` 等 ${confirming.hops.length} 条` : ""}，最终换到{" "}
              {confirming?.hops[confirming.hops.length - 1]?.get.name}。中途失败会停在那一步，已换到的鱼留在背包里。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirming) return;
                exec.mutate(
                  confirming.hops.map((h) => ({
                    orderId: h.orderId,
                    requestFishId: h.give.fishId,
                    offerFishId: h.get.fishId,
                  })),
                );
                setConfirming(null);
              }}
            >
              确认执行
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PathCard({
  path,
  targetName,
  busy,
  onExecute,
}: {
  path: SwapPathView;
  targetName: string;
  busy: boolean;
  onExecute: () => void;
}) {
  return (
    <div className="bg-muted/30 space-y-1.5 rounded-xl px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary" className="shrink-0">
          {path.length} 跳
        </Badge>
        <span className="text-muted-foreground text-[11px]">
          目标 · {targetName}
        </span>
        <Button size="sm" variant="outline" className="ml-auto h-7 gap-1 text-[11px]" disabled={busy} onClick={onExecute}>
          <IconArrowsExchange className="size-3" />
          执行这条链
        </Button>
      </div>

      {/* 每一手：交出什么 → 获得什么（单主 + 还能成交几次） */}
      <div className="space-y-1">
        {path.hops.map((hop, i) => (
          <div key={`${hop.orderId}-${String(i)}`} className="flex flex-wrap items-center gap-1 text-[11px]">
            <span className="font-medium">
              {place(hop.give.biomeCode, null)} {hop.give.name}
            </span>
            <IconChevronRight className="text-muted-foreground size-3" />
            <span className="font-medium">
              {place(hop.get.biomeCode, null)} {hop.get.name}
            </span>
            <span className="text-muted-foreground">
              （单主 {hop.owner ?? "未知"}，剩 {hop.capacity} 次）
            </span>
            {i === path.hops.length - 1 ? <IconCircleCheck className="text-[var(--status-online)] size-3" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

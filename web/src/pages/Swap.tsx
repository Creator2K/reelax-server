// 交换助手（专精换鱼）
//
// 移植自浏览器脚本《专精交换助手 v1.2.0》：扫全市场的交换单，找出「用我手上的鱼、
// 经几手以物易物换到专精目标」的可行链，然后由**我手动点执行**。
//
// 页面刻意做得短：一屏只有「账号 + 扫描 + 筛选 + 条数 + 数量 + 按钮 + 日志」，
// 目标清单与链明细都收进下拉框和「展开」里 —— 想知道细节再点开，平时只看数字。
//
// ★ 账号选择器放在页面里、不放顶栏：顶栏那个位置在手机上会被挤爆，
//   而且 usePageHeader 的 actions 只在标题变化时重建，放在顶栏的控件拿不到最新状态。
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconFish,
  IconInfoCircle,
  IconLoader2,
  IconPlayerStop,
  IconRefresh,
  IconTerminal2,
} from "@tabler/icons-react";
import { PageContainer, EmptyState } from "@/components/layout/PageContainer.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useAccounts, useSwapState, type SwapPathView } from "@/lib/queries.ts";
import { useExecuteSwapPath, useRunSwap, useStartSwapScan, useStopSwap } from "@/lib/mutations.ts";
import { fmtRelative } from "@/lib/utils.ts";

/** 「B2 雾语湿地」这种地图说法（只有编号时退回编号，都没有就说不出来） */
const place = (code: string | null, name: string | null) =>
  code ? `${code}${name ? ` ${name}` : ""}` : (name ?? "");

const ALL = "";

/** 一次最多换几条（与服务端上限一致） */
const QUANTITY_CHOICES = [1, 2, 3, 5, 10];

/** 数量下拉的可选项：常用档位 + 「刚好换满目标差额」那一档（4 条这种也要能选） */
function quantityOptions(remaining: number): number[] {
  const cap = Math.max(1, remaining);
  return [...new Set([...QUANTITY_CHOICES, cap])].filter((n) => n <= cap).sort((a, b) => a - b);
}

/** 下拉框统一的样式（窄屏占满一行，宽屏自动分栏） */
const selectClass = "border-input bg-background h-9 w-full min-w-0 rounded-md border px-2 text-xs";

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

  usePageHeader("交换助手", "扫全市场交换单，按筛选换到专精目标");

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
      <div className="space-y-4">
        <Card className="gap-3">
          <CardContent className="grid gap-2 pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="min-w-0 space-y-1">
              <span className="text-muted-foreground block text-[11px]">账号</span>
              <select
                className={selectClass}
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
            {accountId ? <SwapScanButton accountId={accountId} /> : null}
          </CardContent>
        </Card>

        {accountId ? <SwapPanel key={accountId} accountId={accountId} /> : null}
      </div>
    </PageContainer>
  );
}

/** 扫描按钮 + 进度（与账号选择放在同一张卡里） */
function SwapScanButton({ accountId }: { accountId: string }) {
  const { data: state } = useSwapState(accountId);
  const scan = useStartSwapScan(accountId);
  const scanning = state?.status === "scanning";
  const result = state?.result ?? null;

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        className="w-full gap-1.5 sm:w-auto"
        disabled={scanning || scan.isPending}
        onClick={() => scan.mutate()}
      >
        {scanning ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconRefresh className="size-3.5" />}
        {result ? "重新扫描" : "开始扫描"}
      </Button>
      <div className="text-muted-foreground text-[11px] sm:text-right">
        {scanning
          ? `${state?.progress.phase ?? ""}${state?.progress.pages ? ` · 第 ${state.progress.pages} 页 · 已收 ${state.progress.orders} 张单` : ""}`
          : result
            ? `${fmtRelative(result.stats.scannedAt)}扫描 · ${result.stats.orders} 张单 · ${result.stats.paths} 条链 · ${result.stats.targets} 个目标${result.stats.truncated ? "（达翻页上限）" : ""}`
            : "还没扫描过"}
      </div>
    </div>
  );
}

function SwapPanel({ accountId }: { accountId: string }) {
  const { data: state, isPending, error } = useSwapState(accountId);
  const run = useRunSwap(accountId);
  const stop = useStopSwap(accountId);
  const single = useExecuteSwapPath(accountId);

  const [rarity, setRarity] = useState(ALL);
  const [biomeId, setBiomeId] = useState(ALL);
  const [targetFishId, setTargetFishId] = useState(ALL);
  const [onlyUpgrade, setOnlyUpgrade] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [showChains, setShowChains] = useState(false);

  const running = state?.run?.status === "running";
  const result = state?.result ?? null;

  /** 有链的目标（按「鱼 + 地图 + 稀有度」去重）—— 下拉框的候选来源 */
  const chainTargets = useMemo(() => {
    const map = new Map<string, SwapPathView["target"]>();
    for (const p of result?.paths ?? []) {
      const key = `${p.target.fishId}|${p.target.biomeId ?? ""}|${p.target.rarity}`;
      if (!map.has(key)) map.set(key, p.target);
    }
    return [...map.values()];
  }, [result]);

  /** 稀有度候选项（始终列出全部有链的档位，否则切不回去） */
  const rarities = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of chainTargets) map.set(t.rarity, t.rarityLabel || t.rarity);
    return [...map.entries()].map(([value, label]) => ({ value, label }));
  }, [chainTargets]);

  /** 地图候选项：跟着稀有度收窄 */
  const biomes = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of chainTargets) {
      if (rarity && t.rarity !== rarity) continue;
      if (!t.biomeId) continue;
      map.set(t.biomeId, place(t.biomeCode, t.biomeName));
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }));
  }, [chainTargets, rarity]);

  /** 当前筛选命中的链：直接用链自己的目标信息判断（不再按 fishId 去 targets 里找） */
  const chains = useMemo(
    () =>
      (result?.paths ?? []).filter((p) => {
        if (rarity && p.target.rarity !== rarity) return false;
        if (biomeId && p.target.biomeId !== biomeId) return false;
        if (onlyUpgrade && !p.upgrade) return false;
        if (targetFishId && p.targetFishId !== targetFishId) return false;
        return true;
      }),
    [result, rarity, biomeId, onlyUpgrade, targetFishId],
  );

  /** 目标下拉：只列「当前筛选下真有链」的目标，并带上条数 */
  const targetOptions = useMemo(() => {
    const count = new Map<string, number>();
    for (const p of chains) count.set(p.targetFishId, (count.get(p.targetFishId) ?? 0) + 1);
    const seen = new Set<string>();
    return chainTargets
      .filter((t) => {
        if (rarity && t.rarity !== rarity) return false;
        if (biomeId && t.biomeId !== biomeId) return false;
        if (!count.has(t.fishId)) return false;
        if (seen.has(t.fishId)) return false;
        seen.add(t.fishId);
        return true;
      })
      .map((t) => ({ ...t, pathCount: count.get(t.fishId) ?? 0 }));
  }, [chainTargets, chains, rarity, biomeId]);

  /** 完全没链的目标数（提示用） */
  const hopless = (result?.targets.length ?? 0) - chainTargets.length;
  /** 有链、但被当前筛选挡住的目标数 */
  const filteredOut = Math.max(0, chainTargets.length - targetOptions.length - (hopless > 0 ? 0 : 0));

  const remainingTotal = useMemo(
    () => targetOptions.filter((t) => !targetFishId || t.fishId === targetFishId).reduce((acc, t) => acc + Math.max(1, t.remaining), 0),
    [targetOptions, targetFishId],
  );
  const quantityValue = Math.max(1, Math.min(quantity, Math.max(1, remainingTotal)));

  const filterHint = useMemo(() => {
    const parts: string[] = [];
    if (rarity) parts.push(rarities.find((r) => r.value === rarity)?.label ?? rarity);
    if (biomeId) parts.push(biomes.find((b) => b.value === biomeId)?.label ?? biomeId);
    if (targetFishId) parts.push(targetOptions.find((t) => t.fishId === targetFishId)?.name ?? targetFishId);
    if (onlyUpgrade) parts.push("只要不降级");
    return parts.join(" · ");
  }, [rarity, biomeId, targetFishId, onlyUpgrade, rarities, biomes, targetOptions]);

  const send = () =>
    run.mutate({
      quantity,
      rarity: rarity || null,
      biomeId: biomeId || null,
      targetFishId: targetFishId || null,
      onlyUpgrade,
    });

  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertDescription>读取状态失败：{(error as Error).message}</AlertDescription>
        </Alert>
      ) : null}

      {state?.status === "error" ? (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertDescription>扫描失败：{state.error ?? "未知原因"}</AlertDescription>
        </Alert>
      ) : null}

      {state?.stale && !running ? (
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
          description="点上面的「开始扫描」：助手会拉取全部在售交换单、读一次专精进度与背包，找出所有能换到专精目标的链。"
        />
      ) : null}

      {result ? (
        <Card className="gap-3">
          <CardContent className="space-y-3 pt-4">
            {/* 筛选：稀有度 → 地图 → 目标鱼 + 高换低开关 */}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <label className="min-w-0 space-y-1">
                <span className="text-muted-foreground block text-[11px]">稀有度</span>
                <select
                  className={selectClass}
                  value={rarity}
                  disabled={running}
                  onChange={(e) => {
                    setRarity(e.target.value);
                    setBiomeId(ALL);
                    setTargetFishId(ALL);
                  }}
                >
                  <option value={ALL}>全部</option>
                  {rarities.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="min-w-0 space-y-1">
                <span className="text-muted-foreground block text-[11px]">目标地图</span>
                <select
                  className={selectClass}
                  value={biomeId}
                  disabled={running}
                  onChange={(e) => {
                    setBiomeId(e.target.value);
                    setTargetFishId(ALL);
                  }}
                >
                  <option value={ALL}>全部</option>
                  {biomes.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="min-w-0 space-y-1">
                <span className="text-muted-foreground block text-[11px]">专精目标鱼（只列有链的）</span>
                <select
                  className={selectClass}
                  value={targetFishId}
                  disabled={running}
                  onChange={(e) => setTargetFishId(e.target.value)}
                >
                  <option value={ALL}>全部（任意目标都算）</option>
                  {targetOptions.map((t) => (
                    <option key={t.fishId} value={t.fishId}>
                      {t.name}（{place(t.biomeCode, null)}）· 还差 {t.remaining} · {t.pathCount} 条链
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-center gap-2 sm:pt-5">
                <Switch
                  id="swap-upgrade"
                  checked={onlyUpgrade}
                  disabled={running}
                  onCheckedChange={(v) => setOnlyUpgrade(v)}
                />
                <label htmlFor="swap-upgrade" className="text-xs">
                  过滤高换低
                  <span className="text-muted-foreground block text-[11px]">不换到等级更低的地图</span>
                </label>
              </div>
            </div>

            {hopless > 0 || filteredOut > 0 ? (
              <p className="text-muted-foreground text-[11px]">
                {hopless > 0 ? `另有 ${hopless} 个专精目标暂没有可行链` : ""}
                {hopless > 0 && filteredOut > 0 ? "；" : ""}
                {filteredOut > 0 ? `${filteredOut} 个目标被当前筛选挡住` : ""}
                （都不会出现在上面的下拉框里）
              </p>
            ) : null}

            {/* 条数 + 数量 + 执行 */}
            <div className="space-y-2 border-t pt-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span>
                  当前筛选：<span className="font-medium">{chains.length}</span> 条链
                </span>
                <span className="text-muted-foreground text-xs">
                  {targetOptions.length} 个目标
                  {filterHint ? `（${filterHint}）` : ""}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">换</span>
                  <select
                    className="border-input bg-background h-8 w-16 rounded-md border px-2 text-xs"
                    value={String(quantityValue)}
                    disabled={running}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                  >
                    {quantityOptions(remainingTotal).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <span className="text-muted-foreground">
                    条{remainingTotal < quantity ? `（目标只差 ${remainingTotal} 条，按 ${quantityValue} 算）` : ""}
                  </span>
                </label>

                {running ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-1.5 sm:w-auto"
                    disabled={stop.isPending}
                    onClick={() => stop.mutate()}
                  >
                    <IconPlayerStop className="size-3.5" />
                    停止
                  </Button>
                ) : (
                  <Button size="sm" className="w-full gap-1.5 sm:w-auto" disabled={!chains.length || run.isPending} onClick={send}>
                    <IconArrowsExchange className="size-3.5" />
                    开始换
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full gap-1 text-xs sm:ml-auto sm:w-auto"
                  onClick={() => setShowChains((v) => !v)}
                >
                  <IconChevronDown className={showChains ? "size-3.5 rotate-180 transition-transform" : "size-3.5"} />
                  {showChains ? "收起明细" : `展开看会走哪几手（${chains.length}）`}
                </Button>
              </div>

              {running ? (
                <p className="flex items-center gap-1 text-xs">
                  <IconLoader2 className="size-3.5 animate-spin" />
                  已换到 {state?.run.doneCount ?? 0}/{state?.run.targetCount ?? 0} 条
                  {state?.run.current ? ` · ${state.run.current}` : ""}
                </p>
              ) : state && state.run.status !== "idle" && state.run.note ? (
                <p className="text-muted-foreground text-xs">
                  上次执行：{state.run.note}（换到 {state.run.doneCount}/{state.run.targetCount} 条）
                </p>
              ) : null}
            </div>

            {/* 明细：默认收起，展开后每条可以单独执行 */}
            {showChains ? (
              <div className="space-y-1.5 border-t pt-3">
                {chains.length === 0 ? (
                  <p className="text-muted-foreground text-xs">当前筛选下没有可走的链。</p>
                ) : (
                  chains.slice(0, 50).map((p) => (
                    <ChainRow
                      key={p.key}
                      path={p}
                      busy={running || single.isPending}
                      onExecute={() =>
                        single.mutate(
                          p.hops.map((h) => ({
                            orderId: h.orderId,
                            requestFishId: h.give.fishId,
                            offerFishId: h.get.fishId,
                          })),
                        )
                      }
                    />
                  ))
                )}
                {chains.length > 50 ? (
                  <p className="text-muted-foreground text-[11px]">
                    只列出前 50 条（共 {chains.length} 条），执行时会自动挑最优的。
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* 日志：最新的在最上面 */}
      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <IconTerminal2 className="size-4" />
            日志
            <span className="text-muted-foreground text-xs font-normal">
              {state?.log.length ? `最近 ${state.log.length} 条` : "扫描与交换的每一步"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {state?.log.length ? (
            <div className="bg-muted/30 max-h-72 space-y-0.5 overflow-y-auto rounded-lg px-2.5 py-2 font-mono text-[11px] leading-relaxed sm:px-3">
              {state.log.map((entry, i) => (
                <div
                  key={`${String(entry.t)}-${String(i)}`}
                  className={
                    "break-words " +
                    (entry.level === "error"
                      ? "text-destructive"
                      : entry.level === "warn"
                        ? "text-[var(--status-warn)]"
                        : "text-foreground")
                  }
                >
                  [{new Date(entry.t).toLocaleTimeString("zh-CN", { hour12: false })}] {entry.text}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              还没有日志。扫描一次、或点「开始换」，这里会逐条写下每一步（哪条链、第几跳、成功还是被抢单）。
            </p>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground flex items-start gap-1 text-xs">
        <IconInfoCircle className="mt-0.5 size-3 shrink-0" />
        链由「别人挂出的现成交换单」串起来：每一跳前都会重新确认鱼还在背包里，中途被抢单 / 缺鱼会换下一条链，
        换到的鱼留在背包里。交换来的鱼不计入图鉴，但命中专精目标且开着自动锁定时仍受专精锁保护。
      </p>
    </div>
  );
}

/** 明细里的一条链：一行摘要（起点 → 目标，两边都带 B 几）+ 展开后的每一手 + 「只执行这一条」 */
function ChainRow({
  path,
  busy,
  onExecute,
}: {
  path: SwapPathView;
  busy: boolean;
  onExecute: () => void;
}) {
  const [open, setOpen] = useState(false);
  const start = path.hops[0];

  return (
    <div className="bg-muted/30 space-y-1 rounded-lg px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Badge variant="secondary" className="shrink-0">
          {path.length} 跳
        </Badge>
        {!path.upgrade ? (
          <Badge variant="warn" className="shrink-0" title="目标地图等级低于起点地图">
            降级
          </Badge>
        ) : null}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <IconChevronRight className={open ? "size-3 shrink-0 rotate-90 transition-transform" : "size-3 shrink-0 transition-transform"} />
          <span className="min-w-0 break-words">
            <span className="font-medium">
              {place(path.startBiomeCode, null)} {start?.give.name}
            </span>
            <span className="text-muted-foreground"> → </span>
            <span className="font-medium">
              {place(path.target.biomeCode, null)} {path.target.name}
            </span>
          </span>
        </button>
        <Button size="sm" variant="outline" className="ml-auto h-6 shrink-0 px-2 text-[11px]" disabled={busy} onClick={onExecute}>
          只执行这一条
        </Button>
      </div>

      {open ? (
        <div className="space-y-0.5 pl-4 text-[11px]">
          {path.hops.map((hop, i) => (
            <div key={`${hop.orderId}-${String(i)}`} className="break-words">
              <span className="font-medium">
                {place(hop.give.biomeCode, null)} {hop.give.name}
              </span>
              <IconChevronRight className="text-muted-foreground mx-0.5 inline size-3" />
              <span className="font-medium">
                {place(hop.get.biomeCode, null)} {hop.get.name}
              </span>
              <span className="text-muted-foreground">
                （单主 {hop.owner ?? "未知"}，剩 {hop.capacity} 次）
                {i === path.hops.length - 1 ? ` · 目标还差 ${path.target.remaining} 条` : ""}
              </span>
              {i === path.hops.length - 1 ? (
                <IconCircleCheck className="text-[var(--status-online)] ml-1 inline size-3" />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

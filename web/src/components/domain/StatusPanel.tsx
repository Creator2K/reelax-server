// 账号状态面板：地图 / 天气 / 经验加成 / 等级与经验 / 转生 / 保底 / Buff
//
// 排版约定（对标 LDC StatCard 范式）：
//  · 数值卡用 bg-muted 圆角底、无边框；数值 tabular-nums
//  · 「进度」类信息一律给进度条（等级 / 经验 / 转生 / 保底），不只给数字
//  · 经验分区标签**不能截断** —— 用整行的「标签  数值」两栏，放不下就换行
//  · 顶部徽章已经写了地图/天气/鱼饵，面板里不再重复一遍鱼饵卡
import {
  IconBolt,
  IconChevronDown,
  IconCoins,
  IconFish,
  IconFlame,
  IconGauge,
  IconMapPin,
  IconRefresh,
  IconShip,
  IconSparkles,
  IconStar,
  IconTrendingUp,
} from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { StatCard, ProgressBar } from "@/components/domain/StatCard.tsx";
import type { PityProgress, StatusPanel } from "@/lib/queries.ts";
import { fmtCompact, fmtExact, fmtNum, fmtPct, fmtRelative } from "@/lib/utils.ts";

/** 等级上限（游戏内满级）。用于等级进度条。 */
const MAX_LEVEL = 20_000;

const SECTION_LABELS: Record<string, string> = {
  permanentBp: "地图专精 + 天赋",
  artifactBp: "神器",
  weatherBp: "天气",
  wisdomBp: "智力",
  guildBp: "公会图腾 + 区域",
  partyBp: "船队",
  shopBp: "商店增益",
  eventBp: "活动增益",
};

export function StatusPanelCard({ panel }: { panel: StatusPanel | null }) {
  if (!panel) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">实时状态</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            还没有状态数据。启动引擎后，这里会显示当前地图、天气、等级经验、转生进度与保底进度。
          </p>
        </CardContent>
      </Card>
    );
  }

  const sections = panel.sections ?? {};
  const re = panel.reincarnation;
  const level = panel.level ?? 0;
  const xpPct =
    panel.experience != null && panel.experienceToNextLevel
      ? Math.round((panel.experience / panel.experienceToNextLevel) * 100)
      : null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-sm">
          <span>实时状态</span>
          {panel.at ? (
            <span className="text-muted-foreground text-[11px] font-normal">{fmtRelative(panel.at)}</span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ---------- 顶部徽章：地图 / 天气 / 鱼饵 / 船队 ---------- */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1 font-normal">
            <IconMapPin className="size-3" />
            {panel.biomeName ?? "未知地图"}
            {panel.valueMultiplier ? ` ×${panel.valueMultiplier.toFixed(2)}` : ""}
          </Badge>
          {panel.weatherName ? (
            <Badge variant="outline" className="gap-1 font-normal">
              <IconBolt className="size-3" />
              {panel.weatherName}
              {panel.weatherXpPct ? ` 经验${panel.weatherXpPct > 0 ? "+" : ""}${panel.weatherXpPct}%` : ""}
            </Badge>
          ) : null}
          {panel.baitName ? (
            <Badge variant="outline" className="gap-1 font-normal">
              <IconFish className="size-3" />
              {panel.baitName}
              {panel.baitUnitPrice ? <span className="opacity-70">· {fmtNum(panel.baitUnitPrice)}/个</span> : null}
            </Badge>
          ) : null}
          {panel.fleet ? (
            <Badge variant="outline" className="gap-1 font-normal">
              <IconShip className="size-3" />
              {panel.fleet.boatName ?? "船队"} @ {panel.fleet.boatBiomeName ?? "?"}
              {panel.fleet.sameAsCurrent ? "（同图）" : "（不同图）"}
            </Badge>
          ) : null}
        </div>

        {/* ---------- 等级与经验：都用进度条 ---------- */}
        <div className="space-y-3">
          {/* 等级：以游戏满级为上限 */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <IconGauge className="size-3.5" />
                等级
              </span>
              <span className="mono-num text-sm font-semibold">
                Lv {fmtNum(level)}
                <span className="text-muted-foreground ml-1 text-[11px] font-normal">
                  / {fmtNum(MAX_LEVEL)}（{((level / MAX_LEVEL) * 100).toFixed(1)}%）
                </span>
              </span>
            </div>
            <ProgressBar value={level} max={MAX_LEVEL} tone={level >= MAX_LEVEL ? "success" : "info"} />
          </div>

          {/* 经验：距下一级 */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <IconTrendingUp className="size-3.5" />
                经验进度
              </span>
              <span className="mono-num text-sm font-semibold">
                {xpPct != null ? `${xpPct}%` : "—"}
                {panel.experience != null && panel.experienceToNextLevel ? (
                  <span className="text-muted-foreground ml-1 text-[11px] font-normal">
                    {fmtNum(panel.experience)} / {fmtNum(panel.experienceToNextLevel)}
                  </span>
                ) : null}
              </span>
            </div>
            <ProgressBar
              value={panel.experience ?? 0}
              max={panel.experienceToNextLevel ?? 1}
              tone={xpPct != null && xpPct >= 90 ? "success" : "info"}
            />
          </div>
        </div>

        {/* ---------- 资源卡：金币 / 遗物 / 碎片（鱼饵已在顶部徽章里） ----------
            数值走 fmtCompact：窄卡一行只放得下 4 个字符左右，
            fmtNum(16427000) 会得到 "1642.7 万" 而挤到第二行；
            fmtCompact 压成 "1643万"，精确值放 title（悬停可看）。 */}
        <div className="grid grid-cols-3 gap-2.5">
          <StatCard
            label="金币"
            icon={<IconCoins className="size-3.5" />}
            tone="warning"
            value={panel.gold != null ? fmtCompact(panel.gold) : "—"}
            title={panel.gold != null ? `金币 ${fmtExact(panel.gold)}` : undefined}
          />
          <StatCard
            label="遗物"
            icon={<IconSparkles className="size-3.5" />}
            tone="accent"
            value={panel.relics != null ? fmtCompact(panel.relics) : "—"}
            title={panel.relics != null ? `遗物 ${fmtExact(panel.relics)}` : undefined}
            delay={0.04}
          />
          <StatCard
            label="碎片"
            icon={<IconStar className="size-3.5" />}
            tone="accent"
            value={panel.fragments != null ? fmtCompact(panel.fragments) : "—"}
            title={panel.fragments != null ? `碎片 ${fmtExact(panel.fragments)}` : undefined}
            delay={0.08}
          />
        </div>

        {/* ---------- 经验加成构成 ---------- */}
        {Object.values(sections).some((bp) => Number(bp) !== 0) ? (
          <>
            <Separator />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">经验加成构成</span>
                <span className="mono-num text-sm font-semibold">×{(panel.xpTotal ?? 1).toFixed(2)}</span>
              </div>
              {/* 两栏「标签 数值」，标签完整显示不截断 */}
              <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                {Object.entries(sections)
                  .filter(([, bp]) => Number(bp) !== 0)
                  .map(([key, bp]) => (
                    <div key={key} className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">{SECTION_LABELS[key] ?? key}</span>
                      <span className="mono-num shrink-0">{fmtPct(bp)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </>
        ) : null}

        {/* ---------- 转生进度 ---------- */}
        {re ? (
          <>
            <Separator />
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">
                  转生进度{panel.reincarnationRound ? `（第 ${panel.reincarnationRound} 轮）` : ""}
                </span>
                {re.eligible ? (
                  <Badge variant="online">条件已满，可以转生</Badge>
                ) : re.awardedPoints ? (
                  <span className="text-muted-foreground text-[11px]">
                    现可拿 <span className="mono-num text-foreground font-medium">{re.awardedPoints}</span> 天赋点
                  </span>
                ) : null}
              </div>

              {re.requiredLevel ? (
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">等级要求</span>
                    <span className="mono-num">
                      {re.levelShortfall && re.levelShortfall > 0 ? (
                        <>
                          还差 <span className="text-foreground font-semibold">{fmtNum(re.levelShortfall)}</span> 级
                          <span className="text-muted-foreground ml-1.5 text-[11px]">
                            （需 Lv {fmtNum(re.requiredLevel)}）
                          </span>
                        </>
                      ) : (
                        <span className="text-emerald-600 dark:text-emerald-400">已达标</span>
                      )}
                    </span>
                  </div>
                  {/* 用「目标等级 − 还差多少」算已完成部分，避免出现负进度 */}
                  <ProgressBar
                    value={Math.max(0, re.requiredLevel - (re.levelShortfall ?? 0))}
                    max={re.requiredLevel}
                    tone={re.levelShortfall && re.levelShortfall > 0 ? "info" : "success"}
                  />
                </div>
              ) : null}

              {re.goldCost ? (
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">金币要求</span>
                    <span className="mono-num">
                      {re.goldShortfall && re.goldShortfall > 0 ? (
                        <>
                          还差 <span className="text-foreground font-semibold">{fmtNum(re.goldShortfall)}</span>
                          <span className="text-muted-foreground ml-1.5 text-[11px]">
                            （需 {fmtNum(re.goldCost)}）
                          </span>
                        </>
                      ) : (
                        <span className="text-emerald-600 dark:text-emerald-400">已达标</span>
                      )}
                    </span>
                  </div>
                  <ProgressBar
                    value={Math.max(0, re.goldCost - (re.goldShortfall ?? 0))}
                    max={re.goldCost}
                    tone={re.goldShortfall && re.goldShortfall > 0 ? "warning" : "success"}
                  />
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {/* ---------- Buff：可折叠（有 buff 时才出现） ---------- */}
        {panel.buffs.length ? (
          <>
            <Separator />
            <details open className="group">
              <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1.5 text-xs">
                <IconFlame className="size-3.5" />
                当前增益 {panel.buffs.length} 项
                <IconChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {panel.buffs.map((b, i) => (
                  <Badge key={`${b.tag}-${i}`} variant="warn" className="gap-1 font-normal">
                    {b.tag} <span className="mono-num">+{fmtPct(b.bp)}</span>
                    {b.endsAt ? <span className="opacity-70">· {fmtRelative(Date.parse(b.endsAt))}结束</span> : null}
                  </Badge>
                ))}
              </div>
            </details>
          </>
        ) : null}

        {/* ---------- 公会经验增益落点 ---------- */}
        {panel.guildBoosts.length ? (
          <>
            <Separator />
            <details open className="group">
              <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1.5 text-xs">
                <IconChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                公会经验增益（{panel.guildBoosts.length} 张图）
              </summary>
              <div className="mt-2 space-y-1.5 text-xs">
                {panel.guildBoosts.map((g, i) => (
                  <div key={`${g.biomeId}-${i}`} className="flex items-center justify-between gap-3">
                    <span>{g.name}</span>
                    <span className="mono-num text-muted-foreground shrink-0">
                      +{fmtPct(g.bp)}
                      {g.endsAt ? ` · ${fmtRelative(Date.parse(g.endsAt))}结束` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </>
        ) : null}

        {/* ---------- 保底进度 ---------- */}
        {panel.pity?.length ? (
          <>
            <Separator />
            <details open className="group">
              <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1.5 text-xs">
                <IconSparkles className="size-3.5" />
                保底进度
                <IconChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-2">
                <PitySection list={panel.pity} />
              </div>
            </details>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * 保底进度。
 *
 * 为什么单独成块并给进度条：保底是「再钓 N 杆必出」这种**临门一脚**的信息，
 * 只看数字不容易判断快到了没。临近时的醒目标示能一眼看出来。
 * 阈值会随运气/鱼饵/天气变化，所以只显示服务端算好的值，前端不重算。
 */
function PitySection({ list }: { list: PityProgress[] }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {list.map((p) => {
        // 临近保底（还剩 10% 以内）用警示色，出货前一眼可见
        const near = p.remaining > 0 && p.remaining <= Math.max(1, Math.round(p.total * 0.1));
        const tone = p.ready ? "success" : near ? "warning" : "neutral";
        return (
          <div
            key={p.key}
            className={[
              "rounded-2xl px-3.5 py-3 transition-colors",
              p.ready
                ? "bg-emerald-500/10 ring-1 ring-emerald-500/25"
                : near
                  ? "bg-amber-500/10 ring-1 ring-amber-500/25"
                  : "bg-muted",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium">{p.label}</span>
              {p.ready ? (
                <Badge variant="online" className="gap-1">
                  <IconRefresh className="size-3" />
                  下一杆必出
                </Badge>
              ) : (
                <span className="mono-num text-muted-foreground shrink-0 text-[11px]">
                  还差 <span className="text-foreground font-semibold">{p.remaining}</span>
                </span>
              )}
            </div>

            <div className="mono-num text-muted-foreground mt-1.5 text-[11px]">
              已累计 <span className="text-foreground">{fmtNum(p.dry)}</span> / {fmtNum(p.total)}
              <span className="ml-1.5 opacity-70">({p.percent}%)</span>
            </div>

            <ProgressBar className="mt-2" value={p.dry} max={p.total} tone={tone} />
          </div>
        );
      })}
    </div>
  );
}

// 账号状态面板：地图 / 天气 / 经验八分区 / 等级资源 / 保底进度 / 船队 / 鱼饵
//
// 排版说明（对标 LDC StatCard 范式，来自 workbuddy-manager）：
//  · 等级与资源用 bg-muted 圆角卡成网格，不再用「标签—值」两列对齐 ——
//    后者在中文标签长度不一（等级 / 经验/升级 / 转生进度）时参差不齐
//  · 数值用 tabular-nums，多卡并排时数字不抖
//  · 经验进度、转生进度、保底进度都用进度条，而不是只给百分比/数字
import {
  IconBolt,
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
import { CountingNumber } from "@/components/animate-ui/counting-number.tsx";
import type { PityProgress, StatusPanel } from "@/lib/queries.ts";
import { fmtNum, fmtPct, fmtRelative } from "@/lib/utils.ts";

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
            还没有状态数据。启动引擎后，这里会显示当前地图、天气、经验加成明细、等级资源与保底进度。
          </p>
        </CardContent>
      </Card>
    );
  }

  const sections = panel.sections ?? {};
  const re = panel.reincarnation;

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
        {/* 地图 / 天气 / 鱼饵 / 船队 */}
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

        {/* 经验八分区明细（只显示非零项，避免整屏 0%） */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
          {Object.entries(sections)
            .filter(([, bp]) => Number(bp) !== 0)
            .map(([key, bp]) => (
              <div key={key} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground truncate">{SECTION_LABELS[key] ?? key}</span>
                <span className="mono-num shrink-0">{fmtPct(bp)}</span>
              </div>
            ))}
          <div className="flex items-center justify-between gap-2 border-t pt-1.5 font-medium sm:col-span-4">
            <span className="text-muted-foreground">经验总倍率</span>
            <span className="mono-num">×{(panel.xpTotal ?? 1).toFixed(2)}</span>
          </div>
        </div>

        {/* Buff */}
        {panel.buffs.length ? (
          <>
            <Separator />
            <div className="flex flex-wrap gap-1.5">
              {panel.buffs.map((b, i) => (
                <Badge key={`${b.tag}-${i}`} variant="warn" className="gap-1 font-normal">
                  <IconFlame className="size-3" />
                  {b.tag} <span className="mono-num">+{fmtPct(b.bp)}</span>
                  {b.endsAt ? <span className="opacity-70">· {fmtRelative(Date.parse(b.endsAt))}结束</span> : null}
                </Badge>
              ))}
            </div>
          </>
        ) : null}

        {/* 公会经验增益落点 */}
        {panel.guildBoosts.length ? (
          <>
            <Separator />
            <div className="space-y-1.5 text-xs">
              <div className="text-muted-foreground">公会经验增益落在哪张图</div>
              {panel.guildBoosts.map((g, i) => (
                <div key={`${g.biomeId}-${i}`} className="flex items-center justify-between gap-2">
                  <span className="truncate">{g.name}</span>
                  <span className="mono-num text-muted-foreground shrink-0">
                    +{fmtPct(g.bp)}
                    {g.endsAt ? ` · ${fmtRelative(Date.parse(g.endsAt))}结束` : ""}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {/* 等级与资源：圆角底卡网格 */}
        <Separator />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <StatCard
            label="等级"
            icon={<IconGauge className="size-3.5" />}
            value={panel.level ? <CountingNumber number={panel.level} /> : "—"}
            hint={re?.requiredLevel ? `转生需 Lv ${fmtNum(re.requiredLevel)}` : undefined}
          />
          <StatCard
            label="经验进度"
            icon={<IconTrendingUp className="size-3.5" />}
            tone="info"
            value={
              panel.experience != null && panel.experienceToNextLevel
                ? `${Math.round((panel.experience / panel.experienceToNextLevel) * 100)}%`
                : "—"
            }
            hint={
              panel.experienceToNextLevel && panel.experience != null
                ? `${fmtNum(panel.experience)} / ${fmtNum(panel.experienceToNextLevel)}`
                : undefined
            }
            delay={0.04}
          />
          <StatCard
            label="金币"
            icon={<IconCoins className="size-3.5" />}
            tone="warning"
            value={panel.gold != null ? fmtNum(panel.gold) : "—"}
            delay={0.08}
          />
          <StatCard
            label="遗物"
            icon={<IconSparkles className="size-3.5" />}
            tone="accent"
            value={panel.relics != null ? fmtNum(panel.relics) : "—"}
            delay={0.12}
          />
          <StatCard
            label="碎片"
            icon={<IconStar className="size-3.5" />}
            tone="accent"
            value={panel.fragments != null ? fmtNum(panel.fragments) : "—"}
            delay={0.16}
          />
          <StatCard
            label="当前鱼饵"
            icon={<IconFish className="size-3.5" />}
            value={<span className="text-base sm:text-lg">{panel.baitName ?? "—"}</span>}
            hint={panel.baitUnitPrice ? `单价 ${fmtNum(panel.baitUnitPrice)} 金币` : undefined}
            delay={0.2}
          />
        </div>

        {/* 转生进度 */}
        {re ? (
          <>
            <Separator />
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="text-muted-foreground text-xs">转生进度</div>
                {re.eligible ? (
                  <Badge variant="online">可以转生了</Badge>
                ) : re.awardedPoints ? (
                  <span className="text-muted-foreground text-[11px]">
                    现可拿 <span className="mono-num text-foreground">{re.awardedPoints}</span> 天赋点
                  </span>
                ) : null}
              </div>

              {re.requiredLevel ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">还差等级</span>
                    <span className="mono-num">
                      {re.levelShortfall && re.levelShortfall > 0 ? `${fmtNum(re.levelShortfall)} 级` : "已达标"}
                    </span>
                  </div>
                  <ProgressBar
                    value={panel.level ?? 0}
                    max={re.requiredLevel}
                    tone={re.levelShortfall && re.levelShortfall > 0 ? "info" : "success"}
                  />
                </div>
              ) : null}

              {re.goldCost ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">还差金币</span>
                    <span className="mono-num">
                      {re.goldShortfall && re.goldShortfall > 0 ? fmtNum(re.goldShortfall) : "已达标"}
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

        {/* 保底进度 */}
        {panel.pity?.length ? (
          <>
            <Separator />
            <PitySection list={panel.pity} />
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
 * 只看数字不容易判断「快到了没」。进度条 + 临近时的醒目标示能一眼看出来。
 * 阈值（total）会随运气/鱼饵/天气变化，所以这里只显示服务端算好的值，不在前端重算。
 */
function PitySection({ list }: { list: PityProgress[] }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <IconSparkles className="text-muted-foreground size-3.5" />
        <span className="text-muted-foreground text-xs">保底进度</span>
      </div>

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
    </div>
  );
}

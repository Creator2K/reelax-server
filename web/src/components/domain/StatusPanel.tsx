// 账号状态面板：地图 / 天气 / 经验八分区 / 等级资源 / 船队 / 鱼饵
import { IconBolt, IconFish, IconMapPin, IconShip, IconTrendingUp } from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import type { StatusPanel } from "@/lib/queries.ts";
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
            还没有状态数据。启动引擎后，这里会显示当前地图、天气、经验加成明细与等级资源。
          </p>
        </CardContent>
      </Card>
    );
  }

  const sections = panel.sections ?? {};

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
        {/* 地图 / 天气 */}
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
              {panel.baitUnitPrice ? ` · ${panel.baitUnitPrice}/条` : ""}
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

        {/* 经验总倍率 */}
        <div className="bg-muted/40 rounded-lg border px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <IconTrendingUp className="size-3.5" />
              经验总倍率
            </span>
            <span className="mono-num text-lg font-semibold">×{(panel.xpTotal ?? 1).toFixed(2)}</span>
          </div>
          <p className="text-muted-foreground mt-1 text-[11px]">
            八个分区各自 (1 + 加成) 后相乘，与游戏内「经验倍率详情」一致
          </p>
        </div>

        {/* 八分区明细 */}
        <div className="space-y-1">
          {Object.entries(sections).map(([key, bp]) => (
            <div key={key} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{SECTION_LABELS[key] ?? key}</span>
              <span className="mono-num">{Number(bp) ? `+${fmtPct(bp, 2)}` : "—"}</span>
            </div>
          ))}
        </div>

        {/* 生效中的 Buff */}
        {panel.buffs?.length ? (
          <>
            <Separator />
            <div className="space-y-1.5">
              <div className="text-muted-foreground text-xs">生效中的经验增益</div>
              <div className="flex flex-wrap gap-1.5">
                {panel.buffs.map((b, i) => (
                  <Badge key={`${b.tag}-${i}`} variant="secondary" className="font-normal">
                    {b.tag} +{fmtPct(b.bp)}
                    {b.endsAt ? `（${fmtRelative(Date.parse(b.endsAt))}结束）` : ""}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {/* 公会经验增益落点 */}
        {panel.guildBoosts?.length ? (
          <>
            <Separator />
            <div className="space-y-1.5">
              <div className="text-muted-foreground text-xs">公会经验增益落在</div>
              {panel.guildBoosts.map((g) => (
                <div key={g.biomeId} className="flex items-center justify-between text-xs">
                  <span>{g.name}</span>
                  <span className="mono-num text-muted-foreground">
                    +{fmtPct(g.bp)}
                    {g.endsAt ? ` · ${fmtRelative(Date.parse(g.endsAt))}结束` : ""}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {/* 等级 / 资源 / 转生 */}
        <Separator />
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <Metric label="等级" value={panel.level ? `Lv ${fmtNum(panel.level)}` : "—"} />
          <Metric
            label="经验进度"
            value={
              panel.experience != null && panel.experienceToNextLevel
                ? `${Math.round((panel.experience / panel.experienceToNextLevel) * 100)}%`
                : "—"
            }
          />
          <Metric label="金币" value={fmtNum(panel.gold)} />
          <Metric label="遗物" value={fmtNum(panel.relics)} />
          <Metric label="碎片" value={fmtNum(panel.fragments)} />
          <Metric
            label="经验/升级"
            value={
              panel.experienceToNextLevel && panel.experience != null
                ? `${fmtNum(panel.experience)} / ${fmtNum(panel.experienceToNextLevel)}`
                : "—"
            }
          />
        </div>

        {panel.reincarnation ? (
          <>
            <Separator />
            <div className="space-y-1 text-xs">
              <div className="text-muted-foreground">转生进度</div>
              <div className="flex items-center justify-between">
                <span>还差等级</span>
                <span className="mono-num">
                  {panel.reincarnation.levelShortfall && panel.reincarnation.levelShortfall > 0
                    ? `${fmtNum(panel.reincarnation.levelShortfall)} 级`
                    : "已达标"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>还差金币</span>
                <span className="mono-num">
                  {panel.reincarnation.goldShortfall && panel.reincarnation.goldShortfall > 0
                    ? fmtNum(panel.reincarnation.goldShortfall)
                    : "已达标"}
                </span>
              </div>
              {panel.reincarnation.eligible ? (
                <Badge variant="online" className="mt-1">
                  可以转生了
                </Badge>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="mono-num">{value}</span>
    </div>
  );
}

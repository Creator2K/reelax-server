// 「地图与天气」面板：一眼看清当前天气 / 比赛状态，点地图即切换
//
// 为什么不用下拉框：可选的地图有十几张，每张还带着**天气、鱼价值倍率、比赛状态、解锁信息**
// 四项属性 —— 下拉框一行只能塞下一串文字，等于把这些信息全丢了。
// 这里用「地图卡片网格」：每张图一块，天气与倍率直接写在卡上，点一下就是换图。
import { useState } from "react";
import {
  IconAlertTriangle,
  IconBolt,
  IconCloudFog,
  IconCoins,
  IconDroplet,
  IconFlame,
  IconLoader2,
  IconLock,
  IconMapPin,
  IconShip,
  IconSparkles,
  IconSun,
  IconTrophy,
  IconWash,
  IconWind,
} from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
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
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useAccountMaps, type MapItem } from "@/lib/queries.ts";
import { useTravelAccount } from "@/lib/mutations.ts";
import { cn, fmtCompact } from "@/lib/utils.ts";

/**
 * 天气 → 图标与配色。
 *
 * `prominent: true` 的两种是**真正值得为它换图**的天气（雷暴 = 经验最高、涌流 = 奥秘鱼涌流），
 * 所以加粗 + 加一圈描边，在一屏十几张地图里能一眼扫到（用户明确要求高亮这两个）。
 */
const WEATHER_STYLE: Record<string, { icon: typeof IconSun; className: string; prominent?: boolean }> = {
  clear: { icon: IconSun, className: "bg-muted text-muted-foreground" },
  rain: { icon: IconDroplet, className: "bg-blue-500/12 text-blue-600 dark:text-blue-400" },
  gale: { icon: IconWind, className: "bg-teal-500/12 text-teal-600 dark:text-teal-400" },
  mist: { icon: IconCloudFog, className: "bg-slate-500/12 text-slate-600 dark:text-slate-400" },
  heatwave: { icon: IconFlame, className: "bg-orange-500/12 text-orange-600 dark:text-orange-400" },
  tempest: {
    icon: IconBolt,
    className: "bg-sky-500/18 text-sky-700 ring-1 ring-inset ring-sky-500/40 dark:text-sky-300",
    prominent: true,
  },
  gilded_current: { icon: IconCoins, className: "bg-amber-500/14 text-amber-600 dark:text-amber-400" },
  arcane_surge: {
    icon: IconSparkles,
    className: "bg-violet-500/18 text-violet-700 ring-1 ring-inset ring-violet-500/40 dark:text-violet-300",
    prominent: true,
  },
  wither_tide: { icon: IconWash, className: "bg-stone-500/12 text-stone-600 dark:text-stone-400" },
};
const weatherStyle = (id: string | undefined) => WEATHER_STYLE[id ?? ""] ?? WEATHER_STYLE.clear!;

/** 天气小徽章：图标 + 名字 + 经验倍率（不换行；窄了就让整行换行，别把名字拆开） */
function WeatherBadge({ weather }: { weather: MapItem["weather"] }) {
  if (!weather) return <span className="text-muted-foreground text-[11px]">天气未知</span>;
  const { icon: Icon, className, prominent } = weatherStyle(weather.id);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] whitespace-nowrap",
        prominent ? "font-bold" : "font-medium",
        className,
      )}
    >
      <Icon className={cn("size-3", prominent && "size-3.5")} />
      {weather.name}
      <span className={cn(prominent ? "opacity-90" : "opacity-75")}>经验×{weather.xpMultiplier.toFixed(2)}</span>
    </span>
  );
}

/** 一张地图的卡片：点一下就切过去 */
function MapCard({
  map,
  disabled,
  onPick,
}: {
  map: MapItem;
  disabled: boolean;
  onPick: () => void;
}) {
  if (!map.isUnlocked) {
    return (
      <div className="border-border/60 text-muted-foreground flex min-w-0 items-center gap-2 overflow-hidden rounded-xl border border-dashed px-3 py-2.5 opacity-70">
        <IconLock className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{map.name}</span>
        <span className="mono-num shrink-0 text-[11px]">
          需 Lv {fmtCompact(map.requiredLevel)}
          {map.unlockCost > 0 ? ` · ${fmtCompact(map.unlockCost)}` : ""}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled || map.isCurrent}
      onClick={onPick}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1.5 overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-colors",
        map.isCurrent
          ? "border-primary/40 bg-primary/6 ring-1 ring-primary/25"
          : "border-border/60 hover:bg-accent/50",
        disabled && !map.isCurrent && "opacity-60",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <IconMapPin className={cn("size-3.5 shrink-0", map.isCurrent ? "text-primary" : "opacity-60")} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{map.name}</span>
        {map.isCurrent ? (
          <Badge variant="online" className="shrink-0">
            当前
          </Badge>
        ) : null}
      </span>

      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <WeatherBadge weather={map.weather} />
        <span className="text-muted-foreground mono-num text-[11px] whitespace-nowrap">
          鱼价值×{map.valueMultiplier.toFixed(2)}
        </span>
      </span>

      {map.competitionActive || map.myCompetition ? (
        <Badge variant={map.myCompetition ? "warn" : "secondary"} className="w-fit max-w-full gap-1">
          {map.myCompetition ? <IconTrophy className="size-3 shrink-0" /> : null}
          <span className="truncate">{map.myCompetition ?? "有比赛"}</span>
        </Badge>
      ) : null}
    </button>
  );
}

export function MapPicker({ accountId }: { accountId: string }) {
  const { data, isPending, error } = useAccountMaps(accountId);
  const travel = useTravelAccount(accountId);
  const [carryCrew, setCarryCrew] = useState(false);
  const [pending, setPending] = useState<MapItem | null>(null);

  const canCarry = Boolean(data?.party?.inParty && data.party.canChangeBoatBiome);
  const unlocked = (data?.maps ?? []).filter((m) => m.isUnlocked);
  const locked = (data?.maps ?? []).filter((m) => !m.isUnlocked);

  const pick = (map: MapItem) => {
    const mode: "solo" | "party" = canCarry && carryCrew ? "party" : "solo";
    // 带队会把别人的号也一起挪走 —— 这种动作值得一次确认
    if (mode === "party") {
      setPending(map);
      return;
    }
    travel.mutate({ biomeId: map.id, mode });
  };

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <IconMapPin className="size-4" />
          地图与天气
          {travel.isPending ? <IconLoader2 className="text-muted-foreground size-3.5 animate-spin" /> : null}
          <span className="text-muted-foreground ml-auto text-[11px] font-normal">点地图即切换</span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {isPending ? <Skeleton className="h-24" /> : null}

        {error ? (
          <Alert variant="destructive">
            <IconAlertTriangle />
            <AlertDescription>读取地图失败：{(error as Error).message}</AlertDescription>
          </Alert>
        ) : null}

        {data ? (
          <>
            {/* 当前状态：地图 + 天气 + 比赛 */}
            <div className="bg-muted/50 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <IconMapPin className="size-3.5" />
                {data.current?.name ?? "未知地图"}
              </span>
              <WeatherBadge weather={data.current?.weather ?? null} />
              <span className="text-muted-foreground mono-num text-[11px]">
                鱼价值×{(data.current?.valueMultiplier ?? 1).toFixed(2)}
              </span>
              {data.current?.myCompetition ? (
                <Badge variant="warn" className="gap-1">
                  <IconTrophy className="size-3" />
                  {data.current.myCompetition}
                </Badge>
              ) : data.current?.competitionActive ? (
                <Badge variant="secondary">这张图有比赛</Badge>
              ) : null}
            </div>

            {/* 船队：带队开关只对有改航线权限的人显示 */}
            {data.party?.inParty ? (
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <IconShip className="size-3.5" />
                  {data.party.boatName ?? "船队"} 在 {data.party.boatBiomeId ?? "?"}
                  {canCarry ? "（你可以改航线）" : "（你没有改航线权限）"}
                </span>
                {canCarry ? (
                  <label className="flex cursor-pointer items-center gap-2">
                    带队一起走
                    <Switch checked={carryCrew} onCheckedChange={setCarryCrew} />
                  </label>
                ) : null}
              </div>
            ) : null}

            {/* 一行 1–2 张：按**面板自身宽度**决定（@container），而不是整屏宽度 ——
                左侧栏只有 ~380px，用 lg:grid-cols-3 那种断点会被挤到溢出 */}
            <div className="@container">
              <div className="grid grid-cols-1 gap-2 @[22rem]:grid-cols-2">
                {unlocked.map((m) => (
                  <MapCard key={m.id} map={m} disabled={travel.isPending} onPick={() => pick(m)} />
                ))}
              </div>

              {locked.length ? (
                <div className="mt-3 space-y-1.5">
                  <div className="text-muted-foreground text-[11px]">未解锁（可以在「自动解锁地图」里买）</div>
                  <div className="grid grid-cols-1 gap-2 @[22rem]:grid-cols-2">
                    {locked.map((m) => (
                      <MapCard key={m.id} map={m} disabled onPick={() => {}} />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>

      {/* 带队换图的确认：会动到别人的号 */}
      <AlertDialog open={Boolean(pending)} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>带队前往「{pending?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              会把整条船开过去：船上的船员一起跟过来；目标图没解锁、人不在船上、正在打其它公会赛的船员会留在原地。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) travel.mutate({ biomeId: pending.id, mode: "party" });
                setPending(null);
              }}
            >
              确认开船
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

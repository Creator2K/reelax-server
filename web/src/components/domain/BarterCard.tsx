// 交换任务面板（以物易物）：定好「拿什么换什么」→ 自动盯市场 → 能换就换、换不了排队等
//
// 为什么放在助手侧：以物易物的多轮交换要靠**别人挂的现成单**，人盯着市场很累
// （B2 换 B5 往往要 B2 → B3 → B6 → B5 好几手，中间任何一手被别人抢走就要重新找路）。
//
// 任务的写法与官方挂单一致：两侧都是**地图列表** ——
//   「B2 / B3 / B4 上的任意同稀有度鱼都能拿去换，换到 B1 / B5 / B6 上的任意同稀有度鱼都算达成」。
// 面板先选稀有度再选地图（不然下拉框太长）；一行里的稀有度在加入时确定，之后只改地图。
// 所有校验都在服务端（地图存在、稀有度是最高三档、目标图上真有这一档的鱼、起点侧还有鱼可换）。
import { useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconChevronRight,
  IconInfoCircle,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { CollapsibleCard } from "@/components/ui/collapsible-card.tsx";
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
import { useAccountBarter, type BarterPanel, type BarterSpecInput, type BarterTask } from "@/lib/queries.ts";
import { useCancelBarterTask, useCreateBarterTask } from "@/lib/mutations.ts";

/** 一行规格（还没选地图时 biomeId 为空） */
type SpecRow = { biomeId: string; rarity: string };

const isOpen = (t: BarterTask) => t.status !== "done" && t.status !== "cancelled";

/** 「雾语湿地 B2」 */
const mapLabel = (name: string | null, code: string | null, id: string) => `${name ?? id}${code ? ` ${code}` : ""}`;

export function BarterCard({ accountId }: { accountId: string }) {
  const { data, isPending, error } = useAccountBarter(accountId);

  const summary = data
    ? data.tasks.some(isOpen)
      ? `${data.tasks.filter(isOpen).length} 条待执行`
      : "还没有交换任务"
    : null;

  return (
    <CollapsibleCard
      title="交换任务"
      icon={<IconArrowsExchange className="size-4 shrink-0" />}
      summary={summary}
      contentClassName="space-y-3"
    >
      {isPending ? <Skeleton className="h-20" /> : null}

      {error ? (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertDescription>读取交换任务失败：{(error as Error).message}</AlertDescription>
        </Alert>
      ) : null}

      {data ? <BarterBody accountId={accountId} data={data} /> : null}
    </CollapsibleCard>
  );
}

function BarterBody({ accountId, data }: { accountId: string; data: BarterPanel }) {
  const create = useCreateBarterTask(accountId);
  const cancel = useCancelBarterTask(accountId);

  /** 稀有度筛选：只影响「往下面加一行时列出哪些地图」 */
  const [rarity, setRarity] = useState(() => data.limits.rarities[0]?.value ?? "mythic");
  const [fromRows, setFromRows] = useState<SpecRow[]>([]);
  const [targetRows, setTargetRows] = useState<SpecRow[]>([]);
  const [quantity, setQuantity] = useState("1");

  /** 稀有度 id → 中文名（档位来自服务端，面板不自己维护映射） */
  const rarityLabels = useMemo(
    () => new Map(data.limits.rarities.map((r) => [r.value, r.label])),
    [data.limits.rarities],
  );
  const labelOf = (r: string) => rarityLabels.get(r) ?? r;

  const startMaps = useMemo(
    () => data.startOptions.filter((o) => o.rarity === rarity),
    [data.startOptions, rarity],
  );
  const targetMaps = useMemo(
    () => data.targetOptions.filter((o) => o.rarity === rarity),
    [data.targetOptions, rarity],
  );

  const openCount = data.tasks.filter(isOpen).length;
  const busy = create.isPending || cancel.isPending;
  const full = openCount >= data.limits.maxOpenTasks;
  /** 起点与目标完全重合（同一张图同一档）等于原地不动，服务端也会拒 —— 这里先拦一下 */
  const overlapping = fromRows.some((f) =>
    targetRows.some((t) => Boolean(f.biomeId) && f.biomeId === t.biomeId && f.rarity === t.rarity),
  );
  const canSubmit =
    !busy &&
    !full &&
    !overlapping &&
    fromRows.length > 0 &&
    targetRows.length > 0 &&
    fromRows.every((r) => r.biomeId) &&
    targetRows.every((r) => r.biomeId);

  const head = data.head ? (data.tasks.find((t) => t.id === data.head!.taskId) ?? null) : null;

  /** 该地图这一档现在能拿出几条（起点行右侧提示用） */
  const availableOf = (row: SpecRow) =>
    data.startOptions.find((o) => o.biomeId === row.biomeId && o.rarity === row.rarity)?.quantity ?? 0;

  const submit = () => {
    const fromSpecs: BarterSpecInput[] = fromRows.map((r) => ({ biomeId: r.biomeId, rarity: r.rarity }));
    const targetSpecs: BarterSpecInput[] = targetRows.map((r) => ({ biomeId: r.biomeId, rarity: r.rarity }));
    create.mutate(
      { fromSpecs, targetSpecs, quantity: Math.max(1, Math.min(Math.floor(Number(quantity) || 1), data.limits.maxQuantity)) },
      {
        onSuccess: () => {
          setFromRows([]);
          setTargetRows([]);
          setQuantity("1");
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      {/* 功能没在跑：队列只会躺着，必须说清楚为什么 */}
      {!data.module.running ? (
        <Alert variant="warn">
          <IconAlertTriangle />
          <AlertDescription>
            {data.module.enabled
              ? "账号当前已停止：交换任务只会排队，账号启动后才会自动执行。"
              : "「自动以物易物」功能未启用：任务只会排队，在右侧功能列表里启用后才会自动执行。"}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 队首任务现在能不能走通 */}
      {head ? (
        <div className="bg-muted/40 space-y-1 rounded-xl px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">队首</span>
            <span className="font-medium">
              {head.fromText} → {head.targetText}
            </span>
            <Badge variant="secondary">{head.statusText}</Badge>
            <span className="text-muted-foreground">
              进度 {head.doneQuantity}/{head.quantity}
            </span>
          </div>
          {data.head?.reachable ? (
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">现在可以这样走：</span>
              <span className="font-medium">
                {data.head.startBiomeCode ? `${data.head.startBiomeCode} ` : ""}
                {data.head.startFishName}
              </span>
              {data.head.hops.map((h) => (
                <span key={h.orderId} className="flex items-center gap-1">
                  <IconChevronRight className="text-muted-foreground size-3" />
                  <span className="font-medium">
                    {h.getBiomeCode ? `${h.getBiomeCode} ` : ""}
                    {h.getName}
                  </span>
                  <span className="text-muted-foreground">
                    （{h.owner ?? "未知玩家"}，剩 {h.remaining} 次）
                  </span>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground text-[11px]">{data.head?.reason ?? "暂时没有可走的路径"}</div>
          )}
        </div>
      ) : null}

      {/* 建任务 */}
      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <IconPlus className="size-3.5" />
          新建交换任务
        </div>

        <label className="flex items-center gap-2">
          <span className="text-muted-foreground shrink-0 text-[11px]">稀有度筛选</span>
          <select
            className="border-input bg-background h-8 flex-1 rounded-md border px-2 text-xs"
            value={rarity}
            disabled={busy}
            onChange={(e) => setRarity(e.target.value)}
          >
            {data.limits.rarities.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-muted-foreground text-[11px]">
          先选档位，下面的起点 / 目标只列这一档的地图（一行加进去之后仍可改地图）。
        </p>

        <SpecRows
          title="起点侧：这些地图上的任意同档鱼都能拿去换"
          hint={startMaps.length ? `本档可选 ${startMaps.length} 张图` : "这一档暂时没有可换的鱼"}
          rows={fromRows}
          disabled={busy}
          maxRows={data.limits.maxSpecs}
          newRarity={rarity}
          labelOf={labelOf}
          onChange={setFromRows}
          optionsFor={(r) =>
            data.startOptions
              .filter((o) => o.rarity === r)
              .map((m) => ({
                value: m.biomeId,
                label: `${mapLabel(m.biomeName, m.biomeCode, m.biomeId)}（现有 ${m.quantity} 条）`,
              }))
          }
          rowSuffix={(row) => `现有 ${availableOf(row)} 条`}
          emptyLabel="选择地图"
          addLabel="增加起点地图"
        />

        <SpecRows
          title="目标侧：换到其中任意一种都算达成"
          hint={targetMaps.length ? `本档可选 ${targetMaps.length} 张图` : "这一档没有可换的目标"}
          rows={targetRows}
          disabled={busy}
          maxRows={data.limits.maxSpecs}
          newRarity={rarity}
          labelOf={labelOf}
          onChange={setTargetRows}
          optionsFor={(r) =>
            data.targetOptions
              .filter((o) => o.rarity === r)
              .map((m) => ({ value: m.biomeId, label: mapLabel(m.biomeName, m.biomeCode, m.biomeId) }))
          }
          emptyLabel="选择地图"
          addLabel="增加目标地图"
        />

        <div className="flex items-end gap-2">
          <label className="w-24 space-y-1">
            <span className="text-muted-foreground text-[11px]">换到几条</span>
            <Input
              type="number"
              min={1}
              max={data.limits.maxQuantity}
              value={quantity}
              disabled={busy}
              onChange={(e) => setQuantity(e.target.value)}
              className="h-8 text-xs"
            />
          </label>
          <span className="text-muted-foreground pb-2 text-[11px]">换够这个数量才算完成；可以填得比手上多，钓到鱼之后会继续换</span>
        </div>

        {overlapping ? (
          <p className="text-destructive text-[11px]">
            目标里有和起点完全相同的一项（同一张图、同一档），换了等于没换，请删掉其中一个。
          </p>
        ) : null}

        <Button size="sm" className="gap-1.5" disabled={!canSubmit} onClick={submit}>
          <IconArrowsExchange className="size-3.5" />
          {full ? `队列已满（${data.limits.maxOpenTasks} 条）` : "加入队列"}
        </Button>

        <p className="text-muted-foreground text-[11px]">{data.rarityHint}</p>
        <p className="text-muted-foreground flex items-start gap-1 text-[11px]">
          <IconInfoCircle className="mt-0.5 size-3 shrink-0" />
          只响应别人挂的现成交换单（自己挂单要等人响应，无法自动闭环）：某一跳市场上没人挂单时会一直等着；中途换到的鱼留在背包里。
        </p>
      </div>

      {/* 队列 */}
      {data.tasks.length ? (
        <div className="space-y-1.5 border-t pt-3">
          <div className="text-muted-foreground text-[11px]">
            队列 {openCount} / {data.limits.maxOpenTasks} 条待执行
          </div>
          {data.tasks.map((t) => (
            <TaskRow key={t.id} task={t} busy={busy} onCancel={() => cancel.mutate(t.id)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 稀有度中文名不再需要反查：档位与中文名都由服务端下发 */

/** 一侧的规格行列表（地图选择 + 增删行） */
function SpecRows({
  title,
  hint,
  rows,
  optionsFor,
  disabled,
  maxRows,
  newRarity,
  labelOf,
  emptyLabel,
  addLabel,
  rowSuffix,
  onChange,
}: {
  title: string;
  hint: string;
  rows: SpecRow[];
  /** 按**这一行自己的稀有度**给出可选地图（切筛选档位不会把已加的行弄空） */
  optionsFor: (rarity: string) => { value: string; label: string }[];
  disabled: boolean;
  maxRows: number;
  /** 新增的行用哪个稀有度（= 面板当前的筛选档位） */
  newRarity: string;
  labelOf: (rarity: string) => string;
  emptyLabel: string;
  addLabel: string;
  rowSuffix?: (row: SpecRow) => string;
  onChange: (rows: SpecRow[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-muted-foreground text-[11px]">
        {title}
        <span className="ml-1 opacity-70">· {hint}</span>
      </div>
      {rows.map((row, index) => {
        const options = optionsFor(row.rarity);
        return (
          <div key={`${row.rarity}-${String(index)}`} className="flex items-center gap-1.5">
            <Badge variant="outline" className="shrink-0">
              {labelOf(row.rarity)}
            </Badge>
            <select
              className="border-input bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-xs"
              value={row.biomeId}
              disabled={disabled}
              onChange={(e) => onChange(rows.map((r, i) => (i === index ? { ...r, biomeId: e.target.value } : r)))}
            >
              <option value="">{options.length ? emptyLabel : "这一档没有可选地图"}</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {rowSuffix && row.biomeId ? (
              <span className="text-muted-foreground shrink-0 text-[11px]">{rowSuffix(row)}</span>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 shrink-0 px-1.5"
              disabled={disabled}
              aria-label="移除这一行"
              onClick={() => onChange(rows.filter((_r, i) => i !== index))}
            >
              <IconTrash className="size-3.5" />
            </Button>
          </div>
        );
      })}
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-[11px]"
        disabled={disabled || rows.length >= maxRows || !optionsFor(newRarity).length}
        onClick={() => onChange([...rows, { biomeId: "", rarity: newRarity }])}
      >
        <IconPlus className="size-3" />
        {addLabel}
        {rows.length >= maxRows ? `（最多 ${maxRows} 项）` : ""}
      </Button>
    </div>
  );
}

function TaskRow({ task, busy, onCancel }: { task: BarterTask; busy: boolean; onCancel: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const finished = !isOpen(task);

  return (
    <div className="bg-muted/30 space-y-1 rounded-lg px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate" title={`${task.fromText} → ${task.targetText}`}>
          <span className="font-medium">{task.fromText}</span>
          <span className="text-muted-foreground"> → </span>
          <span className="font-medium">{task.targetText}</span>
          <span className="text-muted-foreground"> ×{task.quantity}</span>
        </span>
        <Badge variant={task.status === "done" ? "online" : "secondary"} className="shrink-0">
          {task.statusText}
        </Badge>
      </div>

      <div className="text-muted-foreground truncate text-[11px]" title={task.lastNote ?? undefined}>
        进度 {task.doneQuantity}/{task.quantity}
        {task.lastNote ? ` · ${task.lastNote}` : ""}
      </div>

      {!finished ? (
        <div className="pt-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive h-6 gap-1 px-2 text-[11px]"
            disabled={busy}
            onClick={() => setConfirm(true)}
          >
            <IconTrash className="size-3" />
            取消
          </Button>
        </div>
      ) : null}

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>取消这条交换任务？</AlertDialogTitle>
            <AlertDialogDescription>
              取消后不再自动继续换「{task.fromText} → {task.targetText}」。
              已经换到的鱼留在背包里（进度 {task.doneQuantity}/{task.quantity}），不会退回。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留任务</AlertDialogCancel>
            <AlertDialogAction onClick={onCancel}>确认取消</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// 交换任务面板（以物易物）：定好「拿什么换什么」→ 自动盯市场 → 能换就换、换不了排队等
//
// 为什么放在助手侧：以物易物的多轮交换要靠**别人挂的现成单**，人盯着市场很累
// （B2 换 B5 往往要 B2 → B3 → B6 → B5 好几手，中间任何一手被别人抢走就要重新找路）。
//
// 面板只做三件事：建任务、看队列推进到哪一步、取消不要的。
// 所有校验都在服务端（起点鱼必须在手、稀有度必须是最高三档、目标地图上必须真有同稀有度的鱼）。
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
import { useAccountBarter, type BarterPanel, type BarterTask } from "@/lib/queries.ts";
import { useCancelBarterTask, useCreateBarterTask } from "@/lib/mutations.ts";

/** 不填目标鱼种时的占位值（空值 = 该地图任意同稀有度鱼） */
const ANY_FISH = "";

const isOpen = (t: BarterTask) => t.status !== "done" && t.status !== "cancelled";

export function BarterCard({ accountId }: { accountId: string }) {
  const { data, isPending, error } = useAccountBarter(accountId);

  const summary = data ? (data.tasks.some(isOpen) ? `${data.tasks.filter(isOpen).length} 条待执行` : "还没有交换任务") : null;

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

  const [fromFishId, setFromFishId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [targetBiomeId, setTargetBiomeId] = useState("");
  const [targetFishId, setTargetFishId] = useState(ANY_FISH);

  const start = data.start.find((s) => s.fishId === fromFishId) ?? null;
  const rarity = start?.rarity ?? null;

  /** 目标地图候选：只列「有该稀有度鱼」的地图（换不到的图不给选） */
  const maps = useMemo(() => {
    if (!rarity) return [];
    const byBiome = new Map<string, { id: string; name: string; count: number }>();
    for (const f of data.fish) {
      if (f.rarity !== rarity) continue;
      const hit = byBiome.get(f.biomeId);
      if (hit) hit.count += 1;
      else byBiome.set(f.biomeId, { id: f.biomeId, name: f.biomeName ?? f.biomeId, count: 1 });
    }
    return [...byBiome.values()];
  }, [data.fish, rarity]);

  const fishInMap = useMemo(
    () => (rarity && targetBiomeId ? data.fish.filter((f) => f.biomeId === targetBiomeId && f.rarity === rarity) : []),
    [data.fish, rarity, targetBiomeId],
  );

  const openCount = data.tasks.filter(isOpen).length;
  const maxQuantity = start?.quantity ?? 1;
  const quantityValue = Math.max(1, Math.min(Math.floor(Number(quantity) || 1), maxQuantity));
  const busy = create.isPending || cancel.isPending;
  const full = openCount >= data.limits.maxOpenTasks;

  const head = data.head ? (data.tasks.find((t) => t.id === data.head!.taskId) ?? null) : null;

  const submit = () => {
    if (!start || !targetBiomeId) return;
    create.mutate(
      { fromFishId: start.fishId, quantity: quantityValue, targetBiomeId, targetFishId: targetFishId || null },
      {
        onSuccess: () => {
          setFromFishId("");
          setQuantity("1");
          setTargetBiomeId("");
          setTargetFishId(ANY_FISH);
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
              {head.fromFishName} → {head.targetFishName ?? `${head.targetBiomeName ?? head.targetBiomeId}任意同稀有度鱼`}
            </span>
            <Badge variant="secondary">{head.statusText}</Badge>
            <span className="text-muted-foreground">
              进度 {head.doneQuantity}/{head.quantity}
            </span>
          </div>
          {data.head?.reachable ? (
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">现在可以这样走：</span>
              <span className="font-medium">{head.fromFishName}</span>
              {data.head.hops.map((h) => (
                <span key={h.orderId} className="flex items-center gap-1">
                  <IconChevronRight className="text-muted-foreground size-3" />
                  <span className="font-medium">{h.getName}</span>
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

        {data.start.length === 0 ? (
          <p className="text-muted-foreground text-[11px]">
            背包里暂时没有可以拿去交换的鱼：需要神话 / 奇异 / 奥秘的鱼，且未锁定、不是当前专精目标鱼。
          </p>
        ) : (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-muted-foreground text-[11px]">拿出去换（起点鱼）</span>
              <select
                className="border-input bg-background h-8 w-full rounded-md border px-2 text-xs"
                value={fromFishId}
                disabled={busy}
                onChange={(e) => {
                  setFromFishId(e.target.value);
                  setQuantity("1");
                  setTargetBiomeId("");
                  setTargetFishId(ANY_FISH);
                }}
              >
                <option value="">选择起点鱼</option>
                {data.start.map((s) => (
                  <option key={s.fishId} value={s.fishId}>
                    {s.name}（{s.biomeName ?? s.biomeId ?? "未知地图"} · {s.rarityLabel}）现有 {s.quantity} 条
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end gap-2">
              <label className="w-24 space-y-1">
                <span className="text-muted-foreground text-[11px]">数量</span>
                <Input
                  type="number"
                  min={1}
                  max={maxQuantity}
                  value={quantity}
                  disabled={busy || !start}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="h-8 text-xs"
                />
              </label>
              <span className="text-muted-foreground pb-2 text-[11px]">
                {start ? `最多 ${maxQuantity} 条，必须换够才算完成` : "先选起点鱼"}
              </span>
            </div>

            <label className="block space-y-1">
              <span className="text-muted-foreground text-[11px]">换成哪张图的鱼</span>
              <select
                className="border-input bg-background h-8 w-full rounded-md border px-2 text-xs"
                value={targetBiomeId}
                disabled={busy || !start}
                onChange={(e) => {
                  setTargetBiomeId(e.target.value);
                  setTargetFishId(ANY_FISH);
                }}
              >
                <option value="">{start ? "选择目标地图" : "先选起点鱼（稀有度决定可选地图）"}</option>
                {maps.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}（{m.count} 种同稀有度鱼）
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-muted-foreground text-[11px]">具体鱼种</span>
              <select
                className="border-input bg-background h-8 w-full rounded-md border px-2 text-xs"
                value={targetFishId}
                disabled={busy || !targetBiomeId}
                onChange={(e) => setTargetFishId(e.target.value)}
              >
                <option value={ANY_FISH}>该地图任意同稀有度鱼（推荐：更好换到）</option>
                {fishInMap.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>

            <Button size="sm" className="gap-1.5" disabled={busy || full || !start || !targetBiomeId} onClick={submit}>
              <IconArrowsExchange className="size-3.5" />
              {full ? `队列已满（${data.limits.maxOpenTasks} 条）` : "加入队列"}
            </Button>
          </div>
        )}

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

function TaskRow({ task, busy, onCancel }: { task: BarterTask; busy: boolean; onCancel: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const finished = !isOpen(task);

  return (
    <div className="bg-muted/30 space-y-1 rounded-lg px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{task.fromFishName}</span>
          <span className="text-muted-foreground">（{task.fromBiomeName ?? task.fromBiomeId ?? "未知地图"}）</span>
          <span className="text-muted-foreground"> → </span>
          <span className="font-medium">
            {task.targetFishName ?? `${task.targetBiomeName ?? task.targetBiomeId}任意同稀有度鱼`}
          </span>
          <span className="text-muted-foreground"> ×{task.quantity}</span>
        </span>
        <Badge variant={task.status === "done" ? "online" : "secondary"} className="shrink-0">
          {task.statusText}
        </Badge>
      </div>

      <div className="text-muted-foreground truncate text-[11px]" title={task.lastNote ?? undefined}>
        {task.rarityLabel} · 进度 {task.doneQuantity}/{task.quantity}
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
              取消后不再自动继续换「{task.fromFishName} → {task.targetFishName ?? task.targetBiomeName}」。
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

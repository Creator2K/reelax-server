// 后台：CDK 码库
//
// 与用户页（/cdk）的区别只有两点，但都很关键：
//  · 管理员看到的是**完整码**（用户页里别人的码是打码的），方便核对与复制；
//  · 可以**手动加码**（不试领验证，直接入库）与**删除任意码**（不限提交人）。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconCopy,
  IconGift,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
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
import { api } from "@/lib/api.ts";
import { fmtDateTime, fmtRelative } from "@/lib/utils.ts";
import { useAdminCdkAdd, useAdminCdkDelete } from "@/lib/mutations.ts";

type CdkStatus = "available" | "not_started" | "exhausted";

type AdminCdkItem = {
  id: string;
  code: string;
  status: CdkStatus;
  submittedBy: string;
  submitter: string;
  successCount: number;
  lastError: string | null;
  submittedAt: number;
  lastRedeemedAt: number | null;
};

type ListBody = { items: AdminCdkItem[]; counts: Record<CdkStatus, number>; total: number };

const PAGE_SIZE = 20;

const STATUS: Record<CdkStatus, { text: string; variant: "online" | "warn" | "idle" }> = {
  available: { text: "可兑换", variant: "online" },
  not_started: { text: "未开始", variant: "warn" },
  exhausted: { text: "已失效", variant: "idle" },
};

export function AdminCdkTab() {
  const [status, setStatus] = useState<CdkStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [text, setText] = useState("");
  const [outcomes, setOutcomes] = useState<{ input: string; ok: boolean; reason?: string }[] | null>(null);
  const [deleting, setDeleting] = useState<AdminCdkItem | null>(null);

  const add = useAdminCdkAdd();
  const remove = useAdminCdkDelete();

  const lines = useMemo(
    () =>
      text
        .split(/\r?\n|,|，|\s+/u)
        .map((s) => s.trim())
        .filter(Boolean),
    [text],
  );

  const list = useQuery({
    queryKey: ["admin", "cdk", status, search.trim(), page],
    queryFn: () =>
      api.get<ListBody>("/api/admin/cdk", {
        status,
        ...(search.trim() ? { search: search.trim() } : {}),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });

  const data = list.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("已复制这个码");
    } catch {
      toast.error("剪贴板不可用，请手动选中复制");
    }
  };

  return (
    <div className="space-y-4">
      {/* 手动加码 */}
      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <IconPlus className="size-4" />
            手动添加码
            <span className="text-muted-foreground text-xs font-normal">
              一次最多 50 条，一行一个；不试领验证，重复的会跳过
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 font-mono text-xs"
            placeholder={"MOYU-XXXX-XXXX\nMOYU-YYYY-YYYY"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              disabled={add.isPending || lines.length === 0}
              onClick={() =>
                add.mutate(lines, {
                  onSuccess: (r) => {
                    setOutcomes(r.results);
                    const ok = r.results.filter((x) => x.ok).length;
                    if (ok) {
                      setText("");
                      toast.success(`入库 ${ok} / ${r.results.length}`);
                    } else {
                      toast.error("一条都没入库，看看下面的原因");
                    }
                  },
                })
              }
            >
              <IconPlus className="size-3.5" />
              添加到码库（{lines.length} 条）
            </Button>
            <span className="text-muted-foreground text-xs">
              共 {data?.counts.available ?? 0} 个可兑换 · {data?.counts.not_started ?? 0} 个未开始 ·{" "}
              {data?.counts.exhausted ?? 0} 个已失效
            </span>
          </div>

          {outcomes ? (
            <div className="space-y-1">
              {outcomes.map((o) => (
                <div key={o.input} className="flex items-center gap-2 text-xs">
                  {o.ok ? (
                    <IconCircleCheck className="text-[var(--status-online)] size-3.5 shrink-0" />
                  ) : (
                    <IconAlertTriangle className="text-[var(--status-warn)] size-3.5 shrink-0" />
                  )}
                  <code className="truncate font-mono">{o.input}</code>
                  {!o.ok ? <span className="text-muted-foreground">{o.reason}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 码库 */}
      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <IconGift className="size-4" />
            码库
            <span className="text-muted-foreground text-xs font-normal">共 {data?.total ?? 0} 个</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <IconSearch className="text-muted-foreground pointer-events-none absolute top-2 left-2 size-3.5" />
              <Input
                className="h-8 w-56 pl-7 text-xs"
                placeholder="搜码（忽略大小写与连字符）"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </div>
            <div className="flex items-center gap-1">
              {(["all", "available", "not_started", "exhausted"] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={status === s ? "default" : "outline"}
                  className="h-8 text-xs"
                  onClick={() => {
                    setStatus(s);
                    setPage(0);
                  }}
                >
                  {s === "all" ? "全部" : STATUS[s].text}
                </Button>
              ))}
            </div>
            {list.isFetching ? <span className="text-muted-foreground text-xs">刷新中…</span> : null}
          </div>

          {list.isPending ? <Skeleton className="h-32" /> : null}

          {list.error ? (
            <Alert variant="destructive">
              <IconAlertTriangle />
              <AlertDescription>读取码库失败：{(list.error as Error).message}</AlertDescription>
            </Alert>
          ) : null}

          {data && data.items.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-xs">当前筛选下没有码。</p>
          ) : null}

          <div className="space-y-1.5">
            {data?.items.map((item) => (
              <div key={item.id} className="bg-muted/30 space-y-1 rounded-lg px-2.5 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">{item.code}</code>
                  <Badge variant={STATUS[item.status].variant} className="shrink-0">
                    {STATUS[item.status].text}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-1.5"
                    title="复制"
                    onClick={() => void copy(item.code)}
                  >
                    <IconCopy className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive h-6 shrink-0 px-1.5"
                    title="删除"
                    onClick={() => setDeleting(item)}
                  >
                    <IconTrash className="size-3.5" />
                  </Button>
                </div>
                <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                  <span title={fmtDateTime(item.submittedAt)}>提交：{item.submitter}</span>
                  <span>{fmtRelative(item.submittedAt)}</span>
                  <span>成功兑换 {item.successCount} 次</span>
                  {item.lastRedeemedAt ? <span>最近一次 {fmtRelative(item.lastRedeemedAt)}</span> : null}
                  {item.lastError ? <span className="text-[var(--status-warn)]">{item.lastError}</span> : null}
                </div>
              </div>
            ))}
          </div>

          {data && data.total > PAGE_SIZE ? (
            <div className="flex items-center justify-between pt-1">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-xs"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <IconChevronLeft className="size-3.5" />
                上一页
              </Button>
              <span className="text-muted-foreground text-xs">
                第 {page + 1} / {totalPages} 页
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-xs"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
                <IconChevronRight className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从这个码库里删除？</AlertDialogTitle>
            <AlertDialogDescription>
              会把 <code className="font-mono">{deleting?.code}</code> 从公共码库删掉，所有人都不再能一键领取它
              （已经领过的奖励不受影响）。提交人：{deleting?.submitter}。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) remove.mutate(deleting.id);
                setDeleting(null);
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

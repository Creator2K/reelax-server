// CDK 兑换：公共码库（提交 + 一键兑换）
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconCircleCheck, IconGift, IconTrash } from "@tabler/icons-react";
import { PageContainer, EmptyState, SectionTitle } from "@/components/layout/PageContainer.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Input } from "@/components/ui/input.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useAccounts, type Account } from "@/lib/queries.ts";
import { api } from "@/lib/api.ts";

type Reward = { gold?: number; relics?: number; fragments?: number; items?: number; chests?: number; notes?: string[] };
type CdkStatus = "available" | "not_started" | "exhausted";
type CdkItem = {
  id: string;
  code: string;
  masked: boolean;
  status: CdkStatus;
  reward: Reward | null;
  mine: boolean;
  lastError: string | null;
};
type ListBody = { items: CdkItem[]; counts: Record<CdkStatus, number>; total: number };
type SubmitOutcome = { input: string; ok: boolean; status?: string; reason?: string; reward?: Reward };
type ClaimResult = { ok: boolean; reason?: string; already?: boolean; reward?: Reward };

const PAGE_SIZE = 20;

const STATUS: Record<CdkStatus, { text: string; variant: "online" | "warn" | "secondary" }> = {
  available: { text: "可兑换", variant: "online" },
  not_started: { text: "未开始", variant: "warn" },
  exhausted: { text: "已失效", variant: "secondary" },
};

function rewardText(r: Reward | null): string {
  if (!r) return "—";
  const parts = [
    r.relics ? `遗物 ${r.relics.toLocaleString("zh-CN")}` : "",
    r.fragments ? `奥秘碎片 ${r.fragments}` : "",
    r.gold ? `金币 ${r.gold.toLocaleString("zh-CN")}` : "",
    r.items ? `物品 ${r.items}` : "",
    r.chests ? `宝箱 ${r.chests}` : "",
    ...(r.notes ?? []),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

export default function CdkPage() {
  usePageHeader("CDK 兑换");
  const qc = useQueryClient();
  const { data: accounts } = useAccounts();
  const [accountId, setAccountId] = useState("");
  const [text, setText] = useState("");
  const [results, setResults] = useState<SubmitOutcome[] | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [status, setStatus] = useState<CdkStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [page, setPage] = useState(0);

  const list = useMemo(() => accounts ?? [], [accounts]);
  useEffect(() => {
    if (!accountId && list[0]) setAccountId(list[0].id);
  }, [accountId, list]);

  const lineCodes = useMemo(
    () =>
      text
        .split(/\r?\n|,|，|\s+/u)
        .map((s) => s.trim())
        .filter(Boolean),
    [text],
  );

  const library = useQuery({
    queryKey: ["cdk", "list", status, search, mineOnly, page],
    queryFn: () =>
      api.get<ListBody>("/api/cdk", {
        status,
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(mineOnly ? { mine: 1 } : {}),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ["cdk", "list"] });
  const fail = (err: unknown) => setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });

  const submit = useMutation({
    mutationFn: () => api.post<{ results: SubmitOutcome[] }>("/api/cdk/submit", { accountId, codes: lineCodes }),
    onSuccess: (r) => {
      setResults(r.results);
      const okCount = r.results.filter((x) => x.ok).length;
      setNotice({ ok: okCount > 0, text: `入库 ${okCount} / ${r.results.length}` });
      refresh();
    },
    onError: fail,
  });

  const claim = useMutation({
    mutationFn: (id: string) => api.post<ClaimResult>(`/api/cdk/${id}/claim`, { accountId }),
    onSuccess: (r) => {
      setNotice(
        r.ok
          ? { ok: true, text: `兑换成功${r.reward ? `：${rewardText(r.reward)}` : ""}` }
          : { ok: false, text: r.reason ?? "兑换失败" },
      );
      refresh();
    },
    onError: fail,
  });

  const claimAll = useMutation({
    mutationFn: () =>
      api.post<{ ok: number; already: number; removed: number; failed: number }>("/api/cdk/claim-all", { accountId }),
    onSuccess: (r) => {
      const parts = [`成功 ${r.ok}`];
      if (r.already) parts.push(`已领过 ${r.already}`);
      if (r.removed) parts.push(`已失效移除 ${r.removed}`);
      if (r.failed) parts.push(`失败 ${r.failed}`);
      setNotice({ ok: r.ok > 0, text: `一键领取完成：${parts.join(" · ")}` });
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/cdk/${id}`),
    onSuccess: refresh,
    onError: fail,
  });

  const items = library.data?.items ?? [];
  const total = library.data?.total ?? 0;
  const busy = !accountId;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <PageContainer wide>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <IconGift className="size-4" />
              提交兑换码
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="border-input bg-background h-8 rounded-md border px-2 text-[13px]"
            >
              {list.map((a: Account) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder={"一行一个，例如：\nmoyu666\nDTKF0903"}
              className="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-[13px]"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy || !lineCodes.length || submit.isPending} onClick={() => submit.mutate()}>
                {submit.isPending ? "验证中…" : `提交验证（${lineCodes.length}）`}
              </Button>
            </div>

            {notice ? (
              <Alert variant={notice.ok ? "default" : "destructive"}>
                {notice.ok ? <IconCircleCheck /> : <IconAlertTriangle />}
                <AlertDescription>{notice.text}</AlertDescription>
              </Alert>
            ) : null}

            {results?.length ? (
              <div className="space-y-1 text-xs">
                {results.map((x, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{x.input}</span>
                    <Badge variant={x.ok ? "online" : "secondary"}>{x.ok ? "已入库" : "未入库"}</Badge>
                    <span className="text-muted-foreground">{x.reason ?? rewardText(x.reward ?? null)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div>
          <SectionTitle
            action={
              <Button size="sm" disabled={busy || claimAll.isPending} onClick={() => claimAll.mutate()}>
                {claimAll.isPending ? "领取中…" : "一键领取"}
              </Button>
            }
          >
            公共码库（{total}）
          </SectionTitle>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as CdkStatus | "all");
                setPage(0);
              }}
              className="border-input bg-background h-8 rounded-md border px-2 text-[13px]"
            >
              <option value="all">全部状态</option>
              <option value="available">可兑换（{library.data?.counts.available ?? 0}）</option>
              <option value="not_started">未开始（{library.data?.counts.not_started ?? 0}）</option>
              <option value="exhausted">已失效（{library.data?.counts.exhausted ?? 0}）</option>
            </select>
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="搜索兑换码"
              className="h-8 w-52 font-mono text-[13px]"
            />
            <Button
              size="sm"
              variant={mineOnly ? "secondary" : "outline"}
              onClick={() => {
                setMineOnly((v) => !v);
                setPage(0);
              }}
            >
              只看我提交的
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                上一页
              </Button>
              <span className="text-muted-foreground text-xs">
                {page + 1} / {lastPage + 1}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= lastPage}
                onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              >
                下一页
              </Button>
            </div>
          </div>

          {items.length === 0 ? (
            <EmptyState icon={<IconGift />} title="没有匹配的兑换码" />
          ) : (
            <Card className="gap-0 overflow-hidden py-0">
              <div className="divide-border divide-y">
                {items.map((it) => (
                  <div key={it.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">{it.code}</span>
                        <Badge variant={STATUS[it.status].variant}>{STATUS[it.status].text}</Badge>
                        {it.mine ? <span className="text-muted-foreground text-[11px]">我提交的</span> : null}
                      </div>
                      <div className="text-muted-foreground mt-0.5 text-xs">
                        {rewardText(it.reward)}
                        {it.lastError ? ` · ${it.lastError}` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        disabled={busy || it.status === "exhausted" || claim.isPending}
                        onClick={() => claim.mutate(it.id)}
                      >
                        兑换
                      </Button>
                      {it.mine ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="删除"
                          onClick={() => remove.mutate(it.id)}
                          disabled={remove.isPending}
                        >
                          <IconTrash className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </PageContainer>
  );
}

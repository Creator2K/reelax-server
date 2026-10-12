// CDK 兑换：公共码库（提交 + 一键兑换）
//
// 两条规则来自实际使用：
//  · 提交前**必须**先用你的账号试领一次 —— 无效的码不入库，已领取过/未开始的入库；
//  · 码是按账号可重复领的，所以列表里任何人都能点「兑换」；谁的账号领过由游戏判定，
//    兑换时若发现码已失效，服务端会自动把它移出库。
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconCircleCheck, IconGift, IconTrash } from "@tabler/icons-react";
import { PageContainer, EmptyState, SectionTitle } from "@/components/layout/PageContainer.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useAccounts, type Account } from "@/lib/queries.ts";
import { api } from "@/lib/api.ts";
import { fmtRelative } from "@/lib/utils.ts";

type Reward = { gold?: number; relics?: number; fragments?: number; items?: number; chests?: number; notes?: string[] };
type CdkItem = {
  id: string;
  code: string;
  masked: boolean;
  status: "available" | "not_started" | "exhausted";
  reward: Reward | null;
  mine: boolean;
  successCount: number;
  lastError: string | null;
  submittedAt: number;
};
type ListBody = { items: CdkItem[]; counts: { available: number; not_started: number; exhausted: number } };
type SubmitOutcome = { input: string; ok: boolean; status?: string; reason?: string; reward?: Reward };

const STATUS: Record<CdkItem["status"], { text: string; variant: "online" | "warn" | "secondary" }> = {
  available: { text: "可兑换", variant: "online" },
  not_started: { text: "未开始", variant: "warn" },
  exhausted: { text: "已失效", variant: "secondary" },
};

function rewardText(r: Reward | null): string {
  if (!r) return "（领取后可见奖励）";
  const parts = [
    r.relics ? `遗物 ${r.relics.toLocaleString("zh-CN")}` : "",
    r.fragments ? `奥秘碎片 ${r.fragments}` : "",
    r.gold ? `金币 ${r.gold.toLocaleString("zh-CN")}` : "",
    r.items ? `物品 ${r.items}` : "",
    r.chests ? `宝箱 ${r.chests}` : "",
    ...(r.notes ?? []),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "（无奖励信息）";
}

export default function CdkPage() {
  usePageHeader("CDK 兑换", "公共码库：提交前会先用你的账号试领验证，任何人都能一键兑换");
  const qc = useQueryClient();
  const { data: accounts } = useAccounts();
  const [accountId, setAccountId] = useState("");
  const [text, setText] = useState("");
  const [results, setResults] = useState<SubmitOutcome[] | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

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
    queryKey: ["cdk", "list"],
    queryFn: () => api.get<ListBody>("/api/cdk?all=1"),
    staleTime: 15_000,
  });

  const submit = useMutation({
    mutationFn: () => api.post<{ results: SubmitOutcome[] }>("/api/cdk/submit", { accountId, codes: lineCodes }),
    onSuccess: (r) => {
      setResults(r.results);
      const okCount = r.results.filter((x) => x.ok).length;
      setNotice({ ok: okCount > 0, text: `成功入库 ${okCount} / ${r.results.length} 个` });
      void qc.invalidateQueries({ queryKey: ["cdk", "list"] });
    },
    onError: (err) => setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) }),
  });

  const claim = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; reason?: string; already?: boolean }>(`/api/cdk/${id}/claim`, { accountId }),
    onSuccess: (r) => {
      setNotice(
        r.ok
          ? { ok: true, text: r.already ? "这个码你的账号已经领过了（码仍在库里给其他人）" : "兑换成功" }
          : { ok: false, text: r.reason ?? "兑换失败" },
      );
      void qc.invalidateQueries({ queryKey: ["cdk", "list"] });
    },
    onError: (err) => setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/cdk/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["cdk", "list"] }),
  });

  const items = library.data?.items ?? [];
  const busy = !accountId;

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
            <div className="flex flex-wrap items-center gap-2">
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
              <span className="text-muted-foreground text-xs">用这个账号试领验证（不会重复领取，游戏按账号判定）</span>
            </div>
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
              <span className="text-muted-foreground text-xs">
                无效的码不会入库；已领取过 / 还没到时间的会入库（后者标记「未开始」）
              </span>
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
          <SectionTitle>
            公共码库（可兑换 {library.data?.counts.available ?? 0} · 未开始 {library.data?.counts.not_started ?? 0} ·
            已失效 {library.data?.counts.exhausted ?? 0}）
          </SectionTitle>
          {items.length === 0 ? (
            <EmptyState icon={<IconGift />} title="库里还没有码" description="在上方提交一个试试：会先用你的账号验证是否有效。" />
          ) : (
            <Card className="gap-0 overflow-hidden py-0">
              <div className="divide-border divide-y">
                {items.map((it) => (
                  <div key={it.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">{it.code}</span>
                        <Badge variant={STATUS[it.status].variant}>{STATUS[it.status].text}</Badge>
                        {it.successCount > 0 ? (
                          <span className="text-muted-foreground text-[11px]">已领 {it.successCount} 次</span>
                        ) : null}
                      </div>
                      <div className="text-muted-foreground mt-0.5 text-xs">
                        {rewardText(it.reward)}
                        {it.lastError ? ` · ${it.lastError}` : ""} · {fmtRelative(it.submittedAt)}提交
                        {it.mine ? " · 我提交的" : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        disabled={busy || it.status === "exhausted" || claim.isPending}
                        onClick={() => claim.mutate(it.id)}
                      >
                        {it.status === "not_started" ? "试试兑换" : "兑换"}
                      </Button>
                      {it.mine ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="删除我提交的码"
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

import { useEffect, useMemo, useRef, useState } from "react";
import { IconArrowDown, IconSearch } from "@tabler/icons-react";
import { PageContainer } from "@/components/layout/PageContainer.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useLiveLogs, type Account } from "@/lib/queries.ts";
import { useAccounts } from "@/lib/queries.ts";
import { cn, fmtClock } from "@/lib/utils.ts";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_CLASS: Record<Level, string> = {
  debug: "log-level-debug",
  info: "log-level-info",
  warn: "log-level-warn",
  error: "log-level-error",
};

const LEVEL_LABEL: Record<Level, string> = {
  debug: "调试",
  info: "信息",
  warn: "警告",
  error: "错误",
};

export default function LogsPage() {
  const logs = useLiveLogs();
  const { data: accounts } = useAccounts();
  const [minLevel, setMinLevel] = useState<Level>("debug");
  const [search, setSearch] = useState("");
  const [accountId, setAccountId] = useState("");
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  usePageHeader("运行日志", "实时推送，最多保留最近 1000 条（服务端另有落库副本）");

  const accountName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of (accounts ?? []) as Account[]) map.set(a.id, a.label);
    return map;
  }, [accounts]);

  const filtered = useMemo(() => {
    const minIdx = LEVELS.indexOf(minLevel);
    const needle = search.trim().toLowerCase();
    return logs.filter((e) => {
      if (LEVELS.indexOf(e.level) < minIdx) return false;
      if (accountId && e.accountId !== accountId) return false;
      if (needle) {
        const hay = `${e.tag} ${e.moduleId ?? ""} ${e.msg}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [logs, minLevel, search, accountId]);

  // 跟随模式：新日志到达时滚到底
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, follow]);

  return (
    <div className="flex h-full flex-col">
      <PageContainer wide className="shrink-0 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <IconSearch className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标签、模块或内容"
              className="h-8 pl-8 text-[13px]"
            />
          </div>

          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="border-input bg-background h-8 rounded-md border px-2 text-[13px]"
          >
            <option value="">全部账号</option>
            {(accounts ?? []).map((a: Account) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>

          <div className="flex overflow-hidden rounded-md border">
            {LEVELS.map((lv) => (
              <button
                key={lv}
                type="button"
                onClick={() => setMinLevel(lv)}
                className={cn(
                  "px-2.5 py-1 text-xs transition-colors",
                  minLevel === lv ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {LEVEL_LABEL[lv]}
              </button>
            ))}
          </div>

          <Button
            variant={follow ? "secondary" : "outline"}
            size="sm"
            onClick={() => setFollow((v) => !v)}
            title="开启后自动滚动到最新"
          >
            <IconArrowDown className="size-3.5" />
            {follow ? "跟随中" : "已暂停"}
          </Button>
        </div>
      </PageContainer>

      <div className="min-h-0 flex-1 px-6 pb-6">
        <div
          ref={scrollRef}
          onWheel={() => setFollow(false)}
          className="border-border bg-card scroll-slim h-full overflow-y-auto rounded-xl border font-mono text-[12px] leading-relaxed"
        >
          {filtered.length === 0 ? (
            <div className="text-muted-foreground p-4">
              {logs.length === 0 ? "暂无日志。引擎启动后这里会实时显示。" : "没有匹配当前筛选条件的日志。"}
            </div>
          ) : (
            <ul className="divide-border divide-y">
              {filtered.map((e, i) => {
                const who = [e.moduleId, e.accountId ? accountName.get(e.accountId) : null].filter(Boolean).join(" ");
                return (
                  <li key={`${e.t}-${i}`} className="flex gap-3 px-3 py-1.5">
                    <span className="text-muted-foreground shrink-0 tabular-nums">{fmtClock(e.t)}</span>
                    <span className={cn("w-8 shrink-0", LEVEL_CLASS[e.level])}>{LEVEL_LABEL[e.level]}</span>
                    <span className="text-muted-foreground w-28 shrink-0 truncate" title={who}>
                      {who || "—"}
                    </span>
                    <span className="text-muted-foreground w-16 shrink-0 truncate" title={e.tag}>
                      {e.tag}
                    </span>
                    <span className={cn("min-w-0 flex-1 break-words whitespace-pre-wrap", LEVEL_CLASS[e.level])}>
                      {e.msg}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

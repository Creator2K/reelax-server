import { useEffect, useMemo, useRef, useState } from "react";
import { IconArrowDown, IconSearch, IconTrash } from "@tabler/icons-react";
import { PageContainer } from "@/components/layout/PageContainer.tsx";
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
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { LogRows, LEVEL_LABEL, type LogLevel, type LogRow } from "@/components/domain/LogRows.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useLiveLogs, type Account } from "@/lib/queries.ts";
import { useAccounts } from "@/lib/queries.ts";
import { useRealtime, type LogEntry } from "@/lib/realtime.tsx";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/utils.ts";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export default function LogsPage() {
  const logs = useLiveLogs();
  const { logStore } = useRealtime();
  const { data: accounts } = useAccounts();
  const [minLevel, setMinLevel] = useState<LogLevel>("debug");
  const [search, setSearch] = useState("");
  const [accountId, setAccountId] = useState("");
  const [follow, setFollow] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);

  usePageHeader("运行日志", "实时推送，最新在最上面");

  /**
   * ★ 刷新后回填：以前刷新一下就空白了（日志只存在浏览器内存里，全靠 WebSocket 现推）。
   *
   * 走**数据库历史**而不是内存缓冲：内存缓冲是全局 5000 条（多个账号一起写，开久了
   * 只剩最近几分钟），而数据库里每个用户保留 2 万条，能稳定给满 1000 条。
   */
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    let cancelled = false;
    void api
      .get<LogEntry[]>("/api/logs", { history: 1, limit: 1000 })
      .then((list) => {
        if (!cancelled && Array.isArray(list)) logStore.seed(list);
      })
      .catch(() => {
        /* 回填失败不影响实时流 */
      });
    return () => {
      cancelled = true;
    };
  }, [logStore]);

  const accountName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of (accounts ?? []) as Account[]) map.set(a.id, a.label);
    return map;
  }, [accounts]);

  /**
   * 过滤 + **最新在最上面**。
   *
   * 为什么要反过来：日志是持续追加的，旧顺序（旧→新）每次都得手动拉到最下面才看得到最新，
   * 手机尤其难受。列表内部仍然按时间升序保存（`LogStore` 的语义），只在渲染前反一次。
   */
  const rows = useMemo<LogRow[]>(() => {
    const minIdx = LEVELS.indexOf(minLevel);
    const needle = search.trim().toLowerCase();
    const out: LogRow[] = [];
    for (let i = logs.length - 1; i >= 0; i--) {
      const e = logs[i]!;
      if (LEVELS.indexOf(e.level) < minIdx) continue;
      if (accountId && e.accountId !== accountId) continue;
      if (needle) {
        const hay = `${e.tag} ${e.moduleId ?? ""} ${e.msg}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const who = [e.moduleId, e.accountId ? accountName.get(e.accountId) : null].filter(Boolean).join(" ");
      out.push({ key: `${e.t}-${i}`, t: e.t, level: e.level, who: who || null, tag: e.tag, msg: e.msg });
    }
    return out;
  }, [logs, minLevel, search, accountId, accountName]);

  // 跟随模式：最新在最上面，所以新日志到达时滚到**顶部**
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [rows.length, follow]);

  /** 清除当前保留的日志：服务端删自己的（内存 + 库），前端同时清空缓冲 */
  const clearLogs = async () => {
    setClearing(true);
    try {
      await api.del<{ removed: number; forgotten: number }>("/api/logs");
      logStore.clear();
      setConfirmClear(false);
    } finally {
      setClearing(false);
    }
  };

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
            title="开启后自动滚到最新"
          >
            <IconArrowDown className="size-3.5" />
            {follow ? "跟随中" : "已暂停"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmClear(true)}
            disabled={logs.length === 0}
            title="清除已保留的日志（只清自己的）"
          >
            <IconTrash className="size-3.5" />
            清除
          </Button>
        </div>
      </PageContainer>

      <div className="min-h-0 flex-1 px-6 pb-6">
        <div
          ref={scrollRef}
          onWheel={() => setFollow(false)}
          className="border-border bg-card scroll-slim h-full overflow-y-auto rounded-xl border font-mono text-[12px] leading-relaxed"
        >
          {rows.length === 0 ? (
            <div className="text-muted-foreground p-4">
              {logs.length === 0 ? "暂无日志。引擎启动后这里会实时显示。" : "没有匹配当前筛选条件的日志。"}
            </div>
          ) : (
            <LogRows rows={rows} />
          )}
        </div>
      </div>

      <AlertDialog open={confirmClear} onOpenChange={(o) => !o && setConfirmClear(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清除运行日志？</AlertDialogTitle>
            <AlertDialogDescription>
              会删除「你自己的」已保留日志（内存与数据库都清），别人的日志不受影响，
              服务启动那类系统级日志也会保留。清空后无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void clearLogs()} disabled={clearing}>
              {clearing ? "清除中…" : "确认清除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

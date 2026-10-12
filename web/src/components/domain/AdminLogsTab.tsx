// 后台「运行日志」页签：看**所有人**的日志（跨用户），用于排查用户反馈的问题
//
// 两个关键点：
//  1) **脱敏**：服务端返回前就把密码 / token / cookie / 签名 / 邮箱遮掉了
//     （`lib/log-redact.ts`）；IP、host:port、模块与地图 id、错误原文保留 —— 排查要用。
//  2) 与用户页的日志页不同，这里**不订阅 WebSocket**（那是按 userId 过滤的），
//     而是按固定节奏轮询 `/api/admin/logs`：管理员要看的是"此刻库里的全量"。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconSearch } from "@tabler/icons-react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { LogRows, LEVEL_LABEL, type LogLevel, type LogRow } from "@/components/domain/LogRows.tsx";
import { api } from "@/lib/api.ts";
import type { SessionUser } from "@/lib/session.ts";
import { cn } from "@/lib/utils.ts";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const PAGE_SIZE = 200;

type AdminLogsResponse = {
  entries: {
    t: number;
    level: LogLevel;
    userId: string | null;
    accountId: string | null;
    moduleId: string | null;
    tag: string;
    msg: string;
  }[];
  totalInDb: number;
};

export function AdminLogsTab() {
  const [userId, setUserId] = useState("");
  const [minLevel, setMinLevel] = useState<LogLevel>("debug");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.get<{ users: SessionUser[] }>("/api/admin/users?limit=200"),
  });

  const logs = useQuery({
    queryKey: ["admin", "logs", userId, minLevel, search, limit],
    queryFn: () =>
      api.get<AdminLogsResponse>("/api/admin/logs", {
        ...(userId ? { userId } : {}),
        ...(minLevel !== "debug" ? { level: minLevel } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
        limit,
      }),
    // 管理员看的是"此刻库里的全量"，用轮询而不是 WebSocket
    refetchInterval: autoRefresh ? 3000 : false,
  });

  const userLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users.data?.users ?? []) map.set(u.id, u.displayName || u.email);
    return map;
  }, [users.data]);

  const rows = useMemo<LogRow[]>(
    () =>
      (logs.data?.entries ?? []).map((e, i) => {
        const who = [
          e.moduleId,
          e.userId ? userLabel.get(e.userId) ?? e.userId.slice(0, 8) : "系统",
          e.accountId ? e.accountId.slice(0, 6) : null,
        ]
          .filter(Boolean)
          .join(" ");
        return { key: `${e.t}-${i}`, t: e.t, level: e.level, who, tag: e.tag, msg: e.msg };
      }),
    [logs.data, userLabel],
  );

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">
            运行日志
            <span className="text-muted-foreground ml-2 text-xs font-normal">
              全部用户 · 已脱敏 · 共 {logs.data?.totalInDb ?? 0} 条
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant={autoRefresh ? "secondary" : "outline"}
              size="sm"
              onClick={() => setAutoRefresh((v) => !v)}
              title="每 3 秒自动刷新"
            >
              {autoRefresh ? "自动刷新中" : "已暂停刷新"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void logs.refetch()} disabled={logs.isFetching}>
              {logs.isFetching ? "刷新中…" : "立即刷新"}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <IconSearch className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标签、模块或内容（服务端过滤）"
              className="h-8 pl-8 text-[13px]"
            />
          </div>

          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="border-input bg-background h-8 rounded-md border px-2 text-[13px]"
          >
            <option value="">全部用户</option>
            {(users.data?.users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName || u.email}
              </option>
            ))}
          </select>

          <select
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="border-input bg-background h-8 rounded-md border px-2 text-[13px]"
            title="显示条数"
          >
            {[100, 200, 500, 1000].map((n) => (
              <option key={n} value={n}>
                最近 {n} 条
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
        </div>
      </CardHeader>

      <CardContent>
        {logs.isError ? (
          <div className="text-muted-foreground py-6 text-center text-sm">
            读取失败：{logs.error instanceof Error ? logs.error.message : "未知错误"}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground py-6 text-center text-sm">
            {logs.isLoading ? "加载中…" : "没有匹配的日志。"}
          </div>
        ) : (
          <div className="border-border max-h-[60vh] overflow-y-auto rounded-xl border font-mono text-[12px] leading-relaxed">
            <LogRows rows={rows} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

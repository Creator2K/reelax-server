// 在线更新面板：检查 → 更新 → 进度 → 完成提示刷新
//
// 为什么单独成文件（原来内嵌在 Admin.tsx 里）：
// 更新是**长流程**（重建镜像通常 1~2 分钟），期间服务会重启，
// 需要轮询进度 + 探活 + 在服务回来后提示刷新，逻辑量已经不适合塞在页面里。
//
// 关键设计：
//  · 进度轮询在 running 时 1.5s 一次，结束后自动停（不打扰服务端）
//  · 更新期间请求失败是**预期内**的（容器正在重启），不弹错
//  · 成功信号用 /api/health 探活 —— 只有服务真的回来了才提示「刷新页面」，
//    而不是拿 updater 的日志当成功依据（那时 app 可能还没起来）
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  IconAlertTriangle,
  IconCheck,
  IconDownload,
  IconLoader2,
  IconRefresh,
  IconRocket,
  IconSearch,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { ProgressBar } from "@/components/domain/StatCard.tsx";
import { useApplyUpdate, useCheckUpdate, useUpdateProgress, probeHealth, type UpdateStep } from "@/lib/mutations.ts";

/** 更新流程的步骤顺序（用于把「进行到第几步」画成进度条） */
const STEP_ORDER: UpdateStep[] = ["preflight", "git-pull", "install", "build", "recreate", "done"];
const STEP_TEXT: Record<UpdateStep, string> = {
  idle: "等待开始",
  preflight: "检查环境",
  "git-pull": "拉取最新代码",
  install: "安装依赖",
  build: "构建前端",
  recreate: "重建并重启容器",
  done: "更新完成",
  failed: "更新失败",
};

export function UpdatePanel() {
  const check = useCheckUpdate();
  const apply = useApplyUpdate();

  // 点了更新之后开始盯进度；也可以在挂载时自动拉一次（页面上可能已有更新在进行）
  const [watching, setWatching] = useState(false);
  const progress = useUpdateProgress(watching);

  /** 服务探活结果：「已重启归来」才是真正的完成信号 */
  const [backOnline, setBackOnline] = useState(false);
  const [waitedSec, setWaitedSec] = useState(0);
  const pollRef = useRef<number | null>(null);

  const r = check.data;
  const p = progress.data;
  const running = Boolean(p?.running) || (watching && !backOnline && apply.isSuccess);

  /* ---- 触发更新 ---- */
  const startUpdate = () => {
    setBackOnline(false);
    setWaitedSec(0);
    setWatching(true);
    apply.mutate();
  };

  /* ---- 更新期间：轮询探活，等服务回来 ---- */
  useEffect(() => {
    if (!watching || backOnline) return;
    // 只在「已经点过更新」或「观察到正在更新」时才探活，避免无谓请求
    if (!apply.isSuccess && !p?.running) return;

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const ok = await probeHealth();
      if (cancelled) return;
      if (ok) {
        setBackOnline(true);
        return;
      }
      setWaitedSec((s) => s + 2);
    };
    // 容器重建至少要几十秒，先等 8 秒再开始探，省掉一轮必然失败的请求
    const first = window.setTimeout(tick, 8000);
    pollRef.current = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [watching, backOnline, apply.isSuccess, p?.running]);

  /** 进度百分比：按步骤位置估算（无法拿到真实百分比，但足够传达「在动」） */
  const stepIdx = p ? STEP_ORDER.indexOf(p.step) : -1;
  const pct = p?.step === "done" ? 100 : stepIdx >= 0 ? Math.round(((stepIdx + 0.5) / (STEP_ORDER.length - 1)) * 100) : 5;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <IconRefresh className="size-4" />
          在线更新
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => check.mutate()} disabled={check.isPending || running}>
            <IconSearch className="size-3.5" />
            {check.isPending ? "检查中…" : "检查更新"}
          </Button>
          {r?.hasUpdate ? (
            <Button
              size="sm"
              onClick={startUpdate}
              disabled={apply.isPending || running || (!r.updaterAvailable && !r.canApplyLocal)}
            >
              {running ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconDownload className="size-3.5" />}
              {running ? "更新中…" : "立即更新"}
            </Button>
          ) : null}
        </div>

        {!r && !check.isPending ? (
          <p className="text-muted-foreground text-xs">点「检查更新」对比当前提交与 GitHub 上的最新提交。</p>
        ) : null}

        {/* ---------- 版本对比 ---------- */}
        {r ? (
          <div className="space-y-3 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="bg-muted/40 rounded-xl border px-3 py-2">
                <div className="text-muted-foreground">当前版本</div>
                <div className="mono-num font-medium">{r.current ? r.current.short : "读不到（非 git 工作区）"}</div>
                {r.current?.message ? (
                  <div className="truncate text-[11px]" title={r.current.message}>
                    {r.current.message}
                  </div>
                ) : null}
              </div>
              <div className="bg-muted/40 rounded-xl border px-3 py-2">
                <div className="text-muted-foreground">GitHub 最新</div>
                <div className="mono-num font-medium">{r.latest ? r.latest.short : "读不到"}</div>
                {r.latest?.message ? (
                  <div className="truncate text-[11px]" title={r.latest.message}>
                    {r.latest.message}
                  </div>
                ) : null}
              </div>
            </div>

            {r.hasUpdate ? (
              <Alert variant="warn">
                <IconAlertTriangle />
                <AlertDescription>
                  有新版本{r.behindBy ? `（落后 ${r.behindBy} 个提交）` : ""}。
                  {r.updaterAvailable
                    ? " 更新会拉取代码并重建容器，服务约 1~2 分钟后重启。"
                    : r.canApplyLocal
                      ? " 更新会拉取代码并重建前端，之后需要重启进程。"
                      : " 当前部署未开启自动更新，请看下方命令。"}
                </AlertDescription>
              </Alert>
            ) : (
              <Badge variant="online" className="gap-1">
                <IconCheck className="size-3" />
                已是最新
              </Badge>
            )}

            {r.note ? <div className="text-muted-foreground">{r.note}</div> : null}

            <div className="text-muted-foreground space-y-1">
              <div>
                旁路更新器：{r.updaterAvailable ? "在线可用" : "未启用"}
                {!r.updaterAvailable ? "（docker compose --profile update up -d 可开启）" : ""}
              </div>
              <div>容器内直接 pull：{r.canApplyLocal ? "允许" : "不允许（Docker 部署下正常）"}</div>
            </div>

            {r.manualHint ? (
              <pre className="bg-muted/40 scroll-slim overflow-x-auto rounded-xl border px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
                {r.manualHint}
              </pre>
            ) : null}
          </div>
        ) : null}

        {/* ---------- 进度 ---------- */}
        <AnimatePresence>
          {watching && (running || backOnline || p?.step === "failed" || p?.step === "done") ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ type: "spring", stiffness: 260, damping: 26 }}
              className="space-y-3 rounded-2xl border px-3.5 py-3"
            >
              {/* 服务重启归来 → 让用户刷新 */}
              {backOnline ? (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="grid size-6 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                      <IconRocket className="size-3.5" />
                    </span>
                    更新完成，服务已重启
                  </div>
                  <p className="text-muted-foreground text-xs">
                    当前页面还是旧版本的前端资源，**请刷新页面**加载新版界面。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => window.location.reload()}>
                      <IconRefresh className="size-3.5" />
                      立即刷新页面
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => check.mutate()}>
                      刷新后再检查一次
                    </Button>
                  </div>
                </div>
              ) : p?.step === "failed" ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-[var(--status-error)]">
                    <IconAlertTriangle className="size-4" />
                    更新失败
                  </div>
                  {p.error ? <div className="text-muted-foreground text-xs">{p.error}</div> : null}
                  <p className="text-muted-foreground text-xs">
                    旧的容器仍在运行，服务没有中断。修复原因后可再次点「立即更新」。
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2 font-medium">
                      <IconLoader2 className="size-3.5 animate-spin" />
                      {STEP_TEXT[p?.step ?? "preflight"]}
                    </span>
                    <span className="mono-num text-muted-foreground">
                      已等待 {waitedSec}s
                      {p?.before && p?.after ? ` · ${p.before.slice(0, 7)} → ${p.after.slice(0, 7)}` : ""}
                    </span>
                  </div>

                  <ProgressBar value={pct} max={100} tone="info" showSheen />

                  {/* 步骤清单 */}
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-3">
                    {STEP_ORDER.filter((s) => s !== "done").map((s) => {
                      const idx = STEP_ORDER.indexOf(s);
                      const state = stepIdx > idx ? "done" : stepIdx === idx ? "active" : "pending";
                      return (
                        <div
                          key={s}
                          className={[
                            "flex items-center gap-1.5",
                            state === "done"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : state === "active"
                                ? "text-foreground"
                                : "text-muted-foreground/60",
                          ].join(" ")}
                        >
                          {state === "done" ? (
                            <IconCheck className="size-3 shrink-0" />
                          ) : state === "active" ? (
                            <IconLoader2 className="size-3 shrink-0 animate-spin" />
                          ) : (
                            <span className="size-3 shrink-0 rounded-full border" />
                          )}
                          {STEP_TEXT[s]}
                        </div>
                      );
                    })}
                  </div>

                  <p className="text-muted-foreground text-xs">
                    重建镜像期间服务会短暂不可用，这是正常现象；页面会自动等它回来。
                  </p>
                </>
              )}

              {/* 输出尾巴 */}
              {p?.tail?.length ? (
                <details className="text-xs">
                  <summary className="text-muted-foreground cursor-pointer">更新输出（最近 {p.tail.length} 行）</summary>
                  <pre className="scroll-slim bg-muted/40 mt-2 max-h-56 overflow-auto rounded-xl border px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
                    {p.tail.join("\n")}
                  </pre>
                </details>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* 旧的请求级输出（本地更新模式下 apply 会直接返回日志） */}
        {!watching && apply.data?.log ? (
          <details className="text-xs">
            <summary className="text-muted-foreground cursor-pointer">更新输出</summary>
            <pre className="scroll-slim bg-muted/40 mt-2 max-h-64 overflow-auto rounded-xl border px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
              {apply.data.log}
            </pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

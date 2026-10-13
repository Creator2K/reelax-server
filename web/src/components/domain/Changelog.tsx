// 更新记录：当前版本 + 每个版本更新了什么
//
// 设计取舍：
//  · 数据来自服务端（/api/auth/changelog），和代码一起发版 —— 只有一个真相，不用前端手工同步
//  · 登录前也能看（登录页底部的版本号点开就是它），所以接口是公开的
//  · 只写用户能感知的变化，不写内部重构（那些看 git log）
//  · 版本多了以后整页拉不完，所以默认只展开最近几版，其余按「加载更多」逐批出
import { useState } from "react";
import { motion } from "motion/react";
import { IconAlertTriangle, IconBulb, IconRefresh, IconSparkles, IconTag, IconTools } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { useChangelog, type ChangeKind } from "@/lib/queries.ts";
import { fmtRelative } from "@/lib/utils.ts";

const KIND_META: Record<ChangeKind, { label: string; icon: React.ReactNode; badge: string }> = {
  feature: {
    label: "新增",
    icon: <IconSparkles className="size-3.5" />,
    badge: "border-transparent bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  },
  improve: {
    label: "优化",
    icon: <IconBulb className="size-3.5" />,
    badge: "border-transparent bg-blue-500/12 text-blue-600 dark:text-blue-400",
  },
  fix: {
    label: "修复",
    icon: <IconTools className="size-3.5" />,
    badge: "border-transparent bg-amber-500/14 text-amber-600 dark:text-amber-400",
  },
};

/**
 * 版本卡片列表。
 *
 * `initial` = 默认展开几个版本（关于页用 2 个），其余点「加载更多」每次多出 `step` 个。
 * 全部展开后按钮消失 —— 不做「收起」，避免误点后又要重新拉一遍。
 */
export function ChangelogList({ initial = 2, step = 5 }: { initial?: number; step?: number }) {
  const { data, isPending, error } = useChangelog();
  const [visible, setVisible] = useState(initial);

  if (isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <IconAlertTriangle />
        <AlertDescription>读取更新记录失败：{(error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const all = data?.entries ?? [];
  const entries = all.slice(0, Math.max(1, visible));
  const remaining = all.length - entries.length;

  return (
    <div className="space-y-4">
      {entries.map((entry, idx) => (
        <motion.div
          key={entry.version}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: Math.min(idx, 3) * 0.06 }}
        >
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex items-center gap-1.5">
                  <IconTag className="size-4" />
                  v{entry.version}
                </span>
                {idx === 0 ? <Badge variant="online">当前版本</Badge> : null}
                <span className="text-muted-foreground text-xs font-normal">{entry.date}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm font-medium">{entry.title}</p>

              {entry.notice ? (
                <Alert variant="warn">
                  <AlertDescription>{entry.notice}</AlertDescription>
                </Alert>
              ) : null}

              <ul className="space-y-1.5">
                {entry.changes.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs leading-relaxed">
                    <span
                      className={`mt-[1px] inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${KIND_META[c.kind].badge}`}
                    >
                      {KIND_META[c.kind].icon}
                      {KIND_META[c.kind].label}
                    </span>
                    <span className="text-muted-foreground">{c.text}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </motion.div>
      ))}

      {remaining > 0 ? (
        <Button variant="outline" className="w-full" onClick={() => setVisible((v) => v + step)}>
          <IconRefresh className="size-3.5" />
          加载更多（还有 {remaining} 个版本）
        </Button>
      ) : null}
    </div>
  );
}

/** 一行式版本号（放在页脚/设置页顶部） */
export function VersionLine() {
  const { data } = useChangelog();
  if (!data) return null;
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
      <IconTag className="size-3.5" />
      版本 v{data.version}
      <span className="opacity-70">· {fmtRelative(Date.parse(data.latest.date))}更新</span>
    </span>
  );
}

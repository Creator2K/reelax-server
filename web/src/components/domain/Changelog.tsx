// 更新记录：当前版本 + 每个版本更新了什么
//
// 设计取舍：
//  · 数据来自服务端（/api/auth/changelog），和代码一起发版 —— 只有一个真相，不用前端手工同步
//  · 登录前也能看（登录页底部有入口），所以接口是公开的
//  · 只写用户能感知的变化，不写内部重构（那些看 git log）
import { motion } from "motion/react";
import { IconAlertTriangle, IconBulb, IconSparkles, IconTag, IconTools } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge.tsx";
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

/** 版本卡片列表。`limit` 用于在设置页只显示最近几条。 */
export function ChangelogList({ limit }: { limit?: number }) {
  const { data, isPending, error } = useChangelog();

  if (isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-40" />
        {!limit ? <Skeleton className="h-40" /> : null}
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

  const entries = limit ? (data?.entries ?? []).slice(0, limit) : (data?.entries ?? []);

  return (
    <div className="space-y-4">
      {entries.map((entry, idx) => (
        <motion.div
          key={entry.version}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: idx * 0.06 }}
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

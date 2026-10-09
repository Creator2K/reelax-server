// 后台设置：可在线修改、立即生效、写入数据库
//
// 为什么不做成「改环境变量 + 重启」：这些值运维时经常临时调（开一段注册、
// 给用户放宽额度），重启一次要断掉所有正在挂机的账号。
//
// 环境变量只提供**初始值**：界面上会标出「与初始值不同」的项，方便知道改过什么。
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { IconAlertTriangle, IconDeviceFloppy, IconInfoCircle, IconRotate } from "@tabler/icons-react";
import { Button } from "@/components/ui/button.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { api } from "@/lib/api.ts";
import { UpdatePanel } from "@/components/domain/UpdatePanel.tsx";
import { SETTINGS_QUERY_KEY, useSaveSettings, type SettingItem } from "@/lib/mutations.ts";

export function AdminSettingsTab() {
  const { data, isPending, error } = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => api.get<{ items: SettingItem[] }>("/api/admin/settings"),
  });
  const save = useSaveSettings();
  /** 本地草稿：改动先攒着，点保存才提交（避免开关一动就发请求） */
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  if (isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <IconAlertTriangle />
        <AlertDescription>读取设置失败：{(error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const items = data?.items ?? [];
  const valueOf = (it: SettingItem) => (it.key in draft ? draft[it.key] : it.value);
  const isDirty = (it: SettingItem) => it.key in draft && draft[it.key] !== it.value;
  const dirtyCount = items.filter(isDirty).length;

  const setValue = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }));

  const submit = async () => {
    const patch: Record<string, unknown> = {};
    for (const it of items) if (isDirty(it)) patch[it.key] = draft[it.key];
    if (!Object.keys(patch).length) return;
    await save.mutateAsync(patch);
    setDraft({});
  };

  return (
    <div className="space-y-4">
      <Alert variant="info">
        <IconInfoCircle />
        <AlertDescription>
          在这里改动会立即生效，不需要重启服务。标了「已改动」的项表示与部署时的初始值不同。
        </AlertDescription>
      </Alert>

      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((it, i) => (
          <motion.div
            key={it.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, delay: i * 0.03 }}
          >
            <Card className="gap-2 py-4">
              <CardHeader className="px-4">
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                  {it.label}
                  {it.overridden ? <Badge variant="warn">已改动</Badge> : null}
                  {isDirty(it) ? <Badge variant="secondary">未保存</Badge> : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 px-4">
                <p className="text-muted-foreground text-xs leading-relaxed">{it.hint}</p>

                {it.type === "boolean" ? (
                  <div className="flex items-center justify-between">
                    <span className="text-xs">{valueOf(it) ? "已开启" : "已关闭"}</span>
                    <Switch
                      checked={Boolean(valueOf(it))}
                      onCheckedChange={(c) => setValue(it.key, c)}
                      aria-label={it.label}
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <Input
                      type="number"
                      className="w-28"
                      value={String(valueOf(it) ?? "")}
                      onChange={(e) => setValue(it.key, e.target.value === "" ? "" : Number(e.target.value))}
                      min={1}
                      aria-label={it.label}
                    />
                    {it.overridden ? (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]"
                        onClick={() => setValue(it.key, it.envValue)}
                        title={`恢复为部署时的初始值：${String(it.envValue)}`}
                      >
                        <IconRotate className="size-3" />
                        恢复初始值 {String(it.envValue)}
                      </button>
                    ) : (
                      <span className="text-muted-foreground text-[11px]">初始值 {String(it.envValue)}</span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* 保存条：有改动才出现，避免误以为改了没生效 */}
      {dirtyCount > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-card sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-2xl border px-4 py-3"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          <span className="text-xs">
            有 <strong>{dirtyCount}</strong> 项改动尚未保存
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setDraft({})}>
              放弃
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
              <IconDeviceFloppy className="size-3.5" />
              {save.isPending ? "保存中…" : "保存并生效"}
            </Button>
          </div>
        </motion.div>
      ) : null}

      <p className="text-muted-foreground text-xs">
        这些设置存在数据库里，改完立即生效、重启也不会丢。没被改过的项在重启后仍跟随环境变量。
      </p>

      {/* 在线更新放在这里：它本质也是「运维设置」，不该单独占一个页签 */}
      <div className="pt-2">
        <UpdatePanel />
      </div>
    </div>
  );
}

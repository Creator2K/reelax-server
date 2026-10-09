// 模块配置预览：实时把「当前配置会产出什么」渲染出来
//
// 用途：日报这类配置光看勾选项想象不出最终消息长什么样。
// 输入变化后防抖 400ms 请求服务端预览，避免每敲一个字符打一次接口。
import { useEffect, useMemo, useRef, useState } from "react";
import { IconEye } from "@tabler/icons-react";
import { api } from "@/lib/api.ts";
import { Card } from "@/components/ui/card.tsx";

export function ModulePreview({ moduleId, values }: { moduleId: string; values: Record<string, unknown> }) {
  const [preview, setPreview] = useState<string[] | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // 只在配置真的变化时重算（序列化后比较，避免每次父组件重渲染都请求）
  const valuesKey = useMemo(() => JSON.stringify(values), [values]);

  useEffect(() => {
    const mySeq = ++seq.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.post<{ preview: string | string[] | null; supported: boolean }>(
          `/api/modules/${moduleId}/preview`,
          JSON.parse(valuesKey) as Record<string, unknown>,
        );
        // 丢弃过期响应（用户可能已经继续改了）
        if (mySeq !== seq.current) return;
        setSupported(res.supported);
        setPreview(Array.isArray(res.preview) ? res.preview : res.preview ? [res.preview] : null);
      } catch {
        if (mySeq === seq.current) setPreview(null);
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [moduleId, valuesKey]);

  // 该模块不支持预览：不占位置
  if (supported === false) return null;
  if (!preview || preview.length === 0) {
    return loading ? (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <IconEye className="size-3.5" />
        正在生成预览…
      </p>
    ) : null;
  }

  return (
    <Card className="bg-muted/40 gap-2 py-3">
      <div className="flex items-center gap-1.5 px-3">
        <IconEye className="text-muted-foreground size-3.5" />
        <span className="text-muted-foreground text-xs">
          预览（示例数据）{loading ? " · 更新中…" : ""}
        </span>
      </div>
      <pre className="scroll-slim max-h-56 overflow-auto px-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {preview.join("\n")}
      </pre>
    </Card>
  );
}

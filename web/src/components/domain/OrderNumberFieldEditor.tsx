// 「有序 + 带数值」字段编辑器
//
// 用途：自动加点的四项属性 —— 既要排「先加谁」，又要写「目标值 / 配比权重」。
// 旧版是 `0:2000:0:100` 这种**按固定位置解释**的字符串：顺序写死在代码里
// （力量:智力:运气:耐力），用户既改不了顺序，写错顺序也不会报错。
// 这里把顺序变成可拖动的行，数值就是行里的输入框，语义一目了然。
//
// 清单里的候选项**一定都在**（服务端会补齐），所以没有「加入 / 移除」，只有调序 + 改数值。
import { useState } from "react";
import { IconChevronDown, IconChevronUp, IconGripVertical } from "@tabler/icons-react";
import type { ConfigField } from "@/lib/queries.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { cn } from "@/lib/utils.ts";

type OrderNumberFieldType = Extract<ConfigField, { type: "order-number" }>;

type Item = { key: string; value: number };

export function OrderNumberFieldEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: OrderNumberFieldType;
  value: unknown;
  disabled?: boolean;
  onChange: (v: Item[]) => void;
}) {
  const allowed = field.options.map((o) => o.value);
  const raw = Array.isArray(value) ? (value as Item[]) : [];
  const picked: Item[] = [];
  for (const item of raw) {
    const key = String(item?.key ?? "");
    if (!allowed.includes(key) || picked.some((x) => x.key === key)) continue;
    picked.push({ key, value: Number(item?.value) || 0 });
  }
  // 服务端会补齐缺失项，这里也兜一层（避免界面少一行就再也加不回来）
  for (const key of allowed) if (!picked.some((x) => x.key === key)) picked.push({ key, value: 0 });

  const metaOf = (key: string) => field.options.find((o) => o.value === key);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= picked.length || from === to) return;
    const next = [...picked];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };

  const setValue = (key: string, v: number) => {
    onChange(picked.map((x) => (x.key === key ? { ...x, value: v } : x)));
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-[13px]">{field.label}</Label>
        {field.hint ? (
          <p className="text-muted-foreground text-xs leading-snug whitespace-pre-line">{field.hint}</p>
        ) : null}
      </div>

      <div className="divide-border divide-y overflow-hidden rounded-lg border">
        {picked.map((item, i) => {
          const meta = metaOf(item.key);
          return (
            <div
              key={item.key}
              draggable={!disabled}
              onDragStart={() => setDragFrom(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom !== null) move(dragFrom, i);
                setDragFrom(null);
              }}
              onDragEnd={() => setDragFrom(null)}
              className={cn(
                "flex items-center gap-2 px-3 py-2",
                !disabled && "cursor-grab active:cursor-grabbing",
                dragFrom === i && "bg-accent/40",
              )}
            >
              <IconGripVertical className="text-muted-foreground size-3.5 shrink-0 opacity-60" />
              <span className="mono-num text-muted-foreground w-3 shrink-0 text-center text-xs">{i + 1}</span>
              <span className="min-w-0 flex-1 text-xs font-medium">{meta?.label ?? item.key}</span>
              <Input
                type="number"
                inputMode="numeric"
                value={String(item.value)}
                min={field.min}
                max={field.max}
                step={field.step}
                disabled={disabled}
                onChange={(e) => setValue(item.key, e.target.value === "" ? 0 : Number(e.target.value))}
                className="h-7 w-28 shrink-0 text-right text-xs"
              />
              {field.unit ? <span className="text-muted-foreground shrink-0 text-[11px]">{field.unit}</span> : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="size-6 shrink-0 px-0"
                title="上移"
                disabled={disabled || i === 0}
                onClick={() => move(i, i - 1)}
              >
                <IconChevronUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="size-6 shrink-0 px-0"
                title="下移"
                disabled={disabled || i === picked.length - 1}
                onClick={() => move(i, i + 1)}
              >
                <IconChevronDown className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

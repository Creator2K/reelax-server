// 有序列表字段编辑器
//
// ★ 为什么需要它：像「换图优先级」这种配置的候选项会越来越多。
//   用 select 就得把**每一种排列**都当成一个选项：3 项 6 条、4 项 24 条、5 项 120 条……
//   下拉框里全是「A > B > C」「A > C > B」，用户只能挑花眼，加一项还会更难用。
//   改成「点候选加入 + 拖动 / ↑↓ 调序」的列表后：候选项再多也只是多一行按钮，
//   而且顺序本身一眼可见（顺序就是这个配置的含义）。
//
// 与 multi-select 的区别只有一点：**顺序保留**（multi-select 会按定义顺序重排）。
import { useState } from "react";
import { IconChevronDown, IconChevronUp, IconGripVertical, IconPlus, IconX } from "@tabler/icons-react";
import type { ConfigField } from "@/lib/queries.ts";
import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { cn } from "@/lib/utils.ts";

type OrderFieldType = Extract<ConfigField, { type: "order" }>;

export function OrderFieldEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: OrderFieldType;
  value: unknown;
  disabled?: boolean;
  onChange: (v: string[]) => void;
}) {
  const allowed = field.options.map((o) => o.value);
  const raw = Array.isArray(value) ? value.map((x) => String(x)) : [];
  const picked = raw.filter((v) => allowed.includes(v));
  const rest = field.options.filter((o) => !picked.includes(o.value));
  const min = field.min ?? 1;
  const metaOf = (id: string) => field.options.find((o) => o.value === id);

  /** 拖动中的源下标（HTML5 拖放；手机上没有拖放，用 ↑ ↓ 按钮） */
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const add = (id: string) => onChange([...picked, id]);
  const remove = (id: string) => onChange(picked.filter((x) => x !== id));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= picked.length || from === to) return;
    const next = [...picked];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
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
        {picked.length === 0 ? (
          <div className="text-muted-foreground px-3 py-2.5 text-xs">还没有添加任何一项 —— 从下面点一个加入</div>
        ) : (
          picked.map((id, i) => {
            const meta = metaOf(id);
            return (
              <div
                key={id}
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
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{meta?.label ?? id}</span>
                  {meta?.hint ? (
                    <span className="text-muted-foreground block text-[11px]">{meta.hint}</span>
                  ) : null}
                </span>
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
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="size-6 shrink-0 px-0"
                  title={picked.length <= min ? `至少要保留 ${min} 项` : "移除"}
                  disabled={disabled || picked.length <= min}
                  onClick={() => remove(id)}
                >
                  <IconX className="size-3.5" />
                </Button>
              </div>
            );
          })
        )}
      </div>

      {rest.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-[11px]">点击加入：</span>
          {rest.map((o) => (
            <Button
              key={o.value}
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              title={o.hint}
              onClick={() => add(o.value)}
            >
              <IconPlus className="size-3.5" />
              {o.label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-[11px]">候选都已在列表里（拖动或用 ↑ ↓ 调整先后）</p>
      )}
    </div>
  );
}

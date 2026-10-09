// 模板字段编辑器
//
// 交互目标：给你一份默认模板，想改就改，想加内容就点变量按钮 ——
// 插到光标当前位置，不用手打 {netSigned} 这种名字（也打不错）。
//
// 变量清单由服务端下发（configSchema 里的 vars），前端不硬编码任何变量名，
// 所以服务端加变量不需要改前端。
import { useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconBraces,
  IconChevronDown,
  IconPointer,
  IconRotateClockwise,
} from "@tabler/icons-react";
import type { ConfigField } from "@/lib/queries.ts";
import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { cn } from "@/lib/utils.ts";

type TemplateFieldType = Extract<ConfigField, { type: "template" }>;

/** 找出模板里不在清单中的变量（写错了要提示，而不是等第二天发现） */
function findUnknown(template: string, known: Set<string>): string[] {
  const found: string[] = [];
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const name = m[1]!;
    if (!known.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

export function TemplateFieldEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: TemplateFieldType;
  value: unknown;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const text = typeof value === "string" ? value : "";
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(field.vars?.[0]?.group ?? null);

  const groups = field.vars ?? [];
  const known = new Set(groups.flatMap((g) => g.vars.map((v) => v.name)));
  const unknown = findUnknown(text, known);
  /** 模板里实际用到的变量（高亮对应的按钮） */
  const used = new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));

  /** 把变量插到光标位置（没聚焦时追加到末尾） */
  const insert = (token: string) => {
    const el = areaRef.current;
    if (!el) {
      onChange(text + token);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    const next = text.slice(0, start) + token + text.slice(end);
    onChange(next);
    // 插完把光标放到变量后面，方便继续写
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <Label className="text-[13px]">{field.label}</Label>
          {field.hint ? <p className="text-muted-foreground text-xs leading-snug">{field.hint}</p> : null}
        </div>
        {field.defaultTemplate ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onChange(field.defaultTemplate!)}
            title="把模板恢复成默认内容"
          >
            <IconRotateClockwise className="size-3.5" />
            恢复默认模板
          </Button>
        ) : null}
      </div>

      {/* 模板编辑区 */}
      <Textarea
        ref={areaRef}
        value={text}
        rows={field.rows ?? 12}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder ?? "在这里写日报内容，用 {变量} 插入数据"}
        className="scroll-slim font-mono text-[12px] leading-relaxed"
      />

      {unknown.length ? (
        <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs ring-1 ring-amber-500/25">
          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            不认识的变量：{unknown.map((u) => `{${u}}`).join("、")} —— 推送时会原样显示，请从下面的按钮里选。
          </span>
        </div>
      ) : null}

      {/* 变量按钮：按分组折叠，点一下插到光标处 */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <IconBraces className="text-muted-foreground size-3.5" />
          <span className="text-muted-foreground text-xs">可以用的变量（点一下就插到光标位置）</span>
        </div>

        {groups.map((g) => {
          const open = openGroup === g.group;
          const usedCount = g.vars.filter((v) => used.has(v.name)).length;
          return (
            <div key={g.group} className="overflow-hidden rounded-lg border">
              <button
                type="button"
                onClick={() => setOpenGroup(open ? null : g.group)}
                className="hover:bg-accent/40 flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors"
              >
                <span className="flex items-center gap-2 text-xs font-medium">
                  <IconChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
                  {g.group}
                  <span className="text-muted-foreground font-normal">{g.vars.length} 个</span>
                </span>
                {usedCount > 0 ? <Badge variant="online">已用 {usedCount}</Badge> : null}
              </button>

              {open ? (
                <div className="flex flex-wrap gap-1.5 border-t px-3 py-2.5">
                  {g.vars.map((v) => {
                    const on = used.has(v.name);
                    return (
                      <button
                        key={v.name}
                        type="button"
                        disabled={disabled}
                        onClick={() => insert(v.token)}
                        title={`${v.desc} · 点击插入 ${v.token}`}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] transition-colors",
                          on
                            ? "bg-emerald-500/12 text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-400"
                            : "bg-muted text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <IconPointer className="size-3 opacity-60" />
                        {v.token}
                        <span className="ml-0.5 font-sans opacity-70">{v.desc}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

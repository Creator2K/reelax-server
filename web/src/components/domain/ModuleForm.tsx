// 模块配置表单：完全由 configSchema 驱动渲染
//
// 关键点：**前端不硬编码任何模块字段**。
// 后端加一个配置项，这里自动出现对应控件；后端改类型，这里跟着变。
import { useEffect, useMemo, useState } from "react";
import { IconRotateClockwise } from "@tabler/icons-react";
import type { ConfigField, ModuleRuntimeState } from "@/lib/queries.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { cn } from "@/lib/utils.ts";

export type ModuleFormProps = {
  fields: ConfigField[];
  /** 当前生效值（后端已合并默认值） */
  values: Record<string, unknown>;
  /** 被后端标记为「不是当前版本认识的配置项」的旧键 */
  configIssues?: { key: string; message: string }[];
  disabled?: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<void> | void;
  onReset: () => Promise<void> | void;
};

/** 把单个字段的原始值转成输入控件可用的字符串 */
function toInputString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

export function ModuleForm({ fields, values, configIssues = [], disabled, onSave, onReset }: ModuleFormProps) {
  // 本地草稿：用户改完点保存才提交，避免每敲一个字符打一次接口
  const [draft, setDraft] = useState<Record<string, unknown>>(values);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // 用序列化后的值判断「后端值真的变了」，避免每次父组件重渲染都重置掉用户的编辑。
  // 提到 useMemo 里是为了让依赖数组可被静态检查（直接写 JSON.stringify(...) 会被 lint 警告）。
  const valuesKey = useMemo(() => JSON.stringify(values), [values]);
  useEffect(() => {
    setDraft(JSON.parse(valuesKey) as Record<string, unknown>);
    setDirty(false);
  }, [valuesKey]);

  const set = (key: string, v: unknown) => {
    setDraft((d) => ({ ...d, [key]: v }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const staleKeys = configIssues.filter((i) => i.message.includes("不是当前版本")).map((i) => i.key);

  return (
    <div className="space-y-4">
      {fields.map((f) => (
        <Field
          key={f.key}
          field={f}
          value={draft[f.key]}
          disabled={disabled}
          onChange={(v) => set(f.key, v)}
        />
      ))}

      {staleKeys.length > 0 ? (
        <div className="text-muted-foreground text-xs">
          另有 {staleKeys.length} 项旧版本遗留配置（{staleKeys.join("、")}）已保留但当前不使用。
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={() => void save()} disabled={disabled || saving || !dirty}>
          {saving ? "保存中…" : dirty ? "保存配置" : "已保存"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void onReset()}
          disabled={disabled || saving}
          title="恢复该功能的默认配置（不会改动开关状态）"
        >
          <IconRotateClockwise className="size-3.5" />
          恢复默认
        </Button>
      </div>
    </div>
  );
}

function Field({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  disabled?: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = `cfg-${field.key}`;

  const labelRow = (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[13px]">
        {field.label}
      </Label>
      {field.hint ? <p className="text-muted-foreground text-xs leading-snug">{field.hint}</p> : null}
    </div>
  );

  switch (field.type) {
    case "boolean":
      return (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">{labelRow}</div>
          <Switch
            id={id}
            checked={Boolean(value)}
            disabled={disabled}
            onCheckedChange={(c) => onChange(c)}
            className="mt-0.5 shrink-0"
          />
        </div>
      );

    case "number": {
      const num = Number(value);
      const invalid = !Number.isFinite(num);
      return (
        <div className="space-y-2">
          {labelRow}
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            value={toInputString(value)}
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(e) => {
              const raw = e.target.value;
              // 允许中间态为空，不立刻转成 NaN 覆盖用户输入
              onChange(raw === "" ? "" : Number(raw));
            }}
            className="max-w-48"
          />
          {field.min !== undefined || field.max !== undefined ? (
            <p className="text-muted-foreground text-xs">
              范围 {field.min ?? "-∞"} ~ {field.max ?? "+∞"}
              {field.step ? `，步长 ${field.step}` : ""}
            </p>
          ) : null}
        </div>
      );
    }

    case "select":
      return (
        <div className="space-y-2">
          {labelRow}
          <Select
            value={String(value ?? "")}
            disabled={disabled}
            onValueChange={(v) => onChange(v)}
          >
            <SelectTrigger id={id} className="max-w-80">
              <SelectValue placeholder="请选择" />
            </SelectTrigger>
            <SelectContent>
              {field.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );

    case "string":
      return (
        <div className="space-y-2">
          {labelRow}
          <Input
            id={id}
            value={toInputString(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="max-w-80"
          />
        </div>
      );

    case "textarea":
      return (
        <div className="space-y-2">
          {labelRow}
          <Textarea
            id={id}
            value={toInputString(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );

    default: {
      // 理论上不可达：类型联合已穷尽
      const never: never = field;
      return (
        <div className="text-muted-foreground text-xs">
          未知配置类型：
          <Badge variant="outline" className={cn("ml-1 font-mono")}>
            {JSON.stringify(never)}
          </Badge>
        </div>
      );
    }
  }
}

/** 模块卡片头部：开关 + 名称 + 状态 */
export function ModuleHeader({
  state,
  onToggle,
  toggling,
  disabled,
}: {
  state: ModuleRuntimeState;
  onToggle: (enabled: boolean) => void;
  toggling?: boolean;
  /** 前置条件未满足时禁用开关 */
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{state.name}</span>
          {disabled ? (
            <Badge variant="idle">不可用</Badge>
          ) : state.running ? (
            <Badge variant="online" className="gap-1">
              <span className="status-dot" data-status="online" />
              运行中
            </Badge>
          ) : state.enabled ? (
            <Badge variant="warn">已启用（未运行）</Badge>
          ) : (
            <Badge variant="idle">已关闭</Badge>
          )}
        </div>
        {/* 这里原本显示 state.id（keep-online 这类内部标识）—— 用户不需要看它 */}
      </div>
      <Switch
        checked={state.enabled}
        disabled={toggling || disabled}
        onCheckedChange={(c) => onToggle(c)}
        aria-label={`${state.enabled ? "关闭" : "启用"} ${state.name}`}
      />
    </div>
  );
}

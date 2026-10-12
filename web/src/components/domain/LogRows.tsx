// 日志行渲染（用户页与管理员日志页共用）
//
// 抽出来的原因：移动端那个"消息被挤成一字一列"的坑修过一次之后不该再修第二次 ——
// 两处渲染必须一致。
//
// 排版规则：
//  · 手机：元信息一行（时间 / 级别 / 来源，可换行）+ 消息整行铺满
//    （4 个固定宽度列会把消息压到只剩一两个字宽，中文就会竖着排）
//  · 桌面：sm:contents 让包装层"消失"，回到原来的多列一行
import { cn, fmtClock } from "@/lib/utils.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: "log-level-debug",
  info: "log-level-info",
  warn: "log-level-warn",
  error: "log-level-error",
};

export const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "调试",
  info: "信息",
  warn: "警告",
  error: "错误",
};

export type LogRow = {
  /** 唯一键（时间 + 序号） */
  key: string;
  t: number;
  level: LogLevel;
  /** 来源：模块名 + 账号名（可空） */
  who: string | null;
  tag: string;
  msg: string;
};

export function LogRows({ rows }: { rows: LogRow[] }) {
  return (
    <ul className="divide-border divide-y">
      {rows.map((e) => (
        <li key={e.key} className="flex flex-col gap-0.5 px-3 py-1.5 sm:flex-row sm:gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:contents">
            <span className="text-muted-foreground shrink-0 tabular-nums">{fmtClock(e.t)}</span>
            <span className={cn("w-8 shrink-0", LEVEL_CLASS[e.level])}>{LEVEL_LABEL[e.level] ?? e.level}</span>
            <span className="text-muted-foreground max-w-36 shrink-0 truncate sm:w-28" title={e.who ?? undefined}>
              {e.who || "—"}
            </span>
            <span className="text-muted-foreground max-w-24 shrink-0 truncate sm:w-16" title={e.tag}>
              {e.tag}
            </span>
          </div>
          <span className={cn("min-w-0 flex-1 break-words whitespace-pre-wrap", LEVEL_CLASS[e.level])}>{e.msg}</span>
        </li>
      ))}
    </ul>
  );
}

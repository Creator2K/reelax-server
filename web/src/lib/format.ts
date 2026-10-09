import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 约定：className 合并（tailwind-merge 负责去冲突） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 数字千分位（本控制台所有数量展示统一走这里） */
export function fmtInt(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return Math.round(v).toLocaleString("zh-CN");
}

/** 大数中文可读：1.2 万 / 3.4 亿（与后端 lib/util.ts 的 fmtNum 同口径） */
export function fmtNum(n: unknown): string {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(1)} 万`;
  return String(Math.round(v));
}

export function fmtSigned(n: unknown): string {
  const v = Number(n) || 0;
  return v >= 0 ? `+${fmtNum(v)}` : `-${fmtNum(Math.abs(v))}`;
}

export function fmtPct(bp: unknown, digits = 1): string {
  const v = Number(bp);
  if (!Number.isFinite(v)) return "—";
  const pct = v / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(digits)}%`;
}

/** 时长：毫秒 → "3天2时" / "5时12分" / "8分" */
export function fmtDuration(ms: unknown): string {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 60) return `${s}秒`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}天${h}时`;
  if (h) return `${h}时${m}分`;
  return `${m}分`;
}

/** 相对时间："刚刚" / "3 分钟前" / "2 小时前" / 本地日期 */
export function fmtRelative(ts: unknown): string {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return fmtClock(t);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

/** 时分秒 */
export function fmtClock(ts: unknown): string {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "—";
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 日期时间 */
export function fmtDateTime(ts: unknown): string {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "—";
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

/** 本地日 YYYY-MM-DD（与后端 account_stats_daily.day 口径一致） */
export function localDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

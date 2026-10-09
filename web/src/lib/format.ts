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

/**
 * 紧凑数字 —— 给**窄卡片**用（统计卡里一格只有 ~90px）。
 *
 * 为什么不直接用 fmtNum：`fmtNum(16427000)` 得到 "1642.7 万"（7 个字符），
 * 在窄卡里会挤到第二行，三张卡高度不齐。这里压到 3 位有效数字加单位
 * （"1643万"），并去掉 " 万"/" 亿" 前的空格。
 *
 * 精度取舍：卡片是「一眼看量级」的位置，精确值放在 title 里。
 *   mode:
 *     "auto"  → ≥1 亿用亿、≥1 万用万，否则原样（默认）
 *     "int"   → 始终整数 + 千分位
 *     "plain" → 始终原始整数
 */
export function fmtCompact(n: unknown, mode: "auto" | "int" | "plain" = "auto"): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";

  if (mode === "plain") return String(Math.round(v));
  if (mode === "int") return fmtInt(v);

  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";

  /** 压到 ≤3 位有效数字 */
  const shrink = (x: number): string => {
    const a = Math.abs(x);
    if (a >= 100) return Math.round(x).toString();
    if (a >= 10) return x.toFixed(1).replace(/\.0$/, "");
    return x.toFixed(2).replace(/\.?0+$/, "");
  };

  if (abs >= 1e8) return `${sign}${shrink(abs / 1e8)}亿`;
  if (abs >= 1e4) return `${sign}${shrink(abs / 1e4)}万`;
  return `${sign}${fmtInt(abs)}`;
}

/** 卡片的 title 属性：给精确值，避免紧凑显示丢精度后无从核对 */
export function fmtExact(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN");
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

// 数值格式化（与 web/src/lib/format.ts 保持同口径）
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

/** 万分比 → 百分比文本："1500" → "15%" */
export function fmtBp(bp: unknown): string {
  const v = Number(bp) || 0;
  const pct = v / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** 本地日 YYYY-MM-DD */
export function localDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

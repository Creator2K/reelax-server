// 通用工具（从旧引擎平移，保持语义一致）
import { randomUUID, randomBytes } from "node:crypto";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 抖动：在 [0.5x, 1.5x] 之间随机，用于模拟真人节奏 */
export const jitter = (ms: number): number => Math.round(ms * (0.5 + Math.random()));

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** 12 字节随机 id（与旧实现一致，24 位十六进制） */
export const uid = (): string => randomBytes(12).toString("hex");

export const newIdempotencyKey = (): string => randomUUID();

/** 等待到目标绝对时间戳，每 tickMs 检查一次 shouldAbort（避免无法响应停止） */
export async function sleepUntil(targetMs: number, shouldAbort: () => boolean, tickMs = 500): Promise<boolean> {
  for (;;) {
    if (shouldAbort()) return false;
    const remain = targetMs - Date.now();
    if (remain <= 0) return true;
    await sleep(Math.min(remain, tickMs));
  }
}

/** ISO 字符串或毫秒数 → ms 时间戳；失败返回 null */
export function parseTime(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function maskSecret(s: string | null | undefined): string | null | undefined {
  if (!s || typeof s !== "string") return s;
  if (s.length <= 8) return "****";
  return s.slice(0, 4) + "****" + s.slice(-4);
}

/** 数字 → 中文可读（1.2 万 / 3.4 亿）。API 与前端展示共用同一口径。 */
export function fmtNum(n: unknown): string {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(1)} 万`;
  return String(Math.round(v));
}

export const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(1|true|yes|on)$/i.test(v);
  return Boolean(v);
}

/** base64url 编码（无填充），签名与 proof 解析都用它 */
export function b64urlEncode(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Buffer {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(pad, "base64");
}

/** 深合并（后者优先），只合并普通对象，数组直接替换 */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev)) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** 安全 JSON 解析；失败返回 fallback */
export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

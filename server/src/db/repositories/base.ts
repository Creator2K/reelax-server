// 仓储基类与共用类型
//
// 约定：
//  1) 仓储只做「存储」，不碰加密 —— 密文的解封由 service 层在有解密需求时进行
//     （缩小明文暴露面：列表查询永远不触碰 password_enc）
//  2) 所有按用户隔离的查询都必须带 user_id 条件，这是多用户安全的核心
import type { Db, SqlValue } from "../client.ts";
import { uid } from "../../lib/util.ts";

export abstract class BaseRepo {
  protected db: Db;

  constructor(db: Db) {
    this.db = db;
  }
}

export const now = (): number => Date.now();
export const newId = (): string => uid();

/** 把 undefined 归一到 null（node:sqlite 不接受 undefined 作为绑定参数） */
export function nn<T>(v: T | undefined | null): T | null {
  return v === undefined ? null : (v as T | null);
}

/** 0/1 布尔转换（SQLite 没有 boolean） */
export const toInt = (v: boolean): number => (v ? 1 : 0);
export const fromInt = (v: SqlValue | undefined): boolean => Number(v) === 1;

/** 安全解析 JSON 字段 */
export function parseJson<T>(raw: SqlValue | undefined | null, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 分页参数归一：limit 限制在 [1, max]，offset >= 0
 */
export function pageParams(limit?: number, offset?: number, max = 200): { limit: number; offset: number } {
  const l = Number(limit);
  const o = Number(offset);
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(Math.floor(l), max) : 50,
    offset: Number.isFinite(o) && o > 0 ? Math.floor(o) : 0,
  };
}

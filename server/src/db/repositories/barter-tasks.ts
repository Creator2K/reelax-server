// 以物易物交换任务仓储（多轮交换的队列）
//
// 队列语义：
//  · 未结束的任务（waiting / running / blocked）排成一条队列，模块每次只推进队首
//    （「缺鱼」的排在最后，不会把后面能做的任务堵死）；
//  · 已结束的任务（done / cancelled）保留下来供面板回看，并按数量上限裁剪，避免无限增长。
//
// 一条任务 = 「拿起点侧列表里的鱼，换到目标侧列表里的任意一种」：
//  · 两侧都是**规格列表**（每项 = 某张地图上的任意同稀有度鱼，或指名鱼种）；
//  · 每换到 1 条目标鱼 done_quantity + 1，凑够 quantity 就算完成。
//
// ★ 兼容 1.17.0 的老数据：老的 from_fish_id / target_biome_id 这些列还在用，
//   规格列是空的时候按「单起点 + 单目标」合成（见 legacyFromSpecs / legacyTargetSpecs）。
import { BaseRepo, newId, nn, now } from "./base.ts";
import type { BarterSpec } from "../../services/barter-plan.ts";

export type BarterTaskStatus = "waiting" | "running" | "done" | "blocked" | "cancelled";

/** 未结束（还在队列里）的状态 */
export const BARTER_OPEN_STATUSES: BarterTaskStatus[] = ["waiting", "running", "blocked"];

/** 每侧规格条数上限（与官方挂单一致：每边最多 5 种） */
export const MAX_SPECS_PER_SIDE = 5;

export type BarterTaskRow = {
  id: string;
  account_id: string;
  user_id: string;
  /** 起点侧规格（新任务 1~5 项；老任务由老列兜底合成 1 项） */
  from_specs: BarterSpec[];
  /** 目标侧规格 */
  target_specs: BarterSpec[];
  /** 展示用：起点第一个规格的名字（老列，保留兼容） */
  from_fish_id: string;
  from_fish_name: string;
  from_biome_id: string | null;
  rarity: string;
  quantity: number;
  done_quantity: number;
  target_biome_id: string;
  target_fish_id: string | null;
  target_fish_name: string;
  status: BarterTaskStatus;
  last_note: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type BarterTaskCreate = {
  accountId: string;
  userId: string;
  /** 起点侧（至少 1 项） */
  fromSpecs: BarterSpec[];
  /** 目标侧（至少 1 项） */
  targetSpecs: BarterSpec[];
  quantity: number;
  /** 展示用的起点名字（面板与日志直接用，省一次鱼表查询） */
  fromFishId: string;
  fromFishName: string;
  fromBiomeId: string | null;
  rarity: string;
  targetBiomeId: string;
  targetFishId: string | null;
  targetFishName?: string;
};

export type BarterTaskPatch = {
  status?: BarterTaskStatus;
  doneQuantity?: number;
  lastNote?: string | null;
  lastError?: string | null;
};

/** 每个账号保留的已结束任务条数（超出就从最旧的开始删） */
const FINISHED_KEEP = 20;

const statusOf = (raw: unknown): BarterTaskStatus => {
  const s = String(raw ?? "");
  return s === "running" || s === "done" || s === "blocked" || s === "cancelled" ? s : "waiting";
};

/** 规格列表 → JSON（空列表存空字符串，用来区分「老数据」与「新数据」） */
function specsToJson(specs: BarterSpec[]): string {
  return specs.length ? JSON.stringify(specs) : "";
}

/** JSON → 规格列表（形状不认识就返回空数组，绝不抛错） */
export function parseSpecs(raw: unknown): BarterSpec[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out: BarterSpec[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const biomeId = rec.biomeId ? String(rec.biomeId) : null;
      const fishId = rec.fishId ? String(rec.fishId) : null;
      if (!biomeId && !fishId) continue;
      out.push({ biomeId, fishId, rarity: rec.rarity ? String(rec.rarity) : "" });
    }
    return out;
  } catch {
    return [];
  }
}

/** 老数据兜底：单起点列 → 规格列表 */
function legacyFromSpecs(row: Record<string, unknown>): BarterSpec[] {
  const fishId = String(row.from_fish_id ?? "");
  if (!fishId) return [];
  return [
    { biomeId: row.from_biome_id ? String(row.from_biome_id) : null, fishId, rarity: String(row.rarity ?? "") },
  ];
}

/** 老数据兜底：单目标列 → 规格列表 */
function legacyTargetSpecs(row: Record<string, unknown>): BarterSpec[] {
  const biomeId = row.target_biome_id ? String(row.target_biome_id) : null;
  const fishId = row.target_fish_id ? String(row.target_fish_id) : null;
  if (!biomeId && !fishId) return [];
  return [{ biomeId, fishId, rarity: String(row.rarity ?? "") }];
}

export class BarterTasksRepo extends BaseRepo {
  /** 某账号的全部任务（未结束的在前，其次按创建时间倒序的已结束任务） */
  listForAccount(accountId: string, opts: { limit?: number } = {}): BarterTaskRow[] {
    const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 200);
    const rows = this.db.all<BarterTaskRow>(
      // 队列在前（running → waiting → blocked，组内按创建时间升序），
      // 已结束的在后，按创建时间倒序（最近结束的排前面）
      `SELECT * FROM barter_tasks
        WHERE account_id = ?
        ORDER BY (status IN ('done','cancelled')) ASC,
                 CASE status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END ASC,
                 CASE WHEN status IN ('done','cancelled') THEN -created_at ELSE created_at END ASC
        LIMIT ?`,
      accountId,
      limit,
    );
    return rows.map((r) => this.normalize(r));
  }

  /** 未结束的任务，按「推进顺序」排列（running → waiting → blocked，组内按创建时间） */
  listOpen(accountId: string): BarterTaskRow[] {
    return this.db
      .all<BarterTaskRow>(
        `SELECT * FROM barter_tasks
          WHERE account_id = ? AND status IN ('waiting','running','blocked')
          ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END ASC,
                   created_at ASC`,
        accountId,
      )
      .map((r) => this.normalize(r));
  }

  /**
   * 队列头（下一个要推进的任务）。
   *
   * ★ 「缺鱼」（blocked）的任务排在最后：它只是暂时做不了（鱼被卖掉 / 变成专精目标），
   *   不能因为排在队首就把后面能做的任务一起堵死；等它重新成为队首时（别的任务都结束了），
   *   每次检查都会再试一次 —— 钓到鱼之后它会自己恢复。
   */
  nextOpen(accountId: string): BarterTaskRow | null {
    const r = this.db.get<BarterTaskRow>(
      `SELECT * FROM barter_tasks
        WHERE account_id = ? AND status IN ('waiting','running','blocked')
        ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END ASC,
                 created_at ASC
        LIMIT 1`,
      accountId,
    );
    return r ? this.normalize(r) : null;
  }

  countOpen(accountId: string): number {
    const r = this.db.get<{ c: number }>(
      `SELECT count(*) AS c FROM barter_tasks
        WHERE account_id = ? AND status IN ('waiting','running','blocked')`,
      accountId,
    );
    return Number(r?.c ?? 0);
  }

  find(id: string, accountId: string): BarterTaskRow | null {
    const r = this.db.get<BarterTaskRow>(
      "SELECT * FROM barter_tasks WHERE id = ? AND account_id = ?",
      id,
      accountId,
    );
    return r ? this.normalize(r) : null;
  }

  create(input: BarterTaskCreate): BarterTaskRow {
    const id = newId();
    const ts = now();
    this.db.run(
      `INSERT INTO barter_tasks
         (id, account_id, user_id, from_fish_id, from_fish_name, from_biome_id, rarity,
          quantity, done_quantity, target_biome_id, target_fish_id, target_fish_name, status,
          last_note, last_error, created_at, updated_at, from_specs_json, target_specs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'waiting', NULL, NULL, ?, ?, ?, ?)`,
      id,
      input.accountId,
      input.userId,
      input.fromFishId,
      input.fromFishName,
      nn(input.fromBiomeId),
      input.rarity,
      Math.max(1, Math.floor(input.quantity)),
      input.targetBiomeId,
      nn(input.targetFishId),
      input.targetFishName ?? "",
      ts,
      ts,
      specsToJson(input.fromSpecs),
      specsToJson(input.targetSpecs),
    );
    const row = this.find(id, input.accountId);
    if (!row) throw new Error("写入交换任务后读取失败");
    return row;
  }

  update(id: string, accountId: string, patch: BarterTaskPatch): boolean {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.doneQuantity !== undefined) {
      sets.push("done_quantity = ?");
      params.push(Math.max(0, Math.floor(patch.doneQuantity)));
    }
    if (patch.lastNote !== undefined) {
      sets.push("last_note = ?");
      params.push(nn(patch.lastNote));
    }
    if (patch.lastError !== undefined) {
      sets.push("last_error = ?");
      params.push(nn(patch.lastError));
    }
    if (!sets.length) return false;
    sets.push("updated_at = ?");
    params.push(now(), id, accountId);
    const res = this.db.run(`UPDATE barter_tasks SET ${sets.join(", ")} WHERE id = ? AND account_id = ?`, ...params);
    return Number(res.changes) > 0;
  }

  /** 取消任务：只改状态 —— 已经换掉的鱼回不来，记录要留着 */
  cancel(id: string, accountId: string): boolean {
    return this.update(id, accountId, { status: "cancelled", lastNote: "已取消" });
  }

  /** 裁剪已结束任务（默认每账号留 FINISHED_KEEP 条），避免历史无限堆积 */
  pruneFinished(accountId: string, keep = FINISHED_KEEP): number {
    const res = this.db.run(
      `DELETE FROM barter_tasks
        WHERE account_id = ?
          AND status IN ('done','cancelled')
          AND id NOT IN (
            SELECT id FROM barter_tasks
             WHERE account_id = ? AND status IN ('done','cancelled')
             ORDER BY updated_at DESC LIMIT ?
          )`,
      accountId,
      accountId,
      Math.max(0, Math.floor(keep)),
    );
    return Number(res.changes);
  }

  /**
   * 把行规整成可直接用的形状：补齐规格列表（老数据用老列合成）、归一化数字与 null。
   *
   * 调用方（模块 / 面板）因此不需要关心「这条任务是新数据还是老数据」。
   */
  private normalize(r: BarterTaskRow): BarterTaskRow {
    const raw = r as unknown as Record<string, unknown>;
    const fromSpecs = parseSpecs(raw.from_specs_json);
    const targetSpecs = parseSpecs(raw.target_specs_json);
    return {
      ...r,
      from_specs: fromSpecs.length ? fromSpecs : legacyFromSpecs(raw),
      target_specs: targetSpecs.length ? targetSpecs : legacyTargetSpecs(raw),
      status: statusOf(r.status),
      quantity: Math.max(0, Number(r.quantity) || 0),
      done_quantity: Math.max(0, Number(r.done_quantity) || 0),
      from_biome_id: r.from_biome_id ?? null,
      target_fish_id: r.target_fish_id ?? null,
      target_fish_name: r.target_fish_name ?? "",
      last_note: r.last_note ?? null,
      last_error: r.last_error ?? null,
    };
  }
}

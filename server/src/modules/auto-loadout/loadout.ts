// 装备配装（gear loadout）的数据形状与解析
//
// 协议（对照游戏前端 bundle 实测，2026-10 / 前端 0.25.2）：
//   GET    /api/gear/loadouts              → { loadouts: [{ slot, name, gear, stats }] }
//   PUT    /api/gear/loadouts/{slot}  {name}  → 把「当前身上这套」存进该槽（本模块不用）
//   POST   /api/gear/loadouts/{slot}/load     → 装载该槽（把身上装备换成配装内容）
//   DELETE /api/gear/loadouts/{slot}          → 清空该槽（本模块不用）
//
// `slot` 是配装序号（1 起，游戏里叫「配装 1 / 配装 2 …」），由服务端决定一共几个；
// `gear` 是以部位名为键的对象（head / chest / legs / boots / gloves / amulet / ring_1 / ring_2 / charm），
// 空位是 null。这里只关心「这个配装有没有内容」，不解析具体装备。

export type Loadout = {
  slot: number;
  name: string | null;
  /** 有装备的部位数（0 = 空配装，装了也没意义） */
  filled: number;
  /** 原样保留服务端给的其它字段，供将来展示用 */
  raw: Record<string, unknown>;
};

const GEAR_SLOTS = ["head", "chest", "legs", "boots", "gloves", "amulet", "ring_1", "ring_2", "charm"] as const;

/** 解析 GET /api/gear/loadouts；字段缺失/类型不对时跳过该项，不抛错 */
export function parseLoadouts(data: unknown): Loadout[] {
  const list = (data as { loadouts?: unknown })?.loadouts;
  if (!Array.isArray(list)) return [];

  const out: Loadout[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const slot = Number(row.slot);
    if (!Number.isInteger(slot) || slot <= 0) continue;

    const gear = (row.gear ?? {}) as Record<string, unknown>;
    // 只数已知部位，避免服务端以后加字段被算进「已装备」
    const filled = GEAR_SLOTS.reduce((n, k) => n + (gear[k] ? 1 : 0), 0);
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : null;

    out.push({ slot, name, filled, raw: row });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/** 日志里怎么写这个配装 */
export function loadoutLabel(l: Loadout): string {
  return `${l.slot} 号${l.name ? `「${l.name}」` : "（空）"}`;
}

/** 给日志用的一句话描述 */
export function describeLoadout(l: Loadout): string {
  return `${loadoutLabel(l)}${l.filled > 0 ? `（${l.filled} 件）` : ""}`;
}

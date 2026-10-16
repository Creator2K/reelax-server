// 地图清单（取自游戏 bundle 的 biome 定义，勿手改）
//
// 为什么硬编码而不是每次从 /api/biomes 拉：
//   配置表单需要**在账号未启动时**也能渲染下拉选项（服务端拿不到游戏数据）。
//   地图是游戏世界的固定内容，不随账号变化。
//
// requiredLevel / unlockCost 也一并抄下来：
//   · 「自动解锁地图」要按等级与花费排序、并在日志里说清「要花多少」；
//   · 游戏接口不一定每次都下发这两个字段，本地有一份就能兜底。
//
// 注意：这里只是"选项来源"，实际换图 / 解锁前仍会用 /api/biomes 校验是否已解锁。

export type BiomeOption = {
  id: string;
  name: string;
  /** 解锁所需等级 */
  requiredLevel: number;
  /** 解锁花费（金币）；0 = 初始就解锁 */
  unlockCost: number;
};

export const BIOMES: BiomeOption[] = [
  { id: "b_001", name: "月落溪谷", requiredLevel: 0, unlockCost: 0 },
  { id: "b_002", name: "雾语湿地", requiredLevel: 50, unlockCost: 15_000 },
  { id: "b_003", name: "镜潮海岸", requiredLevel: 100, unlockCost: 200_000 },
  { id: "b_004", name: "雷痕峡湾", requiredLevel: 200, unlockCost: 500_000 },
  { id: "b_005", name: "星根洞窟", requiredLevel: 350, unlockCost: 1_000_000 },
  { id: "b_006", name: "霞栖湖原", requiredLevel: 500, unlockCost: 1_500_000 },
  { id: "b_007", name: "云汐悬湖", requiredLevel: 750, unlockCost: 2_000_000 },
  { id: "b_008", name: "赤砂涌泉", requiredLevel: 1250, unlockCost: 3_000_000 },
  { id: "b_009", name: "极昼冰湾", requiredLevel: 2000, unlockCost: 4_000_000 },
  { id: "b_010", name: "沉钟古港", requiredLevel: 3000, unlockCost: 5_000_000 },
  { id: "b_011", name: "翡翠洪林", requiredLevel: 4250, unlockCost: 6_500_000 },
  { id: "b_012", name: "熔潮环礁", requiredLevel: 5500, unlockCost: 8_000_000 },
  { id: "b_013", name: "天穹鲸海", requiredLevel: 7250, unlockCost: 10_000_000 },
  { id: "b_014", name: "时镜回流", requiredLevel: 8500, unlockCost: 11_500_000 },
  { id: "b_015", name: "星渊圣海", requiredLevel: 10_000, unlockCost: 13_000_000 },
];

/** 供 select 字段用：「星渊圣海（b_015）」 */
export const BIOME_OPTIONS: { value: string; label: string }[] = BIOMES.map((b) => ({
  value: b.id,
  label: `${b.name}（${b.id}）`,
}));

export function biomeName(id: unknown): string | null {
  return BIOMES.find((b) => b.id === id)?.name ?? null;
}

/**
 * 地图编号的短写法：`b_002` → `B2`（玩家在游戏里就是这么叫的）。
 *
 * 界面上的地图一律写成「雾语湿地 B2」这种形式 —— 玩家交流时说的是 B 几，
 * 只给中文名反而对不上；拿不到编号就返回 null（调用方退回只显示名字）。
 */
export function biomeCode(id: unknown): string | null {
  const s = String(id ?? "");
  const m = /^b_(\d+)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? `B${n}` : null;
}

/** 「雾语湿地 B2」；名字或编号缺失时尽量给出可读结果 */
export function biomeLabel(id: unknown): string | null {
  const name = biomeName(id);
  const code = biomeCode(id);
  if (name && code) return `${name} ${code}`;
  return name ?? code ?? null;
}

export function biomeById(id: unknown): BiomeOption | null {
  return BIOMES.find((b) => b.id === id) ?? null;
}

/**
 * 一张地图的解锁信息：优先用接口给的（游戏改版时以它为准），本地表兜底。
 * 接口字段缺失 / 不是数字时都用本地值。
 */
export function biomeUnlockInfo(biome: any): { requiredLevel: number; unlockCost: number } {
  const local = biomeById(biome?.id);
  const lvl = Number(biome?.requiredLevel);
  const cost = Number(biome?.unlockCost);
  return {
    requiredLevel: Number.isFinite(lvl) && lvl >= 0 ? lvl : (local?.requiredLevel ?? 0),
    unlockCost: Number.isFinite(cost) && cost >= 0 ? cost : (local?.unlockCost ?? 0),
  };
}

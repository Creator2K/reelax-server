// 地图清单（取自游戏 bundle，勿手改）
//
// 为什么硬编码而不是每次从 /api/biomes 拉：
//   配置表单需要**在账号未启动时**也能渲染下拉选项（服务端拿不到游戏数据）。
//   地图是游戏世界的固定内容，不随账号变化。
//
// 注意：这里只是"选项来源"，实际换图前仍会用 /api/biomes 校验是否已解锁
// （未解锁的地图切过去会失败，日志里会明确提示）。

export type BiomeOption = { id: string; name: string };

export const BIOMES: BiomeOption[] = [
  { id: "b_001", name: "月落溪谷" },
  { id: "b_002", name: "雾语湿地" },
  { id: "b_003", name: "镜潮海岸" },
  { id: "b_004", name: "雷痕峡湾" },
  { id: "b_005", name: "星根洞窟" },
  { id: "b_006", name: "霞栖湖原" },
  { id: "b_007", name: "云汐悬湖" },
  { id: "b_008", name: "赤砂涌泉" },
  { id: "b_009", name: "极昼冰湾" },
  { id: "b_010", name: "沉钟古港" },
  { id: "b_011", name: "翡翠洪林" },
  { id: "b_012", name: "熔潮环礁" },
  { id: "b_013", name: "天穹鲸海" },
  { id: "b_014", name: "时镜回流" },
  { id: "b_015", name: "星渊圣海" },
];

/** 供 select 字段用：「b_015 · 星渊圣海」 */
export const BIOME_OPTIONS: { value: string; label: string }[] = BIOMES.map((b) => ({
  value: b.id,
  label: `${b.name}（${b.id}）`,
}));

export function biomeName(id: unknown): string | null {
  return BIOMES.find((b) => b.id === id)?.name ?? null;
}

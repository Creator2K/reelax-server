// 日报的分区定义
//
// 为什么要把「有哪些内容」抽出来：用户想自己决定日报里出现什么
// （有人只关心净收益，有人要看到比赛名次）。把分区做成有 id 的清单后，
// 配置界面能自动渲染勾选项，生成端也只按 id 拼装。
//
// 约定：新增分区时同时补上这里的定义与 buildReport 里的分支，
// 顺序 = 默认展示顺序。

export type DigestSectionId =
  | "income"
  | "experience"
  | "level"
  | "fish"
  | "rareFish"
  | "drops"
  | "allRarities"
  | "competitions"
  | "pity";

export type DigestSectionDef = {
  id: DigestSectionId;
  label: string;
  hint: string;
  /** 默认是否包含 */
  defaultOn: boolean;
  /** 这一项需要额外请求比赛/围猎接口 */
  needsHistory?: boolean;
};

export const DIGEST_SECTIONS: DigestSectionDef[] = [
  {
    id: "income",
    label: "净收益",
    hint: "收入、鱼饵消耗与净收益（含鱼饵占收入的比例）",
    defaultOn: true,
  },
  {
    id: "experience",
    label: "经验增量",
    hint: "两次日报之间的经验差值；没有基线时显示「无基线」而不编数字",
    defaultOn: true,
  },
  {
    id: "level",
    label: "等级与转生进度",
    hint: "当前等级（含当日升级数）以及距转生还差多少级 / 多少金币",
    defaultOn: true,
  },
  {
    id: "fish",
    label: "鱼获总数",
    hint: "当天钓到的鱼的总条数",
    defaultOn: true,
  },
  {
    id: "rareFish",
    label: "高稀有度鱼获",
    hint: "传说及以上各档的数量（最有价值的产出）",
    defaultOn: true,
  },
  {
    id: "drops",
    label: "掉落统计",
    hint: "装备、宝箱、遗物、神器等级",
    defaultOn: true,
  },
  {
    id: "allRarities",
    label: "全部 9 档稀有度",
    hint: "每一档都列出，消息会明显变长",
    defaultOn: false,
  },
  {
    id: "competitions",
    label: "比赛与围猎战果",
    hint: "最近一场个人赛、公会赛的名次，以及围猎的伤害与奖励",
    defaultOn: true,
    needsHistory: true,
  },
  {
    id: "pity",
    label: "保底进度",
    hint: "奇异 / 奥秘鱼的硬保底还差多少杆（适合在冲保底时打开）",
    defaultOn: false,
  },
];

/** 默认开启的分区集合（给模块默认配置用） */
export function defaultDigestSections(): DigestSectionId[] {
  return DIGEST_SECTIONS.filter((s) => s.defaultOn).map((s) => s.id);
}

/** 校验一组分区 id，剔除不认识的项并去重、按定义顺序排序 */
export function normalizeDigestSections(input: unknown): DigestSectionId[] {
  const known = new Map(DIGEST_SECTIONS.map((s, i) => [s.id, i] as const));
  const raw = Array.isArray(input)
    ? input.map((x) => String(x))
    : typeof input === "string"
      ? input.split(/[,，\s]+/)
      : [];
  const picked = new Set(raw.filter((x) => known.has(x as DigestSectionId)));
  return DIGEST_SECTIONS.map((s) => s.id).filter((id) => picked.has(id)) as DigestSectionId[];
}

/** 供前端配置界面渲染的清单 */
export function digestSectionOptions(): { value: DigestSectionId; label: string; hint: string }[] {
  return DIGEST_SECTIONS.map((s) => ({ value: s.id, label: s.label, hint: s.hint }));
}

/* ================================================================
 * 预览用：示例数据 + 按分区拼装
 *
 * 为什么放在同一个文件：预览必须与真实产出**用同一套分区清单**，
 * 否则配置界面显示一种、实际推送另一种，用户会以为配置没生效。
 * 示例数据是写死的常量，不依赖任何账号，所以前端可以直接算。
 * ================================================================ */

/** 预览用的示例值（真实数值在服务端算） */
export const DIGEST_PREVIEW_SAMPLE: Record<string, string> = {
  date: "2026-10-10",
  label: "昨日",
  account: "力工",
  net: "+182.4 万",
  fish: "4,128",
  xp: "+1,204.6 万",
};

/** 每个分区在预览里对应的一行（与 buildReport 的产出保持同样的措辞） */
const PREVIEW_LINES: Record<DigestSectionId, string> = {
  income: "净收益 +182.4 万（收入 226.9 万 − 鱼饵 44.5 万，鱼饵占 20%）",
  experience: "经验 +1,204.6 万",
  level: "等级 Lv 11,622（+3），距转生还差 3,377 级 / 8,400.4 万 金币",
  fish: "鱼获 4,128 条",
  rareFish: "高稀有度 传说 12 · 神话 4 · 奇异 1",
  drops: "掉落 装备 86 · 宝箱 14 · 遗物 2 · 神器 +1",
  allRarities: "全部稀有度 普通 2,180 / 罕见 940 / 精良 620 / 稀有 310 / 史诗 150 / 传说 12 / 神话 4 / 奇异 1",
  competitions: "个人赛 #42 第 3 名（8,120 分）",
  pity: "保底进度 奇异鱼 还差 20 杆 · 奥秘鱼 还差 320 杆",
};

/**
 * 日时报变量替换。
 *
 * 支持的写法：`{date}` `{label}` `{account}` `{net}` `{fish}` `{xp}`
 * 不认识的占位符**原样保留** —— 静默吞掉会让用户以为自己写错了却看不出问题。
 */
export function applyDigestVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined ? whole : v;
  });
}

/** 可用的变量清单（配置界面展示给用户） */
export const DIGEST_VARS: { name: string; desc: string }[] = [
  { name: "{date}", desc: "日期" },
  { name: "{label}", desc: "昨日 / 今日截至现在" },
  { name: "{account}", desc: "账号名" },
  { name: "{net}", desc: "净收益" },
  { name: "{fish}", desc: "鱼获条数" },
  { name: "{xp}", desc: "经验增量" },
];

/** 按选中分区生成预览行（含自定义标题与结尾） */
export function previewDigest(opts: {
  sections: unknown;
  title?: string;
  footer?: string;
}): string[] {
  const chosen = normalizeDigestSections(opts.sections);
  const vars = DIGEST_PREVIEW_SAMPLE;
  const head = String(opts.title ?? "").trim()
    ? applyDigestVars(String(opts.title), vars)
    : `${vars.label} · ${vars.date}`;

  const lines = [head, ...chosen.map((id) => PREVIEW_LINES[id])];
  const footer = String(opts.footer ?? "").trim();
  if (footer) lines.push(applyDigestVars(footer, vars));
  return lines;
}

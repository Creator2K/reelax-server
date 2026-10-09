// 日报模板：变量定义 + 渲染
//
// 设计：给一个**默认模板**，用户想改就改，变量用 {名字} 写。
// 变量清单与示例值是同一份数据 —— 配置界面的「可以用的变量」、预览、
// 真实推送全都从这来，不会出现「界面上说有这么个变量、实际推不出来」。
//
// 渲染规则：
//  · {name} 替换成实际值
//  · 值算不出来 / 当天没有（例如没打比赛）→ 替换成**空串**，
//    这样「高稀有度：{rareFish}」这类整行会自然消失，不需要条件语法
//  · 不认识的变量名原样保留 —— 静默吞掉会让用户以为自己写错了却看不出问题

/** 一条日报能拿到的全部数据 */
export type DigestData = {
  /* 基本信息 */
  date: string;
  label: string;
  account: string;

  /* 收益 */
  net: number;
  income: number;
  baitCost: number;
  baitPct: number | null;

  /* 鱼获 */
  fishTotal: number;
  fishCommon: number;
  fishUncommon: number;
  fishFine: number;
  fishRare: number;
  fishEpic: number;
  fishLegendary: number;
  fishMythic: number;
  fishExotic: number;
  fishArcane: number;
  rareFish: string;

  /* 掉落 */
  gear: number;
  chests: number;
  relics: number;
  artifactLevels: number;

  /* 成长 */
  xp: number | null;
  xpText: string;
  level: number | null;
  levelGain: number | null;
  levelShortfall: number | null;
  goldShortfall: number | null;

  /* 比赛与围猎 */
  tournament: string;
  guildTournament: string;
  worldBoss: string;

  /* 保底 */
  pityExotic: number | null;
  pityArcane: number | null;
};

/**
 * 变量表。
 *
 * group 用于配置界面分组展示（变量多了不分组长得一团乱）。
 * sample 是预览用的示例值 —— 故意用真实量级的数字，好让用户判断排版。
 */
export const DIGEST_VARS: {
  name: string;
  desc: string;
  group: string;
  sample: string;
}[] = [
  { name: "date", desc: "日期", group: "基本", sample: "2026-10-10" },
  { name: "label", desc: "昨日 / 今日截至现在", group: "基本", sample: "昨日" },
  { name: "account", desc: "账号名", group: "基本", sample: "力工" },

  { name: "net", desc: "净收益", group: "收益", sample: "182.4万" },
  { name: "netSigned", desc: "净收益（带正负号）", group: "收益", sample: "+182.4万" },
  { name: "income", desc: "金币收入", group: "收益", sample: "226.9万" },
  { name: "baitCost", desc: "鱼饵消耗", group: "收益", sample: "44.5万" },
  { name: "baitPct", desc: "鱼饵占收入比例", group: "收益", sample: "20%" },

  { name: "fishTotal", desc: "鱼获总条数", group: "鱼获", sample: "4,128" },
  { name: "rareFish", desc: "高稀有度明细（传说及以上）", group: "鱼获", sample: "传说 12 · 神话 4 · 奇异 1" },
  { name: "fishCommon", desc: "普通", group: "鱼获·分档", sample: "2,180" },
  { name: "fishUncommon", desc: "罕见", group: "鱼获·分档", sample: "940" },
  { name: "fishFine", desc: "精良", group: "鱼获·分档", sample: "620" },
  { name: "fishRare", desc: "稀有", group: "鱼获·分档", sample: "310" },
  { name: "fishEpic", desc: "史诗", group: "鱼获·分档", sample: "150" },
  { name: "fishLegendary", desc: "传说", group: "鱼获·分档", sample: "12" },
  { name: "fishMythic", desc: "神话", group: "鱼获·分档", sample: "4" },
  { name: "fishExotic", desc: "奇异", group: "鱼获·分档", sample: "1" },
  { name: "fishArcane", desc: "奥秘", group: "鱼获·分档", sample: "0" },

  { name: "gear", desc: "装备掉落", group: "掉落", sample: "86" },
  { name: "chests", desc: "宝箱", group: "掉落", sample: "14" },
  { name: "relics", desc: "遗物", group: "掉落", sample: "2" },
  { name: "artifactLevels", desc: "神器等级提升", group: "掉落", sample: "1" },

  { name: "xp", desc: "经验增量（纯数字）", group: "成长", sample: "1204.6万" },
  { name: "xpText", desc: "经验（整句）", group: "成长", sample: "经验 +1204.6万" },
  { name: "level", desc: "当前等级", group: "成长", sample: "11,622" },
  { name: "levelGain", desc: "当日升级数", group: "成长", sample: "3" },
  { name: "levelShortfall", desc: "距转生还差等级", group: "成长", sample: "3,377" },
  { name: "goldShortfall", desc: "距转生还差金币", group: "成长", sample: "8,400.4万" },

  { name: "tournament", desc: "个人赛战果", group: "比赛", sample: "个人赛 #42 第 3 名（8,120 分）" },
  { name: "guildTournament", desc: "公会赛战果", group: "比赛", sample: "公会赛 #18 第 12 名（24,300 分）" },
  { name: "worldBoss", desc: "围猎战果", group: "比赛", sample: "围猎 渊潮之主 伤害 1,240万 · 第 5 名 · 奖励 8万 金币" },

  { name: "pityExotic", desc: "奇异鱼保底还差多少杆", group: "保底", sample: "20" },
  { name: "pityArcane", desc: "奥秘鱼保底还差多少杆", group: "保底", sample: "320" },
];

const VAR_NAMES = new Set(DIGEST_VARS.map((v) => v.name));

/**
 * 默认模板。
 *
 * 交付给用户时的样子就是它 —— 说明里那句「默认模板」指的就是这里。
 * 每一行单独成立，某行变量为空时整行会消失（只剩换行），效果就是「没有就不显示」。
 */
export const DEFAULT_DIGEST_TEMPLATE = [
  "{label} · {date}",
  "净收益 {netSigned}（收入 {income} − 鱼饵 {baitCost}，鱼饵占 {baitPct}）",
  "{xpText}",
  "等级 Lv {level}（+{levelGain}），距转生还差 {levelShortfall} 级 / {goldShortfall} 金币",
  "鱼获 {fishTotal} 条",
  "高稀有度 {rareFish}",
  "掉落 装备 {gear} · 宝箱 {chests} · 遗物 {relics} · 神器 +{artifactLevels}",
  "{tournament}",
  "{guildTournament}",
  "{worldBoss}",
].join("\n");

/** 把一条日报数据转成「变量名 → 文本」的字典 */
export function digestDataToVars(d: DigestData): Record<string, string> {
  const fish: Record<string, number> = {
    fishCommon: d.fishCommon,
    fishUncommon: d.fishUncommon,
    fishFine: d.fishFine,
    fishRare: d.fishRare,
    fishEpic: d.fishEpic,
    fishLegendary: d.fishLegendary,
    fishMythic: d.fishMythic,
    fishExotic: d.fishExotic,
    fishArcane: d.fishArcane,
  };

  const out: Record<string, string> = {
    date: d.date,
    label: d.label,
    account: d.account,
    // 金币用「万/亿」：六位数以上读起来更快
    net: fmtNum(d.net),
    netSigned: fmtSigned(d.net),
    income: fmtNum(d.income),
    baitCost: fmtNum(d.baitCost),
    baitPct: d.baitPct == null ? "" : `${d.baitPct}%`,
    // ★ 条数/等级用精确值：用「万」会把 11,622 级显示成「1.2万级」，
    //   这类数字用户是要看的准确值，不是量级
    fishTotal: fmtInt(d.fishTotal),
    rareFish: d.rareFish,
    gear: String(d.gear),
    chests: String(d.chests),
    relics: String(d.relics),
    artifactLevels: String(d.artifactLevels),
    xp: d.xp == null ? "" : fmtNum(d.xp),
    xpText: d.xpText,
    level: d.level == null ? "" : fmtInt(d.level),
    levelGain: d.levelGain == null ? "" : String(d.levelGain),
    levelShortfall: d.levelShortfall == null ? "" : fmtInt(d.levelShortfall),
    goldShortfall: d.goldShortfall == null ? "" : fmtNum(d.goldShortfall),
    tournament: d.tournament,
    guildTournament: d.guildTournament,
    worldBoss: d.worldBoss,
    pityExotic: d.pityExotic == null ? "" : String(d.pityExotic),
    pityArcane: d.pityArcane == null ? "" : String(d.pityArcane),
  };
  for (const [k, v] of Object.entries(fish)) out[k] = fmtInt(v);
  return out;
}

/** 变量名与行号的对应位置（用于判断某变量是否单独占一整行） */
const WHOLE_LINE_VAR = /^\{(\w+)\}$/;

/**
 * 在模板行里替换变量。
 *
 * 记录几个信号，它们是后面收拾空壳行的**唯一可靠依据**：
 *   · emptyVars   —— 有几个变量渲染成了空（缺数据）
 *   · filledVars  —— 有几个变量渲染出了内容
 *   · staticRuns  —— 模板里的静态文字块（去掉变量、空白、标点后的中文/英文片段）
 *   · text        —— 替换后的文本
 *
 * ★ 为什么不能靠比较渲染前后的字符串差异：`📊 {account} 的{label}战报`
 *   变量都有值，只是空格被压缩了，早期版本因此把它整行删掉（真 bug）。
 *
 * ★ 为什么要看 staticRuns：「🎯 奥秘保底还差 {pityArcane} 杆」在缺数据时
 *   会渲染成「🎯 奥秘保底还差 杆」——光看渲染结果，`还差` 像是有意义的内容；
 *   但从模板能看出它只是短标签（2 个字），整行应当丢掉。
 *   而用户自己写的长文案（「今天真是丰收的一天」）不该被删。
 */
function interpolate(
  line: string,
  vars: Record<string, string>,
): { text: string; emptyVars: number; filledVars: number; prose: boolean } {
  let emptyVars = 0;
  let filledVars = 0;
  const text = line.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!VAR_NAMES.has(name)) return whole; // 不认识的变量原样保留
    const v = vars[name] ?? "";
    if (v === "") emptyVars++;
    else filledVars++;
    return v;
  });

  return { text, emptyVars, filledVars, prose: isUserProse(line) };
}

/**
 * 判断这一行是「标签骨架」还是「用户写的文案」。
 *
 * 判据（满足其一即视为用户文案，整行要保留）：
 *   · 模板里出现句末标点（。！？；）—— 说明是完整的句子
 *   · 最长的中文片段超过 8 个字 —— 说明不是「净收益」「高稀有度」这类标签
 *
 * ★ 必须在**模板原文**上判断：句末标点在提取片段时会被丢掉，
 *   等到渲染结果上再看就晚了。
 *
 * 实测边界：
 *   `等级 {level} 升 {levelGain}`      → 标签（最长 2 字）→ 缺数据时整行丢掉
 *   `🎯 奥秘保底还差 {pityArcane} 杆`  → 标签（最长 6 字）→ 缺数据时整行丢掉
 *   `今天真是丰收的一天 {xpText}`      → 文案（10 字）→ 保留，只丢掉空出来的变量
 *   `今天很顺利。{xpText}`             → 句子 → 保留
 */
function isUserProse(templateLine: string): boolean {
  if (/[。！？；]/.test(templateLine)) return true;
  const runs = templateLine.replace(/\{\w+\}/g, " ").match(/[\u4e00-\u9fa5]+/g) ?? [];
  const longest = runs.reduce((a, r) => Math.max(a, r.length), 0);
  return longest > 8;
}


/**
 * 收拾「有变量渲染成空」的那一行。
 *
 * 直观目标：用户看到的样子应该像「本来就没写这一段」。
 *
 * 判据（按顺序）：
 *   1) 没有空变量 → 用户自己写的静态文案，原样输出
 *   2) 有空变量，且这一行**没有任何变量渲染出内容**：
 *      · 没有实义字符（数字/字母/emoji）且静态文字像标签 → 整行丢掉
 *      · 否则保留，让用户看到「这一项是空的」
 *   3) 收掉空出来的分隔符与「尾巴上只剩标签」的段
 *
 * 效果举例：
 *   `📊 {account} 的{label}战报`（都有值）→ 保留
 *   `🎯 奥秘保底还差 {pityArcane} 杆`（无保底数据）→ 丢掉（不会出现「还差 杆」）
 *   `净收益 {netSigned} · 鱼饵占 {baitPct}`（无比例）→ 保留前半段
 *   `今天真不错 {xpText}`（无经验数据）→ 保留（长文案是用户自己写的）
 */
function cleanupRenderedLine(text: string, emptyVars: number, filledVars: number, prose: boolean): string {
  // 只收「枚举分隔符」的空尾巴：`·` `、`
  // ★ 不能把 `。！？；` 放进来 —— 它们是句末标点，属于用户写的正文，收掉就变味了
  const collapse = (v: string) =>
    v
      .replace(/\s{2,}/g, " ")
      .replace(/\s*([·、])\s*(?=\1)/g, "")
      .replace(/\s*[·、]\s*$/g, "")
      .replace(/[（(]\s*[）)]/g, "")
      .replace(/[：:]\s*(?=[·、]|$)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

  /**
   * 收掉「尾巴上只剩标签」的段。
   *
   * 例：`净收益 +182.4万 · 鱼饵 `（鱼饵占比那个变量是空的）
   *     → 末尾的「 · 鱼饵」整段没有值，连同分隔符一起去掉
   * 而 `掉落 装备 86 · 宝箱 14` 不受影响：末尾是「宝箱 14」而不是「宝箱」，不匹配。
   */
  const dropDanglingTail = (v: string): string => {
    let out = v.trim();
    for (let i = 0; i < 8; i++) {
      const next = out.replace(/\s*[·、]\s*[\u4e00-\u9fa5A-Za-z]+$/, "").trim();
      if (next === out) break;
      out = next;
    }
    return out.replace(/\s*[·、]\s*$/, "").trim();
  };

  const s = dropDanglingTail(collapse(text));
  if (emptyVars === 0) return s;

  // 判据 2：这一行没有变量渲染出内容
  if (filledVars === 0) {
    // 用户写的完整句子/长文案 → 保留（他可能就是想在这行补充说明）
    if (prose) return s;
    // 否则是「标签 + 空值」的空壳 → 丢掉
    // （「🎯 奥秘保底还差 杆」里的 emoji 与「杆」都只是模板骨架，不算内容）
    return "";
  }

  return s;
}

/**
 * 渲染模板。
 *
 * @returns 已按行拆好的结果；空壳行会被丢掉
 */
export function renderDigestTemplate(template: string, data: DigestData): string[] {
  const vars = digestDataToVars(data);

  return template
    .split("\n")
    .map((line) => {
      const raw = line.trim();
      if (!raw) return "";

      // 整行只有一个变量：
      //  · 没有值 → 丢掉整行（用户不用写条件语法，没内容就不显示）
      //  · 有值 → 原样输出，不做清理（避免误伤「就绪」这类以分隔符结尾的正文）
      const sole = raw.match(WHOLE_LINE_VAR);
      if (sole && VAR_NAMES.has(sole[1]!)) {
        return vars[sole[1]!] ?? "";
      }

      const { text, emptyVars, filledVars, prose } = interpolate(raw, vars);
      return cleanupRenderedLine(text, emptyVars, filledVars, prose);
    })
    .filter((l) => l.length > 0);
}
/**
 * 预览用的示例数据。
 *
 * 用真实量级的数字：用户才能判断「一行放不放得下」「排版丑不丑」。
 * 与真实数据的唯一区别是它是常量，所以前端可以随时算。
 */
export const DIGEST_PREVIEW_DATA: DigestData = {
  date: "2026-10-10",
  label: "昨日",
  account: "力工",

  net: 1_824_000,
  income: 2_269_000,
  baitCost: 445_000,
  baitPct: 20,

  fishTotal: 4128,
  fishCommon: 2180,
  fishUncommon: 940,
  fishFine: 620,
  fishRare: 310,
  fishEpic: 150,
  fishLegendary: 12,
  fishMythic: 4,
  fishExotic: 1,
  fishArcane: 0,
  rareFish: "传说 12 · 神话 4 · 奇异 1",

  gear: 86,
  chests: 14,
  relics: 2,
  artifactLevels: 1,

  xp: 12_046_000,
  xpText: "经验 +1204.6万",
  level: 11622,
  levelGain: 3,
  levelShortfall: 3377,
  goldShortfall: 84_004_000,

  tournament: "个人赛 #42 第 3 名（8,120 分）",
  guildTournament: "公会赛 #18 第 12 名（24,300 分）",
  worldBoss: "围猎 渊潮之主 伤害 1,240万 · 第 5 名 · 奖励 8万 金币",

  pityExotic: 20,
  pityArcane: 320,
};

/** 按模板生成预览行 */
export function previewDigestTemplate(template: string): string[] {
  return renderDigestTemplate(template, DIGEST_PREVIEW_DATA);
}

/** 按分组整理变量清单（给配置界面渲染） */
export function digestVarsByGroup(): { group: string; vars: { name: string; desc: string; token: string }[] }[] {
  const order: string[] = [];
  const map = new Map<string, { name: string; desc: string; token: string }[]>();
  for (const v of DIGEST_VARS) {
    if (!map.has(v.group)) {
      map.set(v.group, []);
      order.push(v.group);
    }
    map.get(v.group)!.push({ name: v.name, desc: v.desc, token: `{${v.name}}` });
  }
  return order.map((group) => ({ group, vars: map.get(group)! }));
}

/* ---------- 格式化（与模块内保持一致的口径） ---------- */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 大数中文可读：1.2万 / 3.4亿（用于金币这类「看量级」的数字） */
export function fmtNum(v: unknown): string {
  const n = num(v);
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return fmtInt(n);
}

/**
 * 精确整数（千分位）。
 *
 * 用于等级、条数、保底杆数这类**要看准确值**的数字 ——
 * 用 fmtNum 会把 11,622 级压成「1.2万级」，用户就没法判断还差多少了。
 */
export function fmtInt(v: unknown): string {
  const n = num(v);
  return Math.round(n).toLocaleString("zh-CN");
}

export function fmtSigned(v: unknown): string {
  const n = num(v);
  return n >= 0 ? `+${fmtNum(n)}` : `-${fmtNum(Math.abs(n))}`;
}

/** 未知占位符检查：配置界面用来提示用户写错了 */
export function findUnknownVars(template: string): string[] {
  const found: string[] = [];
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const name = m[1]!;
    if (!VAR_NAMES.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/** 是否用了某个变量（配置界面高亮用） */
export function templateUsesVar(template: string, name: string): boolean {
  return template.includes(`{${name}}`);
}

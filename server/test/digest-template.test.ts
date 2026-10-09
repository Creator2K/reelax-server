// 日报模板：变量替换、空值清理、预览、变量清单
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIGEST_TEMPLATE,
  DIGEST_PREVIEW_DATA,
  DIGEST_VARS,
  digestDataToVars,
  digestVarsByGroup,
  findUnknownVars,
  previewDigestTemplate,
  renderDigestTemplate,
  templateUsesVar,
  type DigestData,
} from "../src/modules/daily-digest/template.ts";

const sample: DigestData = DIGEST_PREVIEW_DATA;

describe("变量清单", () => {
  it("数量足够多（用户要的是「多弄点变量、自定义程度高」）", () => {
    expect(DIGEST_VARS.length).toBeGreaterThanOrEqual(30);
  });

  it("名字唯一、都有说明与分组", () => {
    const names = DIGEST_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of DIGEST_VARS) {
      expect(v.desc, v.name).toBeTruthy();
      expect(v.group, v.name).toBeTruthy();
    }
  });

  it("★ 每个变量都真的能替换（不会出现在界面上却推不出值）", () => {
    const vars = digestDataToVars(sample);
    for (const v of DIGEST_VARS) {
      expect(vars[v.name], v.name).toBeDefined();
      // 模板里单独用这个变量，渲染结果必须不含未替换的占位符
      const lines = renderDigestTemplate(`值：{${v.name}}`, sample);
      for (const l of lines) expect(l, v.name).not.toContain(`{${v.name}}`);
    }
  });

  it("按分组整理后覆盖全部变量", () => {
    const groups = digestVarsByGroup();
    const total = groups.reduce((a, g) => a + g.vars.length, 0);
    expect(total).toBe(DIGEST_VARS.length);
    expect(groups.length).toBeGreaterThan(1);
  });
});

describe("默认模板", () => {
  it("渲染出来包含核心信息", () => {
    const out = previewDigestTemplate(DEFAULT_DIGEST_TEMPLATE).join("\n");
    expect(out).toContain("2026-10-10");
    expect(out).toContain("净收益");
    expect(out).toContain("经验");
    expect(out).toContain("等级");
    expect(out).toContain("鱼获");
    expect(out).toContain("高稀有度");
    expect(out).toContain("掉落");
  });

  it("默认模板用到的变量都存在", () => {
    expect(findUnknownVars(DEFAULT_DIGEST_TEMPLATE)).toEqual([]);
  });

  it("每一行都渲染成非空内容（默认模板不该出现空行）", () => {
    const lines = previewDigestTemplate(DEFAULT_DIGEST_TEMPLATE);
    for (const l of lines) expect(l.trim().length).toBeGreaterThan(0);
  });
});

describe("模板渲染", () => {
  it("替换已知变量", () => {
    expect(renderDigestTemplate("{account} {date}", sample)).toEqual(["力工 2026-10-10"]);
  });

  it("★ 不认识的变量原样保留（用户能看出写错了）", () => {
    expect(renderDigestTemplate("{date} {oops}", sample)).toEqual(["2026-10-10 {oops}"]);
  });

  it("★ 值为空的变量让整行消失（不需要条件语法）", () => {
    const noComp: DigestData = { ...sample, tournament: "", guildTournament: "", worldBoss: "" };
    const lines = renderDigestTemplate("{tournament}\n净收益 {netSigned}", noComp);
    expect(lines).toEqual(["净收益 +182.4万"]);
  });

  it("★ 变量为空时整行消失（有冒号没冒号都一样，不留孤零零的标签）", () => {
    const noRare: DigestData = { ...sample, rareFish: "" };
    expect(renderDigestTemplate("高稀有度：{rareFish}\n鱼获 {fishTotal} 条", noRare)).toEqual(["鱼获 4,128 条"]);
    expect(renderDigestTemplate("高稀有度 {rareFish}", noRare)).toEqual([]);
  });

  it("★ 同一行里还有别的值时只收掉空出来的尾巴", () => {
    const noBait: DigestData = { ...sample, baitCost: 0, baitPct: null };
    const lines = renderDigestTemplate("净收益 {netSigned} · 鱼饵 {baitPct}", noBait);
    // baitPct 为空 → 收掉尾巴的分隔符，前面的内容保留
    expect(lines).toEqual(["净收益 +182.4万"]);
  });

  it("★ 整行只有一个变量且为空时整行消失", () => {
    const noComp: DigestData = { ...sample, tournament: "" };
    const lines = renderDigestTemplate("净收益 {netSigned}\n{tournament}", noComp);
    expect(lines).toEqual(["净收益 +182.4万"]);
  });

  it("清理空的枚举段（不会出现「宝箱  · 遗物」这种双空格）", () => {
    const noChest: DigestData = { ...sample, chests: 0 };
    const lines = renderDigestTemplate("掉落 装备 {gear} · 宝箱 {chests} · 遗物 {relics}", noChest);
    // chests 是 0 而不是空串，所以这一段会保留为「宝箱 0」——这是有意的（0 是有意义的数据）
    expect(lines[0]).toContain("装备 86");
    expect(lines[0]).not.toMatch(/\s{2,}/);
  });

  it("纯空模板返回空数组", () => {
    expect(renderDigestTemplate("", sample)).toEqual([]);
    expect(renderDigestTemplate("   \n  ", sample)).toEqual([]);
  });

  it("多行模板保持顺序并丢掉空行", () => {
    const lines = renderDigestTemplate("第一行\n\n第二行\n第三行", sample);
    expect(lines).toEqual(["第一行", "第二行", "第三行"]);
  });

  it("数字类变量经过格式化（千分位 / 万）", () => {
    const lines = renderDigestTemplate("{fishTotal}|{net}", sample);
    expect(lines[0]).toBe("4,128|182.4万");
  });

  it("★ 纯中文行不会被误删（用户自己写的标题要保留）", () => {
    const lines = renderDigestTemplate("今日总结\n净收益 {netSigned}", sample);
    expect(lines).toEqual(["今日总结", "净收益 +182.4万"]);
  });

  it("★ 带 emoji 与固定文字的标签行，缺数据时整行消失（不留「还差 杆」）", () => {
    const noPity: DigestData = { ...sample, pityArcane: null, pityExotic: null };
    const lines = renderDigestTemplate("🎯 奥秘保底还差 {pityArcane} 杆\n鱼获 {fishTotal} 条", noPity);
    expect(lines).toEqual(["鱼获 4,128 条"]);
  });

  it("★ 用户自己写的长文案即使变量为空也保留（那是他补充的说明）", () => {
    const noXp: DigestData = { ...sample, xp: null, xpText: "" };
    const lines = renderDigestTemplate("今天真是丰收的一天 {xpText}", noXp);
    expect(lines).toEqual(["今天真是丰收的一天"]);
  });

  it("★ 用户写的完整句子（带句末标点）也保留", () => {
    const noXp: DigestData = { ...sample, xp: null, xpText: "" };
    const lines = renderDigestTemplate("今天很顺利。{xpText}", noXp);
    expect(lines).toEqual(["今天很顺利。"]);
  });

  it("★ 各种标签行在缺数据时都消失", () => {
    const empty: DigestData = {
      ...sample,
      xp: null,
      xpText: "",
      level: null,
      levelGain: null,
      levelShortfall: null,
      rareFish: "",
      tournament: "",
      guildTournament: "",
      worldBoss: "",
      pityArcane: null,
      baitPct: null,
    };
    const tpl = [
      "净收益 {netSigned}",
      "{xpText}",
      "等级 {level} 升 {levelGain}",
      "高稀有度 {rareFish}",
      "{tournament}",
      "{guildTournament}",
      "{worldBoss}",
      "🎯 奥秘保底还差 {pityArcane} 杆",
      "💰 净收益 {netSigned} · 鱼饵占 {baitPct}",
    ].join("\n");
    // 只剩「净收益」两行（一纯变量、一带值）
    expect(renderDigestTemplate(tpl, empty)).toEqual(["净收益 +182.4万", "💰 净收益 +182.4万"]);
  });

  it("缺失的成长数据渲染成空（不是 0 或 NaN）", () => {
    const noLevel: DigestData = { ...sample, level: null, levelGain: null, levelShortfall: null };
    const lines = renderDigestTemplate("等级 {level} 升 {levelGain} 还差 {levelShortfall}", noLevel);
    // 所有变量都空 → 只剩「等级 升 还差」这种空壳，整行丢掉
    expect(lines).toEqual([]);
  });

  it("缺失的成长数据用冒号写法时更干净", () => {
    const noLevel: DigestData = { ...sample, level: null, levelGain: null, levelShortfall: null };
    const lines = renderDigestTemplate("等级：{level}\n鱼获：{fishTotal}", noLevel);
    expect(lines).toEqual(["鱼获：4,128"]);
  });
});

describe("findUnknownVars / templateUsesVar", () => {
  it("列出不认识的变量并去重", () => {
    expect(findUnknownVars("{a} {b} {a}").sort()).toEqual(["a", "b"]);
  });

  it("默认模板没有未知变量", () => {
    expect(findUnknownVars(DEFAULT_DIGEST_TEMPLATE)).toEqual([]);
  });

  it("识别模板是否用了某个变量", () => {
    expect(templateUsesVar("净收益 {netSigned}", "netSigned")).toBe(true);
    expect(templateUsesVar("净收益 {net}", "netSigned")).toBe(false);
  });
});

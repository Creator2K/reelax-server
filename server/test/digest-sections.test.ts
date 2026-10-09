// 日报：分区配置、变量替换与预览
//
// 这组的价值在于「预览必须与真实产出同源」：
// 预览用的是同一份分区清单与同一套措辞，用户勾完之后看到的样子
// 就是明天早上推送的样子。这里钉住它们的一致性。
import { describe, expect, it } from "vitest";
import {
  DIGEST_SECTIONS,
  DIGEST_VARS,
  applyDigestVars,
  defaultDigestSections,
  digestSectionOptions,
  normalizeDigestSections,
  previewDigest,
} from "../src/modules/daily-digest/sections.ts";

describe("日报分区定义", () => {
  it("默认开启净收益、经验、等级、鱼获、高稀有度、掉落", () => {
    const d = defaultDigestSections();
    for (const id of ["income", "experience", "level", "fish", "rareFish", "drops"]) {
      expect(d, id).toContain(id);
    }
  });

  it("默认不开「全部稀有度」与「保底进度」（会让消息变长/只在冲保底时有用）", () => {
    const d = defaultDigestSections();
    expect(d).not.toContain("allRarities");
    expect(d).not.toContain("pity");
  });

  it("每项都有标签与说明，id 唯一", () => {
    const ids = DIGEST_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of DIGEST_SECTIONS) {
      expect(s.label, s.id).toBeTruthy();
      expect(s.hint, s.id).toBeTruthy();
    }
  });

  it("配置界面拿到的选项与服务端清单一致", () => {
    const opts = digestSectionOptions();
    expect(opts.map((o) => o.value)).toEqual(DIGEST_SECTIONS.map((s) => s.id));
  });
});

describe("normalizeDigestSections", () => {
  it("剔除不认识的 id（选项改名后旧配置不会让界面出现空白项）", () => {
    expect(normalizeDigestSections(["income", "removedSection", "drops"])).toEqual(["income", "drops"]);
  });

  it("去重并按定义顺序排列（顺序稳定，便于对比配置）", () => {
    expect(normalizeDigestSections(["drops", "income", "drops"])).toEqual(["income", "drops"]);
  });

  it("兼容逗号分隔的字符串写法", () => {
    expect(normalizeDigestSections("income, experience")).toEqual(["income", "experience"]);
  });

  it("空值 / 非法值返回空数组", () => {
    expect(normalizeDigestSections(null)).toEqual([]);
    expect(normalizeDigestSections(undefined)).toEqual([]);
    expect(normalizeDigestSections(123)).toEqual([]);
    expect(normalizeDigestSections({})).toEqual([]);
  });
});

describe("applyDigestVars（标题/结尾里的变量）", () => {
  const vars = { date: "2026-10-10", label: "昨日", account: "力工", net: "+1 万", fish: "10", xp: "+5" };

  it("替换已知变量", () => {
    expect(applyDigestVars("{account} {date} 战报", vars)).toBe("力工 2026-10-10 战报");
    expect(applyDigestVars("净收益 {net}", vars)).toBe("净收益 +1 万");
  });

  it("★ 不认识的占位符原样保留（不静默吞掉，用户能看出写错了）", () => {
    expect(applyDigestVars("{unknown} 保留", vars)).toBe("{unknown} 保留");
    expect(applyDigestVars("{date} {oops}", vars)).toBe("2026-10-10 {oops}");
  });

  it("没有占位符时原样返回", () => {
    expect(applyDigestVars("就是普通文字", vars)).toBe("就是普通文字");
  });

  it("多个变量与中文混排", () => {
    expect(applyDigestVars("{account}的{label}：{fish} 条", vars)).toBe("力工的昨日：10 条");
  });

  it("展示给用户的变量清单都真的能替换", () => {
    for (const v of DIGEST_VARS) {
      const out = applyDigestVars(v.name, vars);
      expect(out, v.name).not.toBe(v.name);
    }
  });
});

describe("previewDigest（预览）", () => {
  it("默认预览包含标题与默认分区", () => {
    const lines = previewDigest({ sections: defaultDigestSections() });
    expect(lines[0]).toContain("2026-10-10");
    expect(lines.join("\n")).toContain("净收益");
    expect(lines.join("\n")).toContain("等级");
  });

  it("★ 只勾一项时预览也只有那一项（勾选真的生效）", () => {
    const lines = previewDigest({ sections: ["income"] });
    const body = lines.slice(1).join("\n");
    expect(body).toContain("净收益");
    expect(body).not.toContain("鱼获");
    expect(body).not.toContain("等级");
  });

  it("全不选时只剩标题", () => {
    const lines = previewDigest({ sections: [] });
    expect(lines).toHaveLength(1);
  });

  it("每一个分区在预览里都有一行（不会出现勾了却没内容）", () => {
    for (const s of DIGEST_SECTIONS) {
      const lines = previewDigest({ sections: [s.id] });
      expect(lines.length, s.id).toBeGreaterThan(1);
    }
  });

  it("自定义标题与结尾会做变量替换", () => {
    const lines = previewDigest({ sections: ["income"], title: "{account} 战报", footer: "净收益 {net}" });
    expect(lines[0]).toBe("力工 战报");
    expect(lines.at(-1)).toBe("净收益 +182.4 万");
  });

  it("标题为空时用默认标题（昨日 · 日期）", () => {
    const lines = previewDigest({ sections: [], title: "   " });
    expect(lines[0]).toContain("昨日");
  });
});

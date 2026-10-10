// 定时配装：时间表解析、取值、目标解析
//
// 时间表是纯文本，写错一行不会报错（只是静默不生效），所以解析必须钉死：
// 全角冒号、注释、重复时刻、空配装槽、配装名对不上……每一条都会让用户
// 第二天早上才发现「装备没换」。
import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_LINES,
  describePlan,
  describeTarget,
  parsePlan,
  pickPlanEntry,
  resolveTarget,
  targetKey,
  type PlanEntry,
} from "../src/modules/auto-loadout/plan.ts";
import { describeLoadout, loadoutLabel, parseLoadouts, type Loadout } from "../src/modules/auto-loadout/loadout.ts";

/** 本地时间（断言 getHours/getMinutes 与容器时区无关） */
const at = (h: number, m = 0): Date => new Date(2026, 9, 10, h, m);

const entries = (text: string): PlanEntry[] => parsePlan(text).entries;

describe("parsePlan", () => {
  it("解析「HH:MM 配装号」与「HH:MM 配装名」", () => {
    const list = entries("09:00 1\n21:00 比赛套");
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ minutes: 540, at: "09:00", target: { kind: "slot", slot: 1 } });
    expect(list[1]).toMatchObject({ minutes: 1260, at: "21:00", target: { kind: "name", name: "比赛套" } });
  });

  it("按时间排序（顺序写反也一样）", () => {
    expect(entries("21:00 2\n09:00 1").map((e) => e.at)).toEqual(["09:00", "21:00"]);
  });

  it("容忍全角冒号、= / -> / → 分隔符与多余空格", () => {
    const list = entries("09：00 = 1\n21:00 -> 比赛套\n23:00→3\n07:05  4");
    expect(list.map((e) => e.target)).toEqual([
      { kind: "slot", slot: 4 },
      { kind: "slot", slot: 1 },
      { kind: "name", name: "比赛套" },
      { kind: "slot", slot: 3 },
    ]);
  });

  it("单数字小时与单数字分钟都认（9:5 → 09:05）", () => {
    expect(entries("9:5 1")[0]).toMatchObject({ at: "09:05", minutes: 545 });
  });

  it("忽略空行与 # / // 注释行", () => {
    const list = entries("\n# 白天用刷经验套\n09:00 1\n// 晚上换比赛套\n21:00 2\n   \n");
    expect(list).toHaveLength(2);
    expect(parsePlan("\n# 白天\n// x\n").entries).toEqual([]);
  });

  it("时间非法时报错并跳过该行", () => {
    const r = parsePlan("24:00 1\n09:60 1\n09:00 1");
    expect(r.entries).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toContain("时间非法");
  });

  it("看不懂的行、只写时间的行都会报错并跳过", () => {
    const r = parsePlan("早上九点 1\n09:00\n09:00 1");
    expect(r.entries).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toContain("看不懂");
    expect(r.errors[1]).toContain("没写配装号或配装名");
  });

  it("配装号超出范围（0 / 100）被拒", () => {
    const r = parsePlan("09:00 0\n10:00 100\n11:00 2");
    expect(r.entries.map((e) => e.at)).toEqual(["11:00"]);
    expect(r.errors).toHaveLength(2);
  });

  it("★ 同一时刻写两条：以最后一条为准（后写的覆盖）", () => {
    const r = parsePlan("09:00 1\n09:00 2");
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.target).toEqual({ kind: "slot", slot: 2 });
    expect(r.errors[0]).toContain("重复");
  });

  it("非字符串 / 空值当成空表", () => {
    expect(parsePlan(undefined).entries).toEqual([]);
    expect(parsePlan(null).entries).toEqual([]);
    expect(parsePlan(42).entries).toEqual([]);
  });

  it(`最多 ${MAX_PLAN_LINES} 行，超出的报错`, () => {
    const text = Array.from({ length: MAX_PLAN_LINES + 5 }, (_, i) => `${String(i % 24).padStart(2, "0")}:00 1`).join("\n");
    const r = parsePlan(text);
    expect(r.entries.length).toBeLessThanOrEqual(MAX_PLAN_LINES);
    expect(r.errors.some((e) => e.includes("最多"))).toBe(true);
  });
});

describe("pickPlanEntry（到点生效的里程碑）", () => {
  const list = entries("09:00 1\n21:00 2");

  it("到点那一刻就生效", () => {
    expect(pickPlanEntry(list, at(9, 0))?.target).toEqual({ kind: "slot", slot: 1 });
    expect(pickPlanEntry(list, at(21, 0))?.target).toEqual({ kind: "slot", slot: 2 });
  });

  it("两条之间用前一条", () => {
    expect(pickPlanEntry(list, at(14, 30))?.target).toEqual({ kind: "slot", slot: 1 });
  });

  it("★ 凌晨还没到第一条 → 沿用昨天最后生效的那条（不能没有配装）", () => {
    expect(pickPlanEntry(list, at(3, 0))?.target).toEqual({ kind: "slot", slot: 2 });
  });

  it("只有一条时全天都用它", () => {
    const one = entries("20:00 3");
    expect(pickPlanEntry(one, at(1, 0))?.target).toEqual({ kind: "slot", slot: 3 });
    expect(pickPlanEntry(one, at(23, 59))?.target).toEqual({ kind: "slot", slot: 3 });
  });

  it("空表返回 null", () => {
    expect(pickPlanEntry([], at(12))).toBeNull();
  });
});

describe("describeTarget / targetKey", () => {
  it("配装号与配装名的写法不同，用于判断「已经切过了」", () => {
    expect(describeTarget({ kind: "slot", slot: 2 })).toBe("2 号配装");
    expect(describeTarget({ kind: "name", name: "比赛套" })).toBe("「比赛套」");
    expect(targetKey({ kind: "slot", slot: 2 })).toBe("#2");
    expect(targetKey({ kind: "name", name: "比赛套" })).toBe("@比赛套");
  });
});

describe("parseLoadouts", () => {
  const data = {
    loadouts: [
      { slot: 2, name: "比赛套", gear: { head: { id: "g1" }, chest: { id: "g2" } }, stats: {} },
      { slot: 1, name: "刷经验", gear: { head: { id: "g3" }, chest: null }, stats: {} },
      { slot: 3, name: null, gear: {}, stats: {} },
      { slot: "x", name: "垃圾数据" },
      null,
    ],
  };

  it("按槽位排序，只数已知部位", () => {
    const list = parseLoadouts(data);
    expect(list.map((l) => l.slot)).toEqual([1, 2, 3]);
    expect(list[0]).toMatchObject({ name: "刷经验", filled: 1 });
    expect(list[1]).toMatchObject({ name: "比赛套", filled: 2 });
    expect(list[2]).toMatchObject({ name: null, filled: 0 });
  });

  it("响应形状不对时返回空数组（不抛错）", () => {
    expect(parseLoadouts(undefined)).toEqual([]);
    expect(parseLoadouts({})).toEqual([]);
    expect(parseLoadouts({ loadouts: "nope" })).toEqual([]);
  });

  it("标签写法", () => {
    const list = parseLoadouts(data);
    expect(loadoutLabel(list[0]!)).toBe("1 号「刷经验」");
    expect(loadoutLabel(list[2]!)).toBe("3 号（空）");
    expect(describeLoadout(list[1]!)).toBe("2 号「比赛套」（2 件）");
  });
});

describe("resolveTarget", () => {
  const list: Loadout[] = [
    { slot: 1, name: "刷经验", filled: 9, raw: {} },
    { slot: 2, name: "比赛套", filled: 9, raw: {} },
    { slot: 3, name: null, filled: 0, raw: {} },
  ];

  it("按配装号找到", () => {
    const r = resolveTarget({ kind: "slot", slot: 2 }, list);
    expect(r.ok && r.loadout.name).toBe("比赛套");
  });

  it("配装号不存在 → 说明原因并列出可用项", () => {
    const r = resolveTarget({ kind: "slot", slot: 9 }, list);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("没有 9 号配装");
    expect(!r.ok && r.reason).toContain("1 号「刷经验」");
  });

  it("★ 空配装槽被拒绝（装上去等于把装备全脱了）", () => {
    const r = resolveTarget({ kind: "slot", slot: 3 }, list);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("是空的");
  });

  it("按配装名精确匹配（忽略首尾空格）", () => {
    const r = resolveTarget({ kind: "name", name: " 比赛套 " }, list);
    expect(r.ok && r.loadout.slot).toBe(2);
  });

  it("配装名对不上 → 列出已有的配装名", () => {
    const r = resolveTarget({ kind: "name", name: "涌流套" }, list);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("没有叫「涌流套」的配装");
    expect(!r.ok && r.reason).toContain("比赛套");
  });

  it("一个配装都没存时给出可执行的提示", () => {
    const r = resolveTarget({ kind: "name", name: "涌流套" }, [{ slot: 1, name: null, filled: 0, raw: {} }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("还没有任何已保存的配装");
  });
});

describe("describePlan（配置预览）", () => {
  it("摊平时间表并标出「现在生效」的那条", () => {
    const lines = describePlan("09:00 1\n21:00 比赛套", at(14, 0), "Asia/Shanghai");
    expect(lines[0]).toContain("Asia/Shanghai");
    expect(lines[1]).toContain("09:00 起 → 1 号配装");
    expect(lines[1]).toContain("← 现在生效");
    expect(lines[2]).toContain("21:00 起 → 「比赛套」");
    expect(lines[2]).not.toContain("← 现在生效");
  });

  it("空表给出写法提示（否则用户以为功能坏了）", () => {
    const lines = describePlan("", at(14, 0), "Asia/Shanghai");
    expect(lines[0]).toContain("时间表是空的");
    expect(lines[1]).toContain("HH:MM");
  });

  it("解析错误原样展示出来", () => {
    const lines = describePlan("早上九点 1", at(14, 0), "Asia/Shanghai");
    expect(lines.some((l) => l.includes("看不懂"))).toBe(true);
  });
});

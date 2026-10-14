// order 字段类型（有序列表）：解析与校验
//
// ★ 为什么需要这个字段类型：像「换图优先级」这种配置，候选项每多一个，
//   「所有排列」的数量就阶乘增长（3 项 6 条、4 项 24 条、5 项 120 条），
//   做成 select 会把下拉框塞爆。order 把顺序本身当成值，前端用
//   「点候选加入 + 拖动/↑↓ 调序」渲染。
//
// 这里钉住两件事：
//   1. 顺序**必须原样保留**（multi-select 那种「按定义顺序重排」会毁掉配置语义）；
//   2. 兼容 1.7.x 存下来的逗号分隔字符串（老配置不能因此丢）。
import { describe, expect, it } from "vitest";
import {
  resolveModuleConfig,
  validateConfigPatch,
  type ModuleDefinition,
} from "../src/modules/types.ts";

const def = {
  id: "t",
  name: "测试模块",
  version: "1.0.0",
  description: "",
  defaultEnabled: false,
  defaultConfig: { plan: ["a", "b"] },
  configSchema: [
    {
      key: "plan",
      type: "order",
      label: "顺序",
      default: ["a", "b"],
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
    },
  ],
} as unknown as ModuleDefinition;

describe("order 字段：解析（resolveModuleConfig）", () => {
  it("数组原样保留顺序", () => {
    const r = resolveModuleConfig(def, { plan: ["c", "a"] });
    expect(r.config.plan).toEqual(["c", "a"]);
    expect(r.issues).toEqual([]);
  });

  it("★ 兼容 1.7.x 的逗号分隔字符串（老配置不丢）", () => {
    const r = resolveModuleConfig(def, { plan: "b,c,a" });
    expect(r.config.plan).toEqual(["b", "c", "a"]);
  });

  it("去重、丢不认识的项，并在 issues 里说明", () => {
    const r = resolveModuleConfig(def, { plan: ["a", "a", "surge", "c"] });
    expect(r.config.plan).toEqual(["a", "c"]);
    expect(r.issues[0]?.message).toContain("surge");
  });

  it("全被剔掉 / 类型不对 → 回到默认顺序", () => {
    expect(resolveModuleConfig(def, { plan: ["zzz"] }).config.plan).toEqual(["a", "b"]);
    expect(resolveModuleConfig(def, { plan: 123 }).config.plan).toEqual(["a", "b"]);
    expect(resolveModuleConfig(def, {}).config.plan).toEqual(["a", "b"]);
  });
});

describe("order 字段：校验（validateConfigPatch）", () => {
  it("★ 保留用户给的顺序（不是按定义顺序重排）", () => {
    const r = validateConfigPatch(def, { plan: ["c", "a"] });
    expect(r.errors).toEqual([]);
    expect(r.patch.plan).toEqual(["c", "a"]);
  });

  it("也接受逗号分隔字符串（前端旧版本 / 手工提交）", () => {
    const r = validateConfigPatch(def, { plan: "c,b" });
    expect(r.errors).toEqual([]);
    expect(r.patch.plan).toEqual(["c", "b"]);
  });

  it("不认识的项直接报错（不静默丢弃）", () => {
    const r = validateConfigPatch(def, { plan: ["a", "nope"] });
    expect(r.errors[0]?.message).toContain("nope");
    expect(r.patch.plan).toBeUndefined();
  });

  it("至少要留一项（空列表报错）", () => {
    const r = validateConfigPatch(def, { plan: [] });
    expect(r.errors[0]?.message).toContain("至少要选 1 项");
  });

  it("min 可调（比如要求至少两项）", () => {
    const two = {
      ...def,
      configSchema: [{ ...(def.configSchema[0] as object), min: 2 }],
    } as unknown as ModuleDefinition;
    expect(validateConfigPatch(two, { plan: ["a"] }).errors[0]?.message).toContain("至少要选 2 项");
    expect(validateConfigPatch(two, { plan: ["a", "b"] }).errors).toEqual([]);
  });
});

/* ---------------- order-number：顺序 + 数值 ---------------- */

const numDef = {
  id: "t2",
  name: "测试模块",
  version: "1.0.0",
  description: "",
  defaultEnabled: false,
  defaultConfig: {
    plan: [
      { key: "a", value: 10 },
      { key: "b", value: 0 },
    ],
  },
  configSchema: [
    {
      key: "plan",
      type: "order-number",
      label: "顺序与数值",
      default: [
        { key: "a", value: 10 },
        { key: "b", value: 0 },
      ],
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
      min: 0,
      max: 1000,
    },
  ],
} as unknown as ModuleDefinition;

describe("order-number 字段：解析", () => {
  it("★ 顺序原样保留，缺的项补在末尾（四维不会被静默漏掉）", () => {
    const r = resolveModuleConfig(numDef, { plan: [{ key: "c", value: 5 }] });
    expect(r.config.plan).toEqual([
      { key: "c", value: 5 },
      { key: "a", value: 10 },
      { key: "b", value: 0 },
    ]);
  });

  it("去重、丢不认识的键、数值取整并夹到边界", () => {
    const r = resolveModuleConfig(numDef, {
      plan: [
        { key: "a", value: 1.6 },
        { key: "a", value: 99 },
        { key: "zzz", value: 3 },
        { key: "b", value: 99_999 },
      ],
    });
    const plan = r.config.plan as { key: string; value: number }[];
    expect(plan.find((p) => p.key === "a")?.value).toBe(2);
    expect(plan.find((p) => p.key === "b")?.value).toBe(1000); // max 夹住
    expect(plan.some((p) => p.key === "zzz")).toBe(false);
    expect(r.issues.some((i) => String(i.message).includes("zzz"))).toBe(true);
  });

  it("兼容对象形式的历史写法 { a: 3 }", () => {
    const r = resolveModuleConfig(numDef, { plan: { b: 7 } });
    expect(r.config.plan).toEqual([
      { key: "b", value: 7 },
      { key: "a", value: 10 },
      { key: "c", value: 0 },
    ]);
  });

  it("非法数值按 0；类型完全不对 → 回到默认", () => {
    const bad = resolveModuleConfig(numDef, { plan: [{ key: "a", value: "abc" }] });
    expect((bad.config.plan as { key: string; value: number }[])[0]).toEqual({ key: "a", value: 0 });
    expect(resolveModuleConfig(numDef, { plan: 5 }).config.plan).toEqual(numDef.defaultConfig.plan);
  });
});

describe("order-number 字段：校验", () => {
  it("保留顺序与数值", () => {
    const r = validateConfigPatch(numDef, { plan: [{ key: "b", value: 3 }, { key: "a", value: 1 }] });
    expect(r.errors).toEqual([]);
    expect(r.patch.plan).toEqual([
      { key: "b", value: 3 },
      { key: "a", value: 1 },
      { key: "c", value: 0 },
    ]);
  });

  it("不认识的键报错（不静默丢弃）", () => {
    const r = validateConfigPatch(numDef, { plan: [{ key: "nope", value: 1 }] });
    expect(r.errors[0]?.message).toContain("nope");
  });
});

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

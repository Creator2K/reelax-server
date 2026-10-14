// 鱼饵补货判断测试
//
// ★ 这组测试的来源是一个真机 bug：余量字段被写成 `ownedQuantity`，
//   而 /api/baits 的真实字段是 `quantity`。写错的后果不是报错，而是
//   「每次检查都判定没饵 → 反复购买 200 个」，白花金币且日志刷屏。
//   这类接口契约错误只能靠测试钉住。
import { describe, expect, it } from "vitest";
import { BAIT_TIERS_NOTE, baitOptions } from "../src/modules/shared/rarity.ts";
import {
  baitDisplayName,
  baitPrice,
  decideRefill,
  describeBaitChoice,
  downgradeChain,
  extractBaits,
  findSelectedBait,
  isValidBaitId,
  needsCheaperBait,
  type BaitInfo,
} from "../src/modules/auto-bait/baits.ts";

const HIGH: BaitInfo = {
  id: "bait_high",
  name: "高级饵",
  tier: "high",
  unitPrice: 200,
  luck: 500,
  quantity: 0,
};

describe("extractBaits（接口包裹形式）", () => {
  it("认 baits / items / list 三种包裹", () => {
    expect(extractBaits({ baits: [HIGH] })).toHaveLength(1);
    expect(extractBaits({ items: [HIGH] })).toHaveLength(1);
    expect(extractBaits({ list: [HIGH] })).toHaveLength(1);
  });

  it("空响应 / 非法响应返回空数组（不抛错）", () => {
    expect(extractBaits(null)).toEqual([]);
    expect(extractBaits(undefined)).toEqual([]);
    expect(extractBaits({})).toEqual([]);
    expect(extractBaits({ baits: "nope" })).toEqual([]);
    expect(extractBaits({ baits: [null, undefined, HIGH] })).toHaveLength(1);
  });
});

describe("findSelectedBait", () => {
  it("认 isSelected / selected / isEquipped", () => {
    expect(findSelectedBait([HIGH, { id: "x", isSelected: true }])?.id).toBe("x");
    expect(findSelectedBait([HIGH, { id: "y", selected: true } as BaitInfo])?.id).toBe("y");
    expect(findSelectedBait([HIGH, { id: "z", isEquipped: true } as BaitInfo])?.id).toBe("z");
  });

  it("没有选中项时返回 null", () => {
    expect(findSelectedBait([HIGH])).toBeNull();
    expect(findSelectedBait([])).toBeNull();
  });
});

describe("decideRefill —— 补货策略", () => {
  it("★ 有库存时不买（这就是那个真机 bug：之前字段名写错，永远读成 0）", () => {
    const r = decideRefill({ ...HIGH, quantity: 200 }, { buyQuantity: 200 });
    expect(r.buy).toBe(false);
    expect(r.reason).toContain("200");
    expect(r.stock).toBe(200);
  });

  it("库存为 1 也不买（只要不是 0 就不补）", () => {
    expect(decideRefill({ ...HIGH, quantity: 1 }, { buyQuantity: 200 }).buy).toBe(false);
  });

  it("★ 库存为 0 时购买配置的数量", () => {
    const r = decideRefill({ ...HIGH, quantity: 0 }, { buyQuantity: 200 });
    expect(r.buy).toBe(true);
    if (r.buy) expect(r.quantity).toBe(200);
  });

  it("★ 用 ownedQuantity 当余量是无效的 —— 真实字段是 quantity", () => {
    // 构造一个只有错误字段名的对象：余量读不到 → 按 0 处理 → 会买。
    // 这条测试记录了「为什么当初会反复购买」。
    const wrongField = { id: "bait_high", unitPrice: 200, ownedQuantity: 999 } as unknown as BaitInfo;
    expect(decideRefill(wrongField, { buyQuantity: 200 }).buy).toBe(true);
    // 而带正确字段名的对象不会买
    expect(decideRefill({ ...wrongField, quantity: 999 }, { buyQuantity: 200 }).buy).toBe(false);
  });

  it("无限鱼饵（基础饵）不买", () => {
    const basic: BaitInfo = { id: "bait_basic", name: "基础饵", unitPrice: 0, quantity: 0, isUnlimited: true };
    const r = decideRefill(basic, { buyQuantity: 200 });
    expect(r.buy).toBe(false);
    expect(r.reason).toContain("无限");
    expect(r.stock).toBeNull();
  });

  it("单价 0 但没有 isUnlimited 标记也视为免费/无限，不买", () => {
    expect(decideRefill({ id: "x", unitPrice: 0, quantity: 0 }, { buyQuantity: 200 }).buy).toBe(false);
  });

  it("buyQuantity 为 0 / 缺失 / 非法 → 不自动购买", () => {
    for (const v of [0, undefined, null, "", "abc", -5]) {
      const r = decideRefill({ ...HIGH, quantity: 0 }, { buyQuantity: v });
      expect(r.buy, `buyQuantity=${String(v)}`).toBe(false);
    }
  });

  it("购买数量被夹在 1..5000", () => {
    const big = decideRefill({ ...HIGH, quantity: 0 }, { buyQuantity: 99999 });
    expect(big.buy).toBe(true);
    if (big.buy) expect(big.quantity).toBe(5000);

    const tiny = decideRefill({ ...HIGH, quantity: 0 }, { buyQuantity: 0.4 });
    // 0.4 向下取整成 0 → 视为未开启
    expect(tiny.buy).toBe(false);
  });

  it("quantity 是字符串也能正确解析", () => {
    expect(decideRefill({ ...HIGH, quantity: "150" as unknown as number }, { buyQuantity: 200 }).buy).toBe(false);
  });

  it("quantity 为负数/NaN 时按 0 处理（宁可买一次也别永远不补货）", () => {
    expect(decideRefill({ ...HIGH, quantity: -3 }, { buyQuantity: 200 }).buy).toBe(true);
    expect(decideRefill({ ...HIGH, quantity: Number.NaN }, { buyQuantity: 200 }).buy).toBe(true);
    expect(decideRefill({ ...HIGH, quantity: undefined }, { buyQuantity: 200 }).buy).toBe(true);
  });
});

describe("显示名与配置校验", () => {
  it("优先用游戏内档位中文名（即使接口 name 是英文）", () => {
    expect(baitDisplayName({ id: "bait_high", name: "High Bait" })).toBe("高级饵");
    expect(baitDisplayName({ id: "bait_supreme" })).toBe("顶级饵");
  });

  it("未知 id 退回接口给的名字，再退回 id", () => {
    expect(baitDisplayName({ id: "bait_unknown", name: "神秘饵" })).toBe("神秘饵");
    expect(baitDisplayName({ id: "bait_unknown" })).toBe("bait_unknown");
    expect(baitDisplayName(null)).toBe("未知");
  });

  it("describeBaitChoice 给出带单价与幸运的可读描述", () => {
    expect(describeBaitChoice("bait_high")).toContain("高级饵");
    expect(describeBaitChoice("bait_high")).toContain("200 金币");
    expect(describeBaitChoice("bait_high")).toContain("幸运 500");
    // 基础饵是免费的，不应出现「0 金币」
    expect(describeBaitChoice("bait_basic")).toContain("免费");
    expect(describeBaitChoice("")).toContain("未配置");
  });

  it("isValidBaitId 只认五个真实档位", () => {
    for (const id of ["bait_basic", "bait_low", "bait_medium", "bait_high", "bait_supreme"]) {
      expect(isValidBaitId(id), id).toBe(true);
    }
    for (const bad of ["bait_master", "high", "", null, undefined, "bait_ultra"]) {
      expect(isValidBaitId(bad), String(bad)).toBe(false);
    }
  });
});

describe("金币不足 → 降级阶梯", () => {
  const LIST: BaitInfo[] = [
    { id: "bait_basic", name: "基础饵", unitPrice: 0, isUnlimited: true, quantity: 0 },
    { id: "bait_low", name: "低级饵", unitPrice: 40, quantity: 0 },
    { id: "bait_medium", name: "中级饵", unitPrice: 100, quantity: 0 },
    { id: "bait_high", name: "高级饵", unitPrice: 200, quantity: 0 },
    { id: "bait_supreme", name: "顶级饵", unitPrice: 1000, quantity: 0 },
  ];

  it("★ 只往下走：顶级 → 高级 → 中级 → 低级 → 基础", () => {
    expect(downgradeChain("bait_supreme", LIST).map((b) => b.id)).toEqual([
      "bait_high",
      "bait_medium",
      "bait_low",
      "bait_basic",
    ]);
    expect(downgradeChain("bait_medium", LIST).map((b) => b.id)).toEqual(["bait_low", "bait_basic"]);
    expect(downgradeChain("bait_basic", LIST)).toEqual([]);
  });

  it("不在列表里的档位不会混进来（未解锁的饵游戏不下发）", () => {
    const partial = LIST.filter((b) => b.id !== "bait_low");
    expect(downgradeChain("bait_medium", partial).map((b) => b.id)).toEqual(["bait_basic"]);
  });

  it("不认识的饵按单价排（游戏以后加新档位不用改代码）", () => {
    const withNew = [...LIST, { id: "bait_ultra", name: "究极饵", unitPrice: 5000, quantity: 0 }];
    expect(downgradeChain("bait_ultra", withNew)[0]?.id).toBe("bait_supreme");
    // 接口没给单价时回落到内置表的价格
    expect(baitPrice({ id: "bait_high" })).toBe(200);
    expect(baitPrice({ id: "bait_high", unitPrice: 250 })).toBe(250);
  });

  it("认得出「该降级」的错误：错误码优先，文案兜底", () => {
    expect(needsCheaperBait({ code: "INSUFFICIENT_GOLD", message: "金币不足。" })).toBe(true);
    expect(needsCheaperBait({ code: "BAIT_NOT_OWNED" })).toBe(true);
    // 只有文案的版本（用户截图里就是这句）
    expect(needsCheaperBait(new Error("金币不足。"))).toBe(true);
    expect(needsCheaperBait(new Error("尚未拥有该鱼饵。"))).toBe(true);
    // 其它错误不该被当成余额问题
    expect(needsCheaperBait({ code: "RATE_LIMITED", message: "请求过于频繁" })).toBe(false);
    expect(needsCheaperBait(new Error("请求超时（10000ms）"))).toBe(false);
    expect(needsCheaperBait(null)).toBe(false);
  });
});

describe("baitOptions（下拉选项文案）", () => {
  it("★ 选项只留「名称（价格）」——之前的长文案会把下拉框挤破", () => {
    const opts = baitOptions();
    expect(opts.find((o) => o.value === "bait_high")?.label).toBe("高级饵（200 金币）");
    expect(opts.find((o) => o.value === "bait_basic")?.label).toBe("基础饵（免费）");
    expect(opts.find((o) => o.value === "bait_supreme")?.label).toBe("顶级饵（1000 金币）");
    for (const o of opts) expect(o.label.length).toBeLessThanOrEqual(12);
  });

  it("includeEmpty 时第一项是「不切换」", () => {
    const opts = baitOptions({ includeEmpty: true, emptyLabel: "不切换（沿用平时）" });
    expect(opts[0]).toEqual({ value: "", label: "不切换（沿用平时）" });
    expect(opts).toHaveLength(6);
  });

  it("幸运 / 稀有度加成改在字段说明里给出（信息没丢）", () => {
    expect(BAIT_TIERS_NOTE).toContain("幸运 500");
    expect(BAIT_TIERS_NOTE).toContain("×1.25");
    expect(BAIT_TIERS_NOTE).toContain("顶级饵 1000");
  });
});

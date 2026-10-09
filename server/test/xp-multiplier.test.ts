// 经验倍率与状态面板
//
// ★ 这里用**真实账号对账过的数字**做断言，而不是自造的期望值 ——
//   八分区相乘算错会显示成十分之一，但界面上看不出问题。
import { describe, expect, it } from "vitest";
import {
  SHOP_SOURCES,
  EVENT_SOURCES,
  SECTION_LABELS,
  buildStatusPanel,
  totalXpMultiplier,
  type XpSections,
} from "../src/modules/keep-online/status-panel.ts";
import {
  WEATHER_XP_MULTIPLIER,
  WEATHER_NAMES,
  bpToMultiplier,
  parsePercentFromText,
  weatherMultiplier,
  weatherName,
} from "../src/modules/keep-online/xp-multiplier.ts";

describe("天气倍率常量表", () => {
  it("九种天气的倍率固定（不能从文本反推）", () => {
    expect(WEATHER_XP_MULTIPLIER).toEqual({
      clear: 1,
      rain: 1.05,
      gale: 1.1,
      mist: 1.2,
      heatwave: 1.3,
      tempest: 1.5,
      wither_tide: 0.5,
      gilded_current: 0.75,
      arcane_surge: 1.75,
    });
  });

  it("★ 金风与枯潮的文本里没有「经验」二字，倍率必须靠表", () => {
    // 这两个是最容易踩的坑：文本是「每杆直接金币区间 +300~500」之类，反推会得到 0
    expect(parsePercentFromText("每杆直接金币区间 +300~500")).toBe(0);
    expect(weatherMultiplier("gilded_current")).toBe(0.75);
    expect(weatherMultiplier("wither_tide")).toBe(0.5);
  });

  it("未知天气按 1 倍处理", () => {
    expect(weatherMultiplier("nope")).toBe(1);
    expect(weatherMultiplier(null)).toBe(1);
    expect(weatherMultiplier(undefined)).toBe(1);
  });

  it("天气中文名齐全", () => {
    for (const id of Object.keys(WEATHER_XP_MULTIPLIER)) {
      expect(WEATHER_NAMES[id], id).toBeTruthy();
      expect(weatherName(id)).toBe(WEATHER_NAMES[id]);
    }
  });

  it("万分比换算", () => {
    expect(bpToMultiplier(0)).toBe(1);
    expect(bpToMultiplier(10000)).toBe(2);
    expect(bpToMultiplier(-5000)).toBe(0.5);
    expect(bpToMultiplier(undefined)).toBe(1);
  });

  it("parsePercentFromText 只用于非权威场景", () => {
    expect(parsePercentFromText("+20% 经验")).toBe(20);
    expect(parsePercentFromText("无修正")).toBe(0);
    expect(parsePercentFromText("")).toBe(0);
  });
});

describe("totalXpMultiplier（八分区相乘）", () => {
  const zero: XpSections = {
    permanentBp: 0,
    artifactBp: 0,
    weatherBp: 0,
    wisdomBp: 0,
    guildBp: 0,
    partyBp: 0,
    shopBp: 0,
    eventBp: 0,
  };

  it("全 0 时是 1 倍", () => {
    expect(totalXpMultiplier(zero)).toBe(1);
  });

  it("单分区 +100% 就是 2 倍", () => {
    expect(totalXpMultiplier({ ...zero, wisdomBp: 10_000 })).toBe(2);
  });

  it("★ 是相乘而不是相加（相加会差一个数量级）", () => {
    const sections: XpSections = { ...zero, wisdomBp: 10_000, shopBp: 10_000 };
    expect(totalXpMultiplier(sections)).toBe(4); // (1+1)×(1+1)，不是 1+1+1=3
  });

  it("负加成（枯潮）参与相乘", () => {
    // 天气 -50% → 0.5；智力 +100% → 2；合计 1.0
    expect(totalXpMultiplier({ ...zero, weatherBp: -5000, wisdomBp: 10_000 })).toBeCloseTo(1, 6);
  });

  it("★ 真实账号对账：文档里那组数字必须得到 ×34.41 左右", () => {
    // 智力 20587 / 专精 3150 + 天赋 2500 / 神器 60 / 公会图腾 1500 + 区域 5000
    // 天气雨幕（+5%）/ 商店 15000 / 活动 6500
    const sections: XpSections = {
      permanentBp: 3150 + 2500,
      artifactBp: 60,
      weatherBp: Math.round((1.05 - 1) * 10_000),
      wisdomBp: 20587,
      guildBp: 1500 + 5000,
      partyBp: 0,
      shopBp: 15000,
      eventBp: 6500,
    };
    const total = totalXpMultiplier(sections);
    // 游戏内显示 ×34.41（四舍五入到两位）
    expect(total).toBeCloseTo(34.41, 1);
    expect(total.toFixed(2)).toBe("34.41");
  });

  it("分区中文名齐全（前端展示用）", () => {
    for (const key of Object.keys(zero)) {
      expect(SECTION_LABELS[key as keyof XpSections], key).toBeTruthy();
    }
  });

  it("商店与活动的来源口径（决定 Buff 归到哪个分区）", () => {
    expect(SHOP_SOURCES).toEqual(["player_shop", "personal_shop"]);
    expect(EVENT_SOURCES).toEqual(["admin_event", "reincarnation_catch_up"]);
    // 两类不重叠，否则同一个 Buff 会被算两次
    for (const s of SHOP_SOURCES) expect(EVENT_SOURCES).not.toContain(s);
  });
});

describe("buildStatusPanel", () => {
  const biomes = new Map<string, any>([
    ["b_009", { id: "b_009", name: "极昼冰湾", valueMultiplier: 1.4, weather: { weatherId: "arcane_surge", name: "奥秘涌流" } }],
    ["b_012", { id: "b_012", name: "熔潮环礁", valueMultiplier: 1.2 }],
  ]);

  const makeState = (over: Record<string, unknown> = {}) => ({
    run: {
      id: "run-1",
      biomeId: "b_009",
      effects: {
        mapXpBonusBasisPoints: 3150,
        globalXpBonusBasisPoints: 2500,
        artifactExperienceBonusBasisPoints: 60,
        guild: { experienceBonusBasisPoints: 1500, biomeBoostExperienceBasisPoints: 5000 },
      },
      ...(over.run as object),
    },
    activeBuffs: [
      { buffType: "experience", status: "active", displayTag: "万流共鸣", bonusBasisPoints: 5000, source: "player_shop" },
      { buffType: "experience", status: "active", displayTag: "国庆活动", bonusBasisPoints: 6500, source: "admin_event" },
      { buffType: "experience", status: "expired", displayTag: "已过期", bonusBasisPoints: 9999, source: "player_shop" },
      { buffType: "luck", status: "active", displayTag: "运气类", bonusBasisPoints: 999, source: "player_shop" },
    ],
    guildBiomeBoosts: [{ biomeId: "b_012", experienceBonusBasisPoints: 5000, endsAt: "2026-10-10T00:00:00.000Z" }],
    lastResult: { partyBonusBasisPoints: 1000 },
    party: { isInParty: true, boatName: "芦汐轻舟", boatBiomeId: "b_012", canChangeBoatBiome: false },
    ...over,
  });

  const makeMe = () => ({
    player: {
      level: 4649,
      experience: 6_991_726,
      experienceToNextLevel: 15_487_432,
      gold: 30_410_187,
      relics: 24_157,
      fragments: 648,
      selectedBaitId: "bait_high",
      stats: { total: { intelligence: 20587 } },
      reincarnation: { round: 2 },
    },
  });

  it("组装出完整面板", () => {
    const panel = buildStatusPanel({
      state: makeState(),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: {
        preview: {
          requiredLevel: 15000,
          levelBefore: 4649,
          levelShortfall: 10351,
          goldCost: 100_000_000,
          goldShortfall: 69_585_881,
          awardedPoints: 20,
          eligible: false,
        },
        arcaneFish: 9,
      },
      bait: { id: "bait_high", name: "高级饵", unitPrice: 100 },
    });

    expect(panel.biomeId).toBe("b_009");
    expect(panel.biomeName).toBe("极昼冰湾");
    expect(panel.valueMultiplier).toBe(1.4);
    expect(panel.weatherId).toBe("arcane_surge");
    expect(panel.weatherName).toBe("奥秘涌流");
    expect(panel.weatherXpPct).toBe(75);
    expect(panel.level).toBe(4649);
    expect(panel.reincarnation?.levelShortfall).toBe(10351);
    expect(panel.reincarnation?.eligible).toBe(false);
    expect(panel.baitName).toBe("高级饵");
    expect(panel.guildBoosts).toHaveLength(1);
    expect(panel.guildBoosts[0]?.name).toBe("熔潮环礁");
  });

  it("Buff 按来源正确拆成商店 / 活动两个分区", () => {
    const panel = buildStatusPanel({
      state: makeState(),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: null,
      bait: null,
    });
    // 只统计 buffType === experience 且未过期的：5000（商店）+ 6500（活动）
    expect(panel.buffXpBp).toBe(11_500);
    expect(panel.shopBp).toBe(5000);
    expect(panel.eventBp).toBe(6500);
    // 过期与运气类都不计入
    expect(panel.buffs).toHaveLength(2);
  });

  it("智力封顶 100000（游戏公式）", () => {
    const me = makeMe();
    me.player.stats.total.intelligence = 999_999;
    const panel = buildStatusPanel({ state: makeState(), biomesById: biomes, me, reincarnation: null, bait: null });
    expect(panel.wisdomBp).toBe(100_000);
  });

  it("guildBp 是图腾 + 区域之和；两者也分别保留", () => {
    const panel = buildStatusPanel({
      state: makeState(),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: null,
      bait: null,
    });
    expect(panel.guildBp).toBe(1500);
    expect(panel.guildBiomeBoostBp).toBe(5000);
    expect(panel.sections.guildBp).toBe(6500);
  });

  it("permanentBp = 专精 + 天赋", () => {
    const panel = buildStatusPanel({
      state: makeState(),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: null,
      bait: null,
    });
    expect(panel.sections.permanentBp).toBe(3150 + 2500);
    expect(panel.masteryBp).toBe(3150);
    expect(panel.talentBp).toBe(2500);
  });

  it("船队分区取自 lastResult，并给出船队现状", () => {
    const panel = buildStatusPanel({
      state: makeState(),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: null,
      bait: null,
    });
    expect(panel.partyBp).toBe(1000);
    expect(panel.fleet?.boatName).toBe("芦汐轻舟");
    expect(panel.fleet?.boatBiomeName).toBe("熔潮环礁");
    expect(panel.fleet?.sameAsCurrent).toBe(false);
  });

  it("天气倍率进入总倍率（奥秘涌流 ×1.75）", () => {
    const panel = buildStatusPanel({
      state: makeState(),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: null,
      bait: null,
    });
    // 手工核算
    const expected =
      bpToMultiplier(3150 + 2500) *
      bpToMultiplier(60) *
      bpToMultiplier(7500) *
      bpToMultiplier(20587) *
      bpToMultiplier(6500) *
      bpToMultiplier(1000) *
      bpToMultiplier(5000) *
      bpToMultiplier(6500);
    expect(panel.xpTotal).toBeCloseTo(expected, 8);
    // 天气这一项确实是 +75%
    expect(panel.weatherXpPct).toBe(75);
    expect(panel.sections.weatherBp).toBe(7500);
  });

  it("缺字段时不崩（游戏改版/接口不全的兜底）", () => {
    const panel = buildStatusPanel({
      state: {},
      biomesById: new Map(),
      me: null,
      reincarnation: null,
      bait: null,
    });
    expect(panel.xpTotal).toBe(1);
    expect(panel.biomeId).toBeNull();
    expect(panel.level).toBeNull();
    expect(panel.reincarnation).toBeNull();
    expect(panel.fleet).toBeNull();
    expect(panel.guildBoosts).toEqual([]);
  });

  it("没有船队时 fleet 为 null", () => {
    const panel = buildStatusPanel({
      state: makeState({ party: { isInParty: false } }),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: null,
      bait: null,
    });
    expect(panel.fleet).toBeNull();
  });

  it("鱼饵优先用当前选中，其次回退到玩家资料", () => {
    const withBait = buildStatusPanel({
      state: makeState(),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: null,
      bait: { id: "bait_supreme", name: "顶级饵", unitPrice: 500 },
    });
    expect(withBait.baitId).toBe("bait_supreme");

    const withoutBait = buildStatusPanel({
      state: makeState(),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: null,
      bait: null,
    });
    expect(withoutBait.baitId).toBe("bait_high");
    expect(withoutBait.baitName).toBeNull();
  });

  it("带上面板生成时间", () => {
    const panel = buildStatusPanel({
      state: makeState(),
      biomesById: biomes,
      me: makeMe(),
      reincarnation: null,
      bait: null,
    });
    expect(panel.at).toBeTypeOf("number");
    expect(panel.at).toBeLessThanOrEqual(Date.now());
  });
});

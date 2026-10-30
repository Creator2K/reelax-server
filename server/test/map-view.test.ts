// 「地图与天气」面板的数据组装 + 换图校验（纯函数）
//
// 这块决定界面上显示什么、点了换图会被什么理由拒绝 —— 判错会让用户以为
// 「天气/比赛状态不对」或「明明能切却被拦」。所以逐条覆盖。
import { describe, expect, it } from "vitest";
import {
  buildCompetitionMarks,
  buildMapsView,
  checkTravel,
  countdownText,
  COMPETITION_SOON_MS,
  type MapItemView,
} from "../src/services/map-view.ts";

const RAW = [
  {
    id: "b_001",
    name: "月落溪谷",
    isUnlocked: true,
    isCurrent: true,
    valueMultiplier: 1,
    weather: { weatherId: "clear" },
    activeCompetitions: [],
  },
  {
    id: "b_012",
    name: "熔潮环礁",
    isUnlocked: true,
    isCurrent: false,
    valueMultiplier: 1.55,
    weather: { weatherId: "tempest" },
    activeCompetitions: [{ id: "c1" }],
  },
  {
    id: "b_015",
    name: "星渊圣海",
    isUnlocked: false,
    isCurrent: false,
    // 故意不给 requiredLevel / unlockCost：应该用内置地图表兜底
    weather: { weatherId: "gilded_current" },
  },
];

describe("buildMapsView", () => {
  it("★ 天气、鱼价值、比赛标记、当前地图都摊平出来", () => {
    const view = buildMapsView({
      biomes: RAW,
      myCompetitionBiomes: new Map([["b_012", "个人赛 #7 进行中"]]),
      party: null,
    });

    expect(view.currentBiomeId).toBe("b_001");
    expect(view.current?.name).toBe("月落溪谷");
    expect(view.maps).toHaveLength(3);

    const storm = view.maps.find((m) => m.id === "b_012")!;
    expect(storm.weather).toEqual({ id: "tempest", name: "雷暴", xpMultiplier: 1.5 });
    expect(storm.valueMultiplier).toBe(1.55);
    expect(storm.competitionActive).toBe(true);
    expect(storm.myCompetition).toBe("个人赛 #7 进行中");

    const home = view.maps.find((m) => m.id === "b_001")!;
    expect(home.isCurrent).toBe(true);
    expect(home.competitionActive).toBe(false);
    expect(home.myCompetition).toBeNull();
  });

  it("uses top-level currentBiomeId when per-map isCurrent is missing", () => {
    const biomes = RAW.map(({ isCurrent: _isCurrent, ...b }) => b);
    const view = buildMapsView({
      biomes,
      myCompetitionBiomes: new Map(),
      party: null,
      currentBiomeId: "b_012",
    });
    expect(view.currentBiomeId).toBe("b_012");
    expect(view.current?.id).toBe("b_012");
  });

  it("★ 没给解锁信息的图用内置表兜底（否则界面显示不出「需 Lv / 花费」）", () => {
    const locked = buildMapsView({ biomes: RAW, myCompetitionBiomes: new Map(), party: null }).maps.find(
      (m) => m.id === "b_015",
    )!;
    expect(locked.isUnlocked).toBe(false);
    expect(locked.requiredLevel).toBe(10_000);
    expect(locked.unlockCost).toBe(13_000_000);
    // 天气名字也来自本地表
    expect(locked.weather?.name).toBe("金风");
  });

  it("接口没给 weather 时为 null（不瞎编）", () => {
    const view = buildMapsView({ biomes: [{ id: "b_003", name: "镜潮海岸" }], myCompetitionBiomes: new Map(), party: null });
    expect(view.maps[0]?.weather).toBeNull();
  });

  it("船队状态原样带出来（界面据此决定要不要给「带队一起走」）", () => {
    const party = { inParty: true, canChangeBoatBiome: true, boatName: "奥潮远洋舰", boatBiomeId: "b_012" };
    expect(buildMapsView({ biomes: RAW, myCompetitionBiomes: new Map(), party }).party).toEqual(party);
  });

  it("忽略没有 id 的条目", () => {
    const view = buildMapsView({ biomes: [null, {}, { id: "b_002", name: "雾语湿地" }], myCompetitionBiomes: new Map(), party: null });
    expect(view.maps.map((m) => m.id)).toEqual(["b_002"]);
  });
});

describe("checkTravel（换图前的校验）", () => {
  const map = (over: Partial<MapItemView> = {}): MapItemView => ({
    id: "b_012",
    name: "熔潮环礁",
    isUnlocked: true,
    isCurrent: false,
    valueMultiplier: 1.55,
    weather: null,
    competitionActive: false,
    myCompetition: null,
    requiredLevel: 5500,
    unlockCost: 8_000_000,
    ...over,
  });
  const CAPTAIN = { inParty: true, canChangeBoatBiome: true, boatName: "船", boatBiomeId: "b_001" };
  const CREW = { inParty: true, canChangeBoatBiome: false, boatName: "船", boatBiomeId: "b_001" };

  it("可以换图时返回 ok", () => {
    expect(checkTravel({ biome: map(), party: null, mode: "solo" })).toEqual({ ok: true });
  });

  it("地图不存在 / 没解锁 / 已经在那儿 → 各自给出可读原因", () => {
    const missing = checkTravel({ biome: null, party: null, mode: "solo" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("MAP_NOT_FOUND");

    const locked = checkTravel({ biome: map({ isUnlocked: false }), party: null, mode: "solo" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.code).toBe("BIOME_LOCKED");
      expect(locked.message).toContain("需 Lv 5500");
      expect(locked.message).toContain("8,000,000");
    }

    const there = checkTravel({ biome: map({ isCurrent: true }), party: null, mode: "solo" });
    expect(there.ok).toBe(false);
    if (!there.ok) expect(there.code).toBe("ALREADY_THERE");
  });

  it("★ 带队换图要求「在船队里 + 有改航线权限」", () => {
    const noParty = checkTravel({ biome: map(), party: null, mode: "party" });
    expect(noParty.ok).toBe(false);
    if (!noParty.ok) expect(noParty.code).toBe("NOT_IN_PARTY");

    const crew = checkTravel({ biome: map(), party: CREW, mode: "party" });
    expect(crew.ok).toBe(false);
    if (!crew.ok) expect(crew.code).toBe("NOT_CAPTAIN");

    expect(checkTravel({ biome: map(), party: CAPTAIN, mode: "party" })).toEqual({ ok: true });
  });

  it("个人换图不要求船队权限", () => {
    expect(checkTravel({ biome: map(), party: CREW, mode: "solo" })).toEqual({ ok: true });
  });
});

describe("countdownText（距开赛多久）", () => {
  it("小于 1 小时说分钟，超过 1 小时说「x 小时 y 分钟」", () => {
    expect(countdownText(42 * 60_000)).toBe("42 分钟后开赛");
    expect(countdownText(60 * 60_000)).toBe("1 小时后开赛");
    expect(countdownText(80 * 60_000)).toBe("1 小时 20 分钟后开赛");
    // 已到点（状态还没转 active）不显示负数
    expect(countdownText(-5_000)).toBe("马上开赛");
  });
});

describe("buildCompetitionMarks（我报名的比赛在哪张图）", () => {
  const now = Date.parse("2026-10-14T22:00:00+08:00");
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

  it("★ 即将开赛的只显示 2 小时以内的，并带上距开赛时间", () => {
    const marks = buildCompetitionMarks({
      personal: {
        current: null,
        upcoming: [
          { sequence: 1307, isRegistered: true, status: "scheduled", startAt: at(30), assignedBiomeId: "b_005" },
          { sequence: 1308, isRegistered: true, status: "scheduled", startAt: at(60 * 5), assignedBiomeId: "b_003" },
        ],
      },
      guild: null,
      now,
    });

    expect(marks.get("b_005")).toBe("个人赛 #1307 · 30 分钟后开赛");
    // 5 小时后开赛 → 不上面板（COMPETITION_SOON_MS = 2 小时）
    expect(marks.has("b_003")).toBe(false);
    expect(COMPETITION_SOON_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("★ 进行中的照常显示（不受 2 小时窗口限制）", () => {
    const marks = buildCompetitionMarks({
      personal: { current: { sequence: 9, isRegistered: true, status: "active", assignedBiomeId: "b_012" }, upcoming: [] },
      guild: null,
      now,
    });
    expect(marks.get("b_012")).toBe("个人赛 #9 进行中");
  });

  it("没报名的不算；公会赛看 entryStatus", () => {
    const marks = buildCompetitionMarks({
      personal: { current: null, upcoming: [{ sequence: 1, status: "scheduled", startAt: at(10), assignedBiomeId: "b_001" }] },
      guild: { current: { sequence: 2, entryStatus: "joined", status: "scheduled", startAt: at(20), assignedBiomeId: "b_002" } },
      now,
    });
    expect(marks.has("b_001")).toBe(false);
    expect(marks.get("b_002")).toBe("公会赛 #2 · 20 分钟后开赛");
  });

  it("★ 历史场次（开赛时间已过去很久）不显示 —— 否则会永远挂在图上", () => {
    const marks = buildCompetitionMarks({
      personal: {
        current: null,
        upcoming: [{ sequence: 3, isRegistered: true, status: "scheduled", startAt: at(-60 * 24), assignedBiomeId: "b_004" }],
      },
      guild: null,
      now,
    });
    expect(marks.size).toBe(0);
  });

  it("已结束 / 状态不认识 / 没有地图的场次都跳过", () => {
    const marks = buildCompetitionMarks({
      personal: {
        current: null,
        upcoming: [
          { sequence: 4, isRegistered: true, status: "ended", startAt: at(10), assignedBiomeId: "b_004" },
          { sequence: 5, isRegistered: true, status: "weird", startAt: at(10), assignedBiomeId: "b_005" },
          { sequence: 6, isRegistered: true, status: "scheduled", startAt: at(10) },
          { sequence: 7, isRegistered: true, status: "scheduled", assignedBiomeId: "b_006" },
        ],
      },
      guild: null,
      now,
    });
    expect(marks.size).toBe(0);
  });

  it("同一张图上进行中的比赛优先于「即将开赛」", () => {
    const marks = buildCompetitionMarks({
      personal: { current: { sequence: 8, isRegistered: true, status: "active", assignedBiomeId: "b_007" }, upcoming: [] },
      guild: {
        current: null,
        upcoming: [{ sequence: 9, entryStatus: "joined", status: "scheduled", startAt: at(15), assignedBiomeId: "b_007" }],
      },
      now,
    });
    expect(marks.get("b_007")).toBe("个人赛 #8 进行中");
  });
});

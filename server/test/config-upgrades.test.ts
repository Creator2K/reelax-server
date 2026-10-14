// 一次性配置升级：旧键换算成新键并**删除旧键**
//
// ★ 为什么值得单独测：这类换算只在用户升级后跑一次，写错了很难被发现 ——
//   要么把用户的配置静默改错（卖错东西 / 献错鱼），要么旧键残留导致
//   模块里的兼容分支永久生效（1.8.0 的「跟船队走」就再也删不掉）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { createRepos, type Repos } from "../src/db/repositories/index.ts";
import { upgradeModuleConfigs } from "../src/modules/config-upgrades.ts";

let db: Db;
let repos: Repos;
let accountId: string;

beforeEach(() => {
  db = openDb(":memory:");
  db.migrate();
  repos = createRepos(db);
  const user = repos.users.create({
    email: "up@example.com",
    passwordHash: "scrypt$N=32768,r=8,p=1$c2FsdA$aGFzaA",
    displayName: "up",
    role: "user",
    status: "approved",
  });
  accountId = repos.accounts.create({
    userId: user.id,
    label: "号",
    authType: "cookie",
    email: "up@example.com",
    passwordEnc: null,
    cookieEnc: "x",
    baseUrl: "https://reelax.cn",
    proxyId: null,
    autoStart: false,
  }).id;
});

afterEach(() => {
  db.close();
});

const write = (moduleId: string, config: Record<string, unknown>) => {
  repos.modules.upsert(accountId, moduleId, { config });
};

const read = (moduleId: string) => repos.modules.find(accountId, moduleId)?.config ?? {};

describe("配置升级：自动切图（fleetMode → 优先级列表）", () => {
  it("★ fleetMode=follow 并到列表最前，并删掉旧键", () => {
    write("auto-travel", { fleetMode: "follow", priorities: ["golden", "experience"] });
    const report = upgradeModuleConfigs(repos);

    expect(report.changed).toHaveLength(1);
    const cfg = read("auto-travel");
    expect(cfg.priorities).toEqual(["follow", "golden", "experience"]);
    expect("fleetMode" in cfg).toBe(false); // ★ 关键：旧键必须消失，否则运行时兼容会永久生效
  });

  it("fleetMode=solo（默认）只删旧键，不动优先级", () => {
    write("auto-travel", { fleetMode: "solo", priorities: "golden,competition" });
    upgradeModuleConfigs(repos);

    const cfg = read("auto-travel");
    expect(cfg.priorities).toEqual(["golden", "competition"]);
    expect("fleetMode" in cfg).toBe(false);
  });

  it("再跑一次不会重复动手（幂等）", () => {
    write("auto-travel", { fleetMode: "follow", priorities: ["golden"] });
    expect(upgradeModuleConfigs(repos).changed).toHaveLength(1);
    expect(upgradeModuleConfigs(repos).changed).toHaveLength(0);
    expect(read("auto-travel").priorities).toEqual(["follow", "golden"]);
  });
});

describe("配置升级：自动卖装备（阈值 → 勾选集合）", () => {
  it("★ sellBelow=legendary 换算成「低于传说的全部档位」，并删掉两个旧键", () => {
    write("auto-sell-gear", { sellBelow: "legendary", dismantleUpTo: "", maxPerRun: 50 });
    upgradeModuleConfigs(repos);

    const cfg = read("auto-sell-gear");
    expect(cfg.sellRarities).toEqual(["common", "uncommon", "fine", "rare", "epic"]);
    expect(cfg.dismantleRarities).toEqual([]);
    expect("sellBelow" in cfg).toBe(false);
    expect("dismantleUpTo" in cfg).toBe(false);
    expect(cfg.maxPerRun).toBe(50); // 其它配置原样保留
  });

  it("★ dismantleUpTo 换算成「可分解档位里落在区间内的那些」", () => {
    write("auto-sell-gear", { sellBelow: "epic", dismantleUpTo: "exotic" });
    upgradeModuleConfigs(repos);

    const cfg = read("auto-sell-gear");
    // sellBelow=史诗 → 出售 = 普通/罕见/精良/稀有；分解区间 [史诗, 奇异] ∩ 可分解 = 传说/神话/奇异
    expect(cfg.sellRarities).toEqual(["common", "uncommon", "fine", "rare"]);
    expect(cfg.dismantleRarities).toEqual(["legendary", "mythic", "exotic"]);
  });

  it("没配过阈值的账号不动", () => {
    write("auto-sell-gear", { sellRarities: ["common"], dryRun: true });
    expect(upgradeModuleConfigs(repos).changed).toHaveLength(0);
    expect(read("auto-sell-gear").sellRarities).toEqual(["common"]);
  });
});

describe("配置升级：自动专精献祭（excludeBelow → 献祭模式）", () => {
  it("★ 旧默认 common（从没动过这一项）→ 换成新默认「保护传说及以上」", () => {
    write("auto-mastery", { excludeBelow: "common", intervalMin: 12 });
    upgradeModuleConfigs(repos);

    const cfg = read("auto-mastery");
    expect(cfg.sacrificeMode).toBe("protectLegendary");
    expect("excludeBelow" in cfg).toBe(false);
  });

  it("★ excludeBelow=史诗（特意排除过低档）→ 自选模式 + 「史诗及以上」的集合", () => {
    write("auto-mastery", { excludeBelow: "epic" });
    upgradeModuleConfigs(repos);

    const cfg = read("auto-mastery");
    expect(cfg.sacrificeMode).toBe("custom");
    expect(cfg.sacrificeRarities).toEqual(["epic", "legendary", "mythic", "exotic", "arcane"]);
  });
});

describe("配置升级：自动加点（字符串 → 顺序 + 数值）", () => {
  it("按当前策略取对应的旧字符串", () => {
    write("auto-stats", { mode: "ratio", ratio: "2:3:0:1", targets: "0:2000:0:100", primary: "intelligence" });
    upgradeModuleConfigs(repos);

    const cfg = read("auto-stats");
    expect(cfg.statPlan).toEqual([
      { key: "strength", value: 2 },
      { key: "intelligence", value: 3 },
      { key: "luck", value: 0 },
      { key: "endurance", value: 1 },
    ]);
    for (const legacy of ["ratio", "targets", "primary"]) expect(legacy in cfg).toBe(false);
  });

  it("目标值模式取 targets（默认策略也会换算）", () => {
    write("auto-stats", { mode: "target", ratio: "2:3:0:1", targets: "0:2000:0:100" });
    upgradeModuleConfigs(repos);

    expect(read("auto-stats").statPlan).toEqual([
      { key: "strength", value: 0 },
      { key: "intelligence", value: 2000 },
      { key: "luck", value: 0 },
      { key: "endurance", value: 100 },
    ]);
  });
});

describe("配置升级：保底切图（单目标 → 多目标）", () => {
  it("★ 原来盯奥秘 → 只勾奥秘，地图与阈值照搬（不凭空多监控一档）", () => {
    write("auto-pity", { rarity: "arcane", thresholdCasts: 45, targetBiome: "b_012", checkEverySec: 60 });
    upgradeModuleConfigs(repos);

    const cfg = read("auto-pity");
    expect(cfg.rarities).toEqual(["arcane"]);
    expect(cfg.arcaneBiome).toBe("b_012");
    expect(cfg.arcaneThreshold).toBe(45);
    expect(cfg.exoticBiome).toBeUndefined(); // 没勾奇异，就不给它写地图
    for (const legacy of ["rarity", "thresholdCasts", "targetBiome"]) expect(legacy in cfg).toBe(false);
    expect(cfg.checkEverySec).toBe(60); // 其它配置原样保留
  });

  it("原来盯奇异 → 勾奇异并照搬它的地图与阈值", () => {
    write("auto-pity", { rarity: "exotic", thresholdCasts: 10, targetBiome: "b_009" });
    upgradeModuleConfigs(repos);

    const cfg = read("auto-pity");
    expect(cfg.rarities).toEqual(["exotic"]);
    expect(cfg.exoticBiome).toBe("b_009");
    expect(cfg.exoticThreshold).toBe(10);
    expect(cfg.arcaneBiome).toBeUndefined();
  });
});

describe("配置升级：整体行为", () => {
  it("多个模块 / 多个账号一起处理，返回处理明细", () => {
    write("auto-travel", { fleetMode: "follow" });
    write("auto-mastery", { excludeBelow: "common" });
    const report = upgradeModuleConfigs(repos);

    expect(report.changed).toHaveLength(2);
    expect(report.changed.join()).toContain("auto-travel");
    expect(report.changed.join()).toContain("auto-mastery");
  });

  it("没有历史配置时什么都不做", () => {
    const report = upgradeModuleConfigs(repos);
    expect(report.changed).toEqual([]);
    expect(report.scanned).toBe(0);
  });
});

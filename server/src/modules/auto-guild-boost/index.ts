// 公会区域经验增益：给指定地图（默认跟随当前地图）自动买 / 续「公会经验 +50%」
//
// 协议（对照游戏前端 bundle 实测）：
//  - GET  /api/guilds/me         → 公会金库、增益单价（config.boostUnitCost）、
//                                  我有没有权限（membership.permissions.canActivateBoosts）
//  - GET  /api/guilds/me/boosts  → 各图的增益状态 + unitCost / unitDurationMinutes / maxUnits
//  - POST /api/guilds/me/boosts/{biomeId} { units }   消耗**公会金库**
//
// ★ 官方航线助手也有这个（「公会地图经验 Buff」自动化，要助手权益 + 游戏页面开着）；
//   本模块用游戏自己的端点，挂机时照样生效，也不需要任何权益。
//
// ★★ 注意：花的钱是**公会的**（会长/干部才能开），不是自己的。
//    所以默认关闭；「金库下限」默认 0，建议调高一点，别把公会的钱花光。
import { type ModuleDefinition } from "../types.ts";
import { BIOME_OPTIONS } from "../shared/biomes.ts";
import { decideGuildBoost, readGuildFunds } from "./decide.ts";

const definition: ModuleDefinition = {
  id: "auto-guild-boost",
  name: "公会区域增益",
  version: "1.0.0",
  description:
    "自动给指定地图买 / 续公会的区域经验增益（该地图上所有公会成员钓鱼经验 +50%）。花的是公会金库，需要干部权限；跟不跟随当前地图、买几份、金库留多少都能设。默认关闭。",
  defaultEnabled: false,
  defaultConfig: {
    targetBiome: "current",
    units: 1,
    minimumTreasuryGold: 0,
    renewAheadMin: 0,
    dryRun: false,
    checkEverySec: 300,
  },
  configSchema: [
    {
      key: "targetBiome",
      type: "select",
      label: "给哪张地图开增益",
      hint: "「跟随当前地图」= 你在哪张图钓就给哪张开（助手也是这个行为）；也可以固定一张。",
      default: "current",
      options: [{ value: "current", label: "跟随当前地图" }, ...BIOME_OPTIONS],
    },
    {
      key: "units",
      type: "number",
      label: "每次买几份",
      hint: "1 份 = 30 分钟（以游戏里的单价为准）。超出服务端单次上限时会自动压到上限。",
      default: 1,
      min: 1,
      max: 100,
      step: 1,
    },
    {
      key: "minimumTreasuryGold",
      type: "number",
      label: "公会金库保留下限",
      hint: "买完之后金库低于这个数就不买 —— 花的是公会的钱，建议留一点。0 = 不限制。",
      default: 0,
      min: 0,
      max: 10_000_000_000,
      step: 1000,
    },
    {
      key: "renewAheadMin",
      type: "number",
      label: "剩余多少分钟时开始续买",
      hint: "0 = 等当前增益结束之后再买（助手的做法是结束后 10 分钟）。设成 30 就是还有 30 分钟就续上，避免断档。",
      default: 0,
      min: 0,
      max: 600,
      step: 10,
    },
    {
      key: "dryRun",
      type: "boolean",
      label: "演练模式（只记录，不购买）",
      hint: "只写日志说明「该给哪张图买几份、花多少」，不真的花公会金库。",
      default: false,
    },
    {
      key: "checkEverySec",
      type: "number",
      label: "检查间隔（秒）",
      default: 300,
      min: 60,
      max: 3600,
      step: 60,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      busy: boolean;
      lastIdle: string;
      warned: Set<string>;
    };
    S.busy = false;
    S.lastIdle = "";
    S.warned = new Set();

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("公会增益", msg);
    };
    const warnOnce = (key: string, msg: string) => {
      if (S.warned.has(key)) return;
      S.warned.add(key);
      ctx.log.warn("公会增益", msg);
    };

    const unitsWanted = Math.max(1, Number(ctx.config.units) || 1);
    const targetBiome = String(ctx.config.targetBiome ?? "current");
    const renewAheadMs = Math.max(0, Number(ctx.config.renewAheadMin) || 0) * 60_000;
    const minimumTreasuryGold = Math.max(0, Number(ctx.config.minimumTreasuryGold) || 0);

    const run = async (trigger: string) => {
      if (S.busy) return;
      S.busy = true;
      try {
        /* ---------- 数据三件套：公会资金 / 各图增益 / 我在哪 ---------- */
        const [guild, boostsData, biomesData] = await Promise.all([
          ctx.api.guildsMe(),
          ctx.api.guildBoosts(),
          ctx.api.biomes(),
        ]);

        const funds = readGuildFunds(guild);
        const boosts = (boostsData as { boosts?: unknown })?.boosts;
        const unitCost = Number((boostsData as { unitCost?: unknown })?.unitCost) || funds.unitCost;
        const maxUnits = Number((boostsData as { maxUnits?: unknown })?.maxUnits) || 0;
        const unitMinutes = Number((boostsData as { unitDurationMinutes?: unknown })?.unitDurationMinutes) || 0;
        const list: any[] = (biomesData as { biomes?: any[] })?.biomes ?? [];
        const currentBiomeId: string | null = list.find((b) => b?.isCurrent)?.id ?? null;
        const biomeName = (id: string): string => list.find((b) => b?.id === id)?.name ?? id;

        const decision = decideGuildBoost({
          boosts: Array.isArray(boosts) ? boosts : null,
          unitCost,
          maxUnits,
          canActivate: funds.canActivate,
          treasuryGold: funds.treasuryGold,
          minimumTreasuryGold,
          currentBiomeId,
          targetBiome,
          unitsWanted,
          renewAheadMs,
          now: ctx.api.now(),
        });

        if (decision.action === "skip") {
          // 没权限 / 钱不够属于「需要用户知道」的事，但重复刷没意义 → 各提示一次
          // （key 要固定：把数字拼进 key 会让每次金额变化都当成新警告）
          if (decision.reason.includes("权限")) warnOnce("no-permission", decision.reason);
          else if (decision.reason.includes("金库")) warnOnce("treasury", decision.reason);
          else idle(`${trigger}：${decision.reason}`);
          return;
        }

        if (ctx.config.dryRun === true) {
          idle(`${trigger}：[演练] ${biomeName(decision.biomeId)}：${decision.reason}（未真的购买）`);
          return;
        }

        await ctx.api.guildBoostPurchase(decision.biomeId, decision.units);
        S.lastIdle = "";
        ctx.log.info(
          "公会增益",
          `🏅 已给 ${biomeName(decision.biomeId)} ${decision.reason}` +
            (unitMinutes > 0 ? `；本次覆盖约 ${decision.units * unitMinutes} 分钟` : ""),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnOnce("run", `购买公会区域增益失败：${msg}（没有权限或金库不足时会失败）`);
      } finally {
        S.busy = false;
      }
    };

    const everySec = Math.max(60, Number(ctx.config.checkEverySec) || 300);
    ctx.every(everySec * 1000, () => run("定时检查"));
    ctx.schedule(35_000, () => run("启动检查"));

    ctx.log.info(
      "公会增益",
      `已启动：${targetBiome === "current" ? "跟随当前地图" : `固定 ${targetBiome}`}，每次 ${unitsWanted} 份` +
        (minimumTreasuryGold > 0 ? `，金库保留 ${minimumTreasuryGold}` : "") +
        (renewAheadMs > 0 ? `，剩余 ${Math.round(renewAheadMs / 60_000)} 分钟即续` : "") +
        (ctx.config.dryRun === true ? "；演练模式" : ""),
    );
  },
};

export default definition;

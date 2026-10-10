// 奥秘献祭：全世界共同消耗资源，激活覆盖所有地图的「奥秘涌流」
//
// 协议（对照游戏前端 bundle 实测）：
//  - GET  /api/events/arcane-sacrifice               → 轮次 / 进度 / 我的额度 / 可用资源 / 鱼的点数
//  - POST /api/events/arcane-sacrifice/contributions → { resourceType, rarity?, quantity }
//
// ★ 官方航线助手也有这个功能（需要助手权益），但它要**开着游戏页面**才会执行；
//   本模块直接用游戏自己的端点，挂机时照样献祭，也不依赖任何权益。
//
// ★ 献祭不可撤回：即使本轮全服没达标，资源也不返还。
//   所以默认**关闭**，且判定全部走保守路线（见 decide.ts）：拿不准就不献，只记原因。
//   想先观察一轮的话打开「演练模式」，它只写日志、不真的献。
import { type ModuleDefinition } from "../types.ts";
import {
  FISH_RARITY_LABELS,
  SACRIFICE_FISH_RARITIES,
  SACRIFICE_RESOURCE_LABELS,
  SACRIFICE_RESOURCES,
  decideSacrifice,
  readContributionResult,
} from "./decide.ts";

const definition: ModuleDefinition = {
  id: "auto-sacrifice",
  name: "奥秘献祭",
  version: "1.0.0",
  description:
    "自动给「奥秘献祭」轮次献资源（鱼 / 金币 / 遗物），推进全服进度、激活覆盖所有地图的奥秘涌流。献祭不可撤回，默认关闭，建议先开演练模式观察一轮。",
  defaultEnabled: false,
  defaultConfig: {
    resources: ["fish"],
    fishRarity: "common",
    selfSharePercent: 100,
    dryRun: false,
    checkEverySec: 90,
  },
  configSchema: [
    {
      key: "resources",
      type: "multi-select",
      label: "愿意献祭哪些资源",
      hint: "本轮需要的那种资源不在这里时就不献。金币 / 遗物 1 个 = 1 点，鱼按稀有度折算点数。",
      default: ["fish"],
      options: SACRIFICE_RESOURCES.map((r) => ({ value: r, label: SACRIFICE_RESOURCE_LABELS[r] })),
    },
    {
      key: "fishRarity",
      type: "select",
      label: "献鱼时用哪一档",
      hint: "服务端会优先消耗售价较低的未锁定鱼；选低档通常更划算（高档鱼留着卖或做别的）。",
      default: "common",
      options: SACRIFICE_FISH_RARITIES.map((r) => ({ value: r, label: FISH_RARITY_LABELS[r] ?? r })),
    },
    {
      key: "selfSharePercent",
      type: "number",
      label: "我最多贡献到本轮目标的百分之几",
      hint:
        "100 = 只用游戏自带的单人上限（服务端给出的「剩余额度」），自己不额外限制。" +
        "想控制消耗就调小，例如 30 表示我累计献到目标的 30% 就停。",
      default: 100,
      min: 1,
      max: 100,
      step: 5,
    },
    {
      key: "dryRun",
      type: "boolean",
      label: "演练模式（只记录，不献祭）",
      hint: "只写日志说明「本轮该献多少」，不真的提交。第一次用建议先开一轮看看。",
      default: false,
    },
    {
      key: "checkEverySec",
      type: "number",
      label: "检查间隔（秒）",
      hint: "一轮可能持续很久，额度用完就不会再献，间隔不必太短。",
      default: 90,
      min: 30,
      max: 3600,
      step: 30,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      busy: boolean;
      lastIdle: string;
      /** 已经献过的「轮次 + 额度消耗后」指纹，避免同一轮反复提交 */
      lastRoundKey: string;
      warned: Set<string>;
    };
    S.busy = false;
    S.lastIdle = "";
    S.lastRoundKey = "";
    S.warned = new Set();

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("奥秘献祭", msg);
    };
    const warnOnce = (key: string, msg: string) => {
      if (S.warned.has(key)) return;
      S.warned.add(key);
      ctx.log.warn("奥秘献祭", msg);
    };

    const run = async (trigger: string) => {
      if (S.busy) return;
      S.busy = true;
      try {
        const overview = await ctx.api.arcaneSacrifice();
        const round = (overview as { currentRound?: { roundNumber?: unknown } } | null)?.currentRound;
        const remaining = Number(
          (overview as { currentPlayerRoundContribution?: { remaining?: unknown } } | null)
            ?.currentPlayerRoundContribution?.remaining,
        );

        const decision = decideSacrifice({
          overview: overview as never,
          resources: Array.isArray(ctx.config.resources) ? (ctx.config.resources as string[]) : [],
          fishRarity: String(ctx.config.fishRarity ?? "common"),
          selfSharePercent: Number(ctx.config.selfSharePercent) || 100,
        });

        if (decision.action === "skip") {
          idle(`${trigger}：${decision.reason}`);
          return;
        }

        // 同一轮 + 同样剩余额度 = 已经献过（或没有新额度），不重复提交
        const roundKey = `${round?.roundNumber ?? "?"}:${Number.isFinite(remaining) ? remaining : "?"}`;
        if (S.lastRoundKey === roundKey) {
          idle(`${trigger}：本轮的额度没有变化，无需再献`);
          return;
        }

        if (ctx.config.dryRun === true) {
          S.lastRoundKey = roundKey;
          ctx.log.info("奥秘献祭", `[演练] ${decision.reason}（未真的提交）`);
          return;
        }

        const resp = await ctx.api.arcaneSacrificeContribute(decision.body);
        const result = readContributionResult(resp);
        S.lastRoundKey = roundKey;
        S.lastIdle = "";
        ctx.log.info(
          "奥秘献祭",
          `🔥 已献祭 ${(result?.inputQuantity ?? decision.body.quantity).toLocaleString("zh-CN")} 份` +
            `（推进 ${(result?.contribution ?? decision.points).toLocaleString("zh-CN")} 点）` +
            `：${decision.reason}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnOnce("contribute", `献祭失败：${msg}`);
      } finally {
        S.busy = false;
      }
    };

    const everySec = Math.max(30, Number(ctx.config.checkEverySec) || 90);
    ctx.every(everySec * 1000, () => run("定时检查"));
    ctx.schedule(25_000, () => run("启动检查"));

    ctx.log.info(
      "奥秘献祭",
      `已启动：可献 ${(Array.isArray(ctx.config.resources) ? (ctx.config.resources as string[]) : [])
        .map((r) => SACRIFICE_RESOURCE_LABELS[r as never] ?? r)
        .join(" / ") || "（未配置）"}；献鱼用「${FISH_RARITY_LABELS[String(ctx.config.fishRarity)] ?? ctx.config.fishRarity}」` +
        (ctx.config.dryRun === true ? "；演练模式" : ""),
    );
  },
};

export default definition;

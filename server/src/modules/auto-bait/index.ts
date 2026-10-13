// 自动换饵：按场景切换鱼饵（5 个场景，与官方助手的「场景鱼饵」一一对应），并自动补货
//
// 协议：
//  - GET  /api/baits                  → { baits: [{ id, tier, name, unitPrice, luck, isSelected, ownedQuantity, ... }] }
//  - POST /api/baits/{id}/equip       → 换饵
//  - POST /api/baits/{id}/purchase    { quantity } → 补货
//
// ★ 场景与优先级（照抄游戏里助手的 baitByScene 判定顺序）：
//     个人赛 > 公会赛 > 金风 > 奥秘涌流 > 平时
//   比赛有时间窗口、金风与涌流都是时段性天气，所以都排在「平时」前面。
//
//   一处**刻意的不同**：比赛判定用「我已报名且在进行中/即将开赛」，而不是助手那种
//   「当前地图上有比赛」——后者在你没参赛时也会让你烧高级饵。
//
// 与官方航线助手：本项目**自己负责换饵**（助手那套场景鱼饵是纯浏览器逻辑，
// 挂机时它不会执行），不看它、不让位、也不提示。
//
// ★ 买不起就降级（用户要求）：游戏用 400 + `INSUFFICIENT_GOLD` 表示金币不够、
//   `BAIT_NOT_OWNED` 表示这款饵还没解锁。旧版只报一条「购买 中级饵 失败：金币不足。」，
//   然后**继续用没有库存的高级饵去钓**。现在按单价从高到低逐级往下试，
//   选到买得起 / 有库存的那一档换上；试过的档位 10 分钟冷却，避免重复刷失败。
import { type ModuleDefinition } from "../types.ts";
import { baitOptions, baitName } from "../shared/rarity.ts";
import {
  baitDisplayName,
  decideRefill,
  downgradeChain,
  extractBaits,
  needsCheaperBait,
  baitPrice,
  type BaitInfo,
} from "./baits.ts";

/** 天气 id（游戏里叫 weatherId） */
const ARCANE_SURGE = "arcane_surge";
const GILDED_CURRENT = "gilded_current";

type SceneKey = "personalCompetition" | "guildCompetition" | "golden" | "arcaneSurge" | "normal";

/** 每个场景用哪个配置项（顺序即优先级） */
const SCENE_FIELDS: Array<{ key: SceneKey; field: string }> = [
  { key: "personalCompetition", field: "personalCompetitionBait" },
  { key: "guildCompetition", field: "guildCompetitionBait" },
  { key: "golden", field: "goldenBait" },
  { key: "arcaneSurge", field: "surgeBait" },
  { key: "normal", field: "normalBait" },
];

const definition: ModuleDefinition = {
  id: "auto-bait",
  name: "自动换饵",
  version: "4.0.0",
  description:
    "按当前场景自动切换鱼饵，场景与官方助手的「场景鱼饵」一致：个人赛 / 公会赛 / 金风 / 奥秘涌流 / 平时。鱼饵不足时按设定数量自动购买；买不起时自动降级到下一档更便宜的鱼饵。",
  defaultEnabled: false,
  defaultConfig: {
    personalCompetitionBait: "bait_supreme",
    guildCompetitionBait: "bait_supreme",
    goldenBait: "",
    surgeBait: "bait_high",
    normalBait: "bait_medium",
    autoDowngrade: true,
    competitionLeadSec: 180,
    buyQuantity: 200,
    checkEverySec: 120,
  },
  configSchema: [
    {
      key: "personalCompetitionBait",
      type: "select",
      label: "个人赛期间用哪种饵",
      hint: "已报名且比赛进行中 / 即将开赛时使用。比赛成绩看单杆质量，建议最高档。",
      default: "bait_supreme",
      options: baitOptions({ includeEmpty: true, emptyLabel: "不切换（沿用平时）" }),
    },
    {
      key: "guildCompetitionBait",
      type: "select",
      label: "公会赛期间用哪种饵",
      hint: "已报名公会赛且比赛进行中 / 即将开赛时使用。",
      default: "bait_supreme",
      options: baitOptions({ includeEmpty: true, emptyLabel: "不切换（沿用平时）" }),
    },
    {
      key: "goldenBait",
      type: "select",
      label: "金风期间用哪种饵",
      hint: "金风（gilded_current）时鱼价值更高、经验打折，用高档饵提高稀有度通常更划算。默认不切换。",
      default: "",
      options: baitOptions({ includeEmpty: true, emptyLabel: "不切换（沿用平时）" }),
    },
    {
      key: "surgeBait",
      type: "select",
      label: "奥秘涌流期间用哪种饵",
      hint: "涌流时经验倍率最高，用更好的饵提高稀有度更划算。",
      default: "bait_high",
      options: baitOptions({ includeEmpty: true, emptyLabel: "不切换（沿用平时）" }),
    },
    {
      key: "normalBait",
      type: "select",
      label: "平时用哪种饵",
      hint: "没有比赛、也没有金风 / 涌流时使用。「不切换」= 保持游戏里当前选中的饵。",
      default: "bait_medium",
      options: baitOptions({ includeEmpty: true, emptyLabel: "不切换（手动）" }),
    },
    {
      key: "autoDowngrade",
      type: "boolean",
      label: "买不起时自动降级鱼饵",
      hint:
        "购买失败的（金币不足 / 尚未拥有该鱼饵）时候自动改用下一档更便宜的饵：顶级 → 高级 → 中级 → 低级 → 基础。\n" +
        "降级过的档位 10 分钟内不再重复尝试购买（避免一直刷失败日志），金币够了会自动回到原档位。",
      default: true,
    },
    {
      key: "competitionLeadSec",
      type: "number",
      label: "比赛提前多少秒换比赛饵",
      default: 180,
      min: 30,
      max: 1800,
      step: 30,
    },
    {
      key: "buyQuantity",
      type: "number",
      label: "自动购买数量",
      hint: "鱼饵不足时一次买多少。设为 0 表示不自动购买（只切换已有的）。",
      default: 200,
      min: 0,
      max: 10000,
      step: 50,
    },
    {
      key: "checkEverySec",
      type: "number",
      label: "检查间隔（秒）",
      default: 120,
      min: 60,
      max: 3600,
      step: 60,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      busy: boolean;
      lastIdle: string;
      lastSwitch: string;
      /** 买不起 / 用不了的鱼饵 → 解禁时间戳（这段时间内直接跳过它的购买尝试） */
      priceBlocked: Record<string, number>;
    };
    S.busy = false;
    S.lastIdle = "";
    S.lastSwitch = "";
    S.priceBlocked = S.priceBlocked && typeof S.priceBlocked === "object" ? S.priceBlocked : {};

    const autoDowngrade = ctx.config.autoDowngrade !== false;
    /** 买不起的这一档，多久之内不再尝试购买（同时压住重复的失败日志） */
    const PRICE_BLOCK_MS = Math.max(10 * 60_000, (Number(ctx.config.checkEverySec) || 120) * 1000 * 3);

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("自动换饵", msg);
    };

    /* ---------- 场景判定（顺序 = 优先级） ---------- */

    /** 个人赛 / 公会赛：已报名且进行中或即将开赛 */
    const competitionScene = async (
      leadSec: number,
    ): Promise<{ key: SceneKey; why: string } | null> => {
      const now = Date.now();
      const leadMs = leadSec * 1000;
      const inComp = (t: any) =>
        t && (t.status === "active" || (t.status === "scheduled" && t.startAt && Date.parse(t.startAt) - now <= leadMs));

      try {
        const personal = await ctx.api.tournamentsOverview().catch(() => null);
        const cur = personal?.current;
        if (cur?.isRegistered && inComp(cur)) return { key: "personalCompetition", why: `个人赛 #${cur.sequence}` };
        for (const t of personal?.upcoming ?? []) {
          if (t?.isRegistered && inComp(t)) return { key: "personalCompetition", why: `个人赛 #${t.sequence} 即将开赛` };
        }
      } catch {
        /* 拿不到就往下走 */
      }

      try {
        const guild = await ctx.api.guildTournamentsOverview().catch(() => null);
        const gcur = guild?.current;
        if (gcur?.entryStatus && inComp(gcur)) return { key: "guildCompetition", why: `公会赛 #${gcur.sequence}` };
        for (const t of guild?.upcoming ?? []) {
          if (t?.entryStatus && inComp(t)) return { key: "guildCompetition", why: `公会赛 #${t.sequence} 即将开赛` };
        }
      } catch {
        /* 拿不到就往下走 */
      }

      return null;
    };

    /** 当前地图的天气 id（拿不到返回 null） */
    const currentWeather = async (): Promise<string | null> => {
      try {
        const data = await ctx.api.biomes();
        const list: any[] = data?.biomes ?? [];
        const current = list.find((b) => b.isCurrent) ?? null;
        // 与状态面板一致：天气 id 可能是 weatherId 或 id
        return current?.weather?.weatherId ?? current?.weather?.id ?? null;
      } catch {
        return null; // 天气拿不到就按平时处理
      }
    };

    /** 判断当前该用哪个场景（顺序即优先级） */
    const decideScenario = async (): Promise<{ key: SceneKey; field: string; why: string }> => {
      const leadSec = Math.max(30, Number(ctx.config.competitionLeadSec) || 180);

      const comp = await competitionScene(leadSec);
      if (comp) return { ...comp, field: fieldOf(comp.key) };

      const weather = await currentWeather();
      if (weather === GILDED_CURRENT) return { key: "golden", field: fieldOf("golden"), why: "金风" };
      if (weather === ARCANE_SURGE) return { key: "arcaneSurge", field: fieldOf("arcaneSurge"), why: "奥秘涌流" };

      return { key: "normal", field: fieldOf("normal"), why: "平时" };
    };

    function fieldOf(key: SceneKey): string {
      return SCENE_FIELDS.find((s) => s.key === key)?.field ?? "normalBait";
    }

    /** 买不起时用的「当前金币」说明（只在真的失败时查一次，失败也无所谓） */
    const goldText = async (): Promise<string> => {
      try {
        const me = await ctx.api.me();
        const gold = Number(me?.player?.gold);
        return Number.isFinite(gold) ? `，当前 ${gold.toLocaleString("zh-CN")} 金币` : "";
      } catch {
        return "";
      }
    };

    /**
     * 备货 + 选饵：买不起就逐级降到底。
     *
     * 返回最终要用哪一款（可能比配置的便宜）。降级过的档位记 10 分钟冷却，
     * 期间不再重复尝试购买 —— 否则每轮都会对着同一档刷一条「金币不足」。
     */
    const pickBait = async (list: BaitInfo[], wanted: BaitInfo): Promise<{ bait: BaitInfo; downgraded: boolean }> => {
      // 不降级时阶梯里只有配置的那一款（行为与旧版一致）
      const chain: BaitInfo[] = autoDowngrade ? [wanted, ...downgradeChain(wanted.id, list)] : [wanted];

      for (let i = 0; i < chain.length; i++) {
        const cand = chain[i]!;
        const refill = decideRefill(cand, ctx.config);

        if (!refill.buy) {
          // 不需要买（无限饵 / 还有库存 / 未开自动购买）→ 就用它
          return { bait: cand, downgraded: cand.id !== wanted.id };
        }

        if ((Number(S.priceBlocked[cand.id]) || 0) > Date.now()) {
          // 这一档刚试过买不起：直接往下找更便宜的，不再打一次注定失败的购买
          if (i === chain.length - 1) return { bait: cand, downgraded: cand.id !== wanted.id };
          continue;
        }

        try {
          await ctx.api.purchaseBait(cand.id, refill.quantity);
          const price = baitPrice(cand);
          ctx.log.info(
            "自动换饵",
            `🛒 已购买 ${baitDisplayName(cand)} ×${refill.quantity}` +
              `（单价 ${price}，约 ${(price * refill.quantity).toLocaleString("zh-CN")} 金币）`,
          );
          return { bait: cand, downgraded: cand.id !== wanted.id };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const next = chain[i + 1];
          if (autoDowngrade && next && needsCheaperBait(err)) {
            S.priceBlocked[cand.id] = Date.now() + PRICE_BLOCK_MS;
            const price = baitPrice(cand);
            ctx.log.warn(
              "自动换饵",
              `💰 ${baitDisplayName(cand)} 买不起或未解锁（${refill.quantity} 个约 ` +
                `${(price * refill.quantity).toLocaleString("zh-CN")} 金币${await goldText()}）：${message}` +
                ` → 已自动降级为 ${baitDisplayName(next)}`,
            );
            continue;
          }
          ctx.log.warn("自动换饵", `购买 ${baitDisplayName(cand)} 失败：${message}`);
          return { bait: cand, downgraded: cand.id !== wanted.id };
        }
      }

      // 一路降到底（基础饵免费，理论上到不了这里）
      return { bait: chain[chain.length - 1] ?? wanted, downgraded: chain.length > 1 };
    };

    const run = async (trigger: string) => {
      if (S.busy) return;
      S.busy = true;
      try {
        const scenario = await decideScenario();
        const wantedId = String(ctx.config[scenario.field] ?? "").trim();

        if (!wantedId) {
          idle(`${trigger}：${scenario.why} 场景未配置鱼饵，跳过`);
          return;
        }

        // 用 baits.ts 的解析helper：字段名/包裹形式都在那里统一（可单测）
        const list = extractBaits(await ctx.api.baits());
        const wanted = list.find((b) => b?.id === wantedId);
        if (!wanted) {
          ctx.log.warn("自动换饵", `${trigger}：找不到鱼饵 ${wantedId}（可能是配置写错或该饵未解锁）`);
          return;
        }

        /* ---------- 备货（买不起自动降级） ---------- */
        const { bait, downgraded } = await pickBait(list, wanted);

        /* ---------- 换饵 ---------- */
        if (bait.isSelected) {
          idle(
            `${trigger}：${scenario.why} 已在用 ${baitDisplayName(bait)}` +
              (downgraded ? "（降级后的档位）" : "") +
              "，无需切换",
          );
          return;
        }

        await ctx.api.equipBait(bait.id);
        S.lastSwitch = bait.id;
        S.lastIdle = "";
        // 日志里同时给出中文名，避免只说 id 让人看不懂
        const niceName = (b: any) => baitName(b?.id) ?? b?.name ?? b?.id ?? "未知";
        ctx.log.info(
          "自动换饵",
          `🎣 ${scenario.why} → 换成 ${niceName(bait)}` +
            (Number.isFinite(Number(bait.luck)) ? `（幸运 +${bait.luck}）` : "") +
            (downgraded ? `（原定 ${baitDisplayName(wanted)}，余额不足已降级）` : ""),
        );
      } catch (err) {
        ctx.log.warn("自动换饵", `${trigger} 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.busy = false;
      }
    };

    ctx.every(Math.max(60, Number(ctx.config.checkEverySec) || 120) * 1000, () => run("定时检查"));

    // 比赛临近是时间敏感的：钓鱼结算时顺带检查（节流 1 分钟）
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < 60_000) return;
      lastSync = now;
      void run("钓鱼同步");
    });

    ctx.schedule(20_000, () => run("启动检查"));
  },
};

export default definition;

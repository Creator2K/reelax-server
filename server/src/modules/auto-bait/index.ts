// 自动换饵：按场景切换鱼饵（平时 / 涌流 / 比赛），并自动补货
//
// 协议：
//  - GET  /api/baits                  → { baits: [{ id, tier, name, unitPrice, luck, isSelected, ownedQuantity, ... }] }
//  - POST /api/baits/{id}/equip       → 换饵
//  - POST /api/baits/{id}/purchase    { quantity } → 补货
//
// 场景优先级：比赛 > 涌流 > 平时（比赛有时间窗口，错过就没了）
// 与官方航线助手的「自动鱼饵」功能重叠，但助手需要游戏页面打开才执行，
// 本服务是 24 小时直连 API —— 因此按软冲突处理：只提示不停手。
import { type ModuleDefinition } from "../types.ts";
import { assistantTakesOver } from "../shared/conflicts.ts";
import { baitOptions, baitName } from "../shared/rarity.ts";
import { baitDisplayName, decideRefill, extractBaits } from "./baits.ts";

const ARCANE_SURGE = "arcane_surge";

const definition: ModuleDefinition = {
  id: "auto-bait",
  name: "自动换饵",
  version: "2.0.0",
  description:
    "按当前场景自动切换鱼饵：平时用普通饵，奥秘涌流期间用高级饵，比赛临近换比赛饵。鱼饵不足时按设定数量自动购买。",
  defaultEnabled: false,
  defaultConfig: {
    normalBait: "bait_medium",
    surgeBait: "bait_high",
    competitionBait: "bait_supreme",
    competitionLeadSec: 180,
    buyQuantity: 200,
    checkEverySec: 120,
  },
  configSchema: [
    {
      key: "normalBait",
      type: "select",
      label: "平时用哪种饵",
      hint: "没有比赛、也没有奥秘涌流时使用。「不切换」= 保持游戏里当前选中的饵。",
      default: "bait_medium",
      options: baitOptions({ includeEmpty: true, emptyLabel: "不切换（手动）" }),
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
      key: "competitionBait",
      type: "select",
      label: "比赛期间用哪种饵",
      hint: "比赛成绩看单杆质量，建议用最高档。",
      default: "bait_supreme",
      options: baitOptions({ includeEmpty: true, emptyLabel: "不切换（沿用平时）" }),
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
    const S = ctx.state as { busy: boolean; lastIdle: string; warnedConflict: boolean; lastSwitch: string };
    S.busy = false;
    S.lastIdle = "";
    S.warnedConflict = false;
    S.lastSwitch = "";

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("自动换饵", msg);
    };

    /** 判断当前该用哪个场景 */
    const decideScenario = async (): Promise<{ key: "competition" | "surge" | "normal"; why: string }> => {
      const leadSec = Math.max(30, Number(ctx.config.competitionLeadSec) || 180);
      const now = Date.now();

      // 比赛优先：进行中或即将开赛
      try {
        const [personal, guild] = await Promise.all([
          ctx.api.tournamentsOverview().catch(() => null),
          ctx.api.guildTournamentsOverview().catch(() => null),
        ]);
        const inComp = (t: any) =>
          t && (t.status === "active" || (t.status === "scheduled" && t.startAt && Date.parse(t.startAt) - now <= leadSec * 1000));
        const cur = personal?.current;
        if (cur?.isRegistered && inComp(cur)) return { key: "competition", why: `个人赛 #${cur.sequence}` };
        for (const t of personal?.upcoming ?? []) {
          if (t?.isRegistered && inComp(t)) return { key: "competition", why: `个人赛 #${t.sequence} 即将开赛` };
        }
        const gcur = guild?.current;
        if (gcur?.entryStatus && inComp(gcur)) return { key: "competition", why: `公会赛 #${gcur.sequence}` };
        for (const t of guild?.upcoming ?? []) {
          if (t?.entryStatus && inComp(t)) return { key: "competition", why: `公会赛 #${t.sequence} 即将开赛` };
        }
      } catch {
        /* 比赛信息拿不到就按非比赛处理 */
      }

      // 涌流
      try {
        const data = await ctx.api.biomes();
        const list: any[] = data?.biomes ?? [];
        const current = list.find((b) => b.isCurrent);
        // 与模拟器一致：天气 id 可能是 weatherId 或 id
        const wid = current?.weather?.weatherId ?? current?.weather?.id;
        if (wid === ARCANE_SURGE) return { key: "surge", why: "奥秘涌流" };
      } catch {
        /* 天气拿不到就按平时处理 */
      }

      return { key: "normal", why: "平时" };
    };

    const run = async (trigger: string) => {
      if (S.busy) return;
      S.busy = true;
      try {
        /* ---------- 与官方助手的自动鱼饵重叠时只提示一次 ---------- */
        if (!S.warnedConflict) {
          const taken = await assistantTakesOver(ctx.api, "isAutoBaitEnabled");
          if (taken) {
            S.warnedConflict = true;
            ctx.log.info(
              "自动换饵",
              "检测到官方航线助手也开启了「自动鱼饵」。助手需要游戏页面打开才执行，本服务直接调 API，两者不会同时生效，因此继续工作。",
            );
          }
        }

        const scenario = await decideScenario();
        const wantedId = String(ctx.config[`${scenario.key}Bait`] ?? "").trim();

        if (!wantedId) {
          idle(`${trigger}：${scenario.why} 场景未配置鱼饵，跳过`);
          return;
        }

        // 用 baits.ts 的解析helper：字段名/包裹形式都在那里统一（可单测）
        const wanted = extractBaits(await ctx.api.baits()).find((b) => b?.id === wantedId);
        if (!wanted) {
          ctx.log.warn("自动换饵", `${trigger}：找不到鱼饵 ${wantedId}（可能是配置写错或该饵未解锁）`);
          return;
        }

        /* ---------- 补货 ---------- */
        // 判断逻辑抽在 baits.ts 里（可单测）：字段名和边界都在那里钉住
        const refill = decideRefill(wanted, ctx.config);
        if (refill.buy) {
          const price = Number(wanted.unitPrice) || 0;
          try {
            await ctx.api.purchaseBait(wanted.id, refill.quantity);
            ctx.log.info(
              "自动换饵",
              `🛒 已购买 ${baitDisplayName(wanted)} ×${refill.quantity}` +
                `（单价 ${price}，约 ${(price * refill.quantity).toLocaleString("zh-CN")} 金币）`,
            );
          } catch (err) {
            ctx.log.warn("自动换饵", `购买 ${baitDisplayName(wanted)} 失败：${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (refill.stock !== null && refill.stock > 0) {
          // 只在真的读到库存时提示，避免无限饵也刷这条
          idle(`${trigger}：${baitDisplayName(wanted)} ${refill.reason}`);
        }

        /* ---------- 换饵 ---------- */
        if (wanted.isSelected) {
          idle(`${trigger}：${scenario.why} 已在用 ${wanted.name}，无需切换`);
          return;
        }

        await ctx.api.equipBait(wanted.id);
        S.lastSwitch = wanted.id;
        S.lastIdle = "";
        // 日志里同时给出中文名，避免只说 id 让人看不懂
        const niceName = (b: any) => baitName(b?.id) ?? b?.name ?? b?.id ?? "未知";
        ctx.log.info(
          "自动换饵",
          `🎣 ${scenario.why} → 换成 ${niceName(wanted)}` +
            (Number.isFinite(Number(wanted.luck)) ? `（幸运 +${wanted.luck}）` : ""),
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

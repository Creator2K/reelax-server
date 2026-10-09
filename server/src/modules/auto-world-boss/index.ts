// 渊潮围猎参战：在开战前选定出战属性
//
// 关键机制：**选中即参战**。POST /api/events/world-boss/selection { stat } 之后由服务端自动攻击，
// 没有攻击接口，也不需要进特定地图。
// 快照锁定：第一次攻击产生后属性锁定（player.recentDamage > 0 或 isLocked === true），
// 所以必须在开战前就用最强属性完成选择。
//
// 与官方助手的「渊潮围猎自动报名」是软冲突：两者都只是 POST selection，
// 服务端只认第一次选择，重复提交无副作用 → 只提示不停手。
import { type ModuleDefinition } from "../types.ts";
import { STAT_KEYS, STAT_LABELS } from "../shared/rarity.ts";
import { jitter } from "../../lib/util.ts";

const definition: ModuleDefinition = {
  id: "auto-world-boss",
  name: "渊潮围猎参战",
  version: "2.0.0",
  description:
    "围猎开战前自动选好出战属性并参战。可选自动取最高属性，或固定用某一项。",
  defaultEnabled: false,
  defaultConfig: {
    stat: "max",
    checkEverySec: 90,
    minLeadSec: 60,
  },
  configSchema: [
    {
      key: "stat",
      type: "select",
      label: "出战属性",
      hint: "「自动取最高」会读你当前的属性总计（含装备加成）挑最高的一项。属性在开战后锁定，无法更改。",
      default: "max",
      options: [
        { value: "max", label: "自动取最高属性" },
        ...STAT_KEYS.map((k) => ({ value: k, label: `${STAT_LABELS[k]}（固定）` })),
      ],
    },
    {
      key: "checkEverySec",
      type: "number",
      label: "检查间隔（秒）",
      default: 90,
      min: 30,
      max: 900,
      step: 30,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as { busy: boolean; lastIdle: string };
    S.busy = false;
    S.lastIdle = "";

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.info("围猎参战", msg);
    };

    const run = async (trigger: string) => {
      if (S.busy) return;
      S.busy = true;
      try {
        const data = await ctx.api.worldBoss();
        const session = data?.session;
        if (!session) {
          idle(`${trigger}：当前没有围猎场次`);
          return;
        }

        const battleAt = Date.parse(String(session.battleAt ?? ""));
        const status = String(session.status ?? "");
        const player = session.player ?? {};

        // 已经选过 / 已锁定 / 已产生伤害 → 本轮结束，不要重复提交
        if (player.selectedStat) {
          idle(`${trigger}：已选定「${STAT_LABELS[player.selectedStat as never] ?? player.selectedStat}」，无需操作`);
          return;
        }
        if (player.isLocked === true || (Number(player.recentDamage) || 0) > 0) {
          idle(`${trigger}：属性快照已锁定（已产生伤害），无法再改`);
          return;
        }

        // 只在开战前提交
        if (status !== "registration" && status !== "preparing") {
          idle(`${trigger}：场次状态为「${status}」，不在此阶段提交`);
          return;
        }
        if (!Number.isFinite(battleAt)) {
          idle(`${trigger}：缺少开战时间，跳过`);
          return;
        }
        const leadMs = battleAt - Date.now();
        if (leadMs <= 0) {
          idle(`${trigger}：已过开战时间，放弃提交`);
          return;
        }

        /* ---------- 决定出战属性 ---------- */
        let stat: string;
        const configured = String(ctx.config.stat ?? "max");

        if (configured !== "max" && (STAT_KEYS as readonly string[]).includes(configured)) {
          stat = configured;
        } else {
          // 「自动取最高」：读 /api/me 的属性总计（含装备/神器加成）
          const me = await ctx.api.me();
          const totals = me?.player?.stats?.total ?? me?.player?.stats ?? {};
          const ranked = STAT_KEYS.map((k) => ({ k, v: Number(totals[k]) || 0 })).sort((a, b) => b.v - a.v);
          const top = ranked[0];
          if (!top || top.v <= 0) {
            idle(`${trigger}：拿不到属性数据，跳过本轮`);
            return;
          }
          stat = top.k;
        }

        await ctx.api.worldBossSelect(stat);
        ctx.log.info(
          "围猎参战",
          `✅ 已选定「${STAT_LABELS[stat as never] ?? stat}」参战` +
            `（开战前 ${Math.round(leadMs / 60_000)} 分钟，选中即参战，服务端会自动攻击）`,
        );
        S.lastIdle = "";
      } catch (err) {
        ctx.log.warn("围猎参战", `${trigger} 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.busy = false;
      }
    };

    const everySec = Math.max(30, Number(ctx.config.checkEverySec) || 90);
    ctx.every(everySec * 1000, () => run("定时检查"));
    ctx.schedule(jitter(15_000), () => run("启动检查"));

    // 钓鱼结算时顺便看一眼（节流 2 分钟；围猎是时间敏感操作，间隔比其它模块短）
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < 2 * 60_000) return;
      lastSync = now;
      void run("钓鱼同步");
    });
  },
};

export default definition;

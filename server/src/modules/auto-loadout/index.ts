// 定时配装：按每天的时间表自动切换到指定的装备配装
//
// 协议（对照游戏前端 bundle 实测，2026-10 / 前端 0.25.2）：
//  - GET  /api/gear/loadouts              → { loadouts: [{ slot, name, gear, stats }] }
//  - POST /api/gear/loadouts/{slot}/load  → 装载该配装（把身上装备换成配装内容）
//
// 设计取舍：
//  · **只在目标配装变了时才发请求**，正常一天 1~3 次；其余时候纯本地判断，不打扰游戏
//  · 时间是「到点生效」的里程碑，没有时间空档：今天还没到第一条就用昨天的最后一条
//  · 配装号（1、2…）与配装名（游戏里显示的名字）都可以写，见 plan.ts
//  · 装载失败（装备被锁定 / 挂到市场 / 配装被清空）5 分钟后才重试，不每分钟刷失败请求
//  · 账号每次启动都会重新对齐一次：即使中途手动换了装备，下一个检查点也会纠正回来
//
// 与官方航线助手不冲突（助手没有配装自动化）；与「自动卖装备」也不冲突：
// 卖掉的装备会被游戏自动从配装里移除，装载时如果因此失败，日志里会说明原因。
import { type ModuleDefinition } from "../types.ts";
import { parseLoadouts, describeLoadout, type Loadout } from "./loadout.ts";
import { describeTarget, parsePlan, pickPlanEntry, resolveTarget, targetKey } from "./plan.ts";

/** 装载失败后的重试间隔 */
const FAIL_RETRY_MS = 5 * 60_000;

const definition: ModuleDefinition = {
  id: "auto-loadout",
  name: "定时配装",
  version: "1.0.0",
  description:
    "按每天的时间表自动切换到指定的装备配装（游戏内「装备 → 配装」里保存的方案）。时间表是「到点生效」的里程碑：写 09:00 1 与 21:00 2，就是白天用 1 号、晚上用 2 号。到点只切一次，不会反复加载。",
  defaultEnabled: false,
  defaultConfig: {
    plan: "",
    checkEverySec: 60,
    dryRun: false,
  },
  configSchema: [
    {
      key: "plan",
      type: "textarea",
      label: "配装时间表",
      hint:
        "每行一条：「HH:MM 配装号」或「HH:MM 配装名」，例如「09:00 1」「21:00 比赛套」。\n" +
        "语义是「到点生效」：当前时段取时间 ≤ 现在的最后一条，今天还没到第一条则沿用昨天的最后一条。\n" +
        "空行与以 # 开头的注释行会被忽略。配装号/配装名要在游戏「装备 → 配装」里先保存好。",
      default: "",
      placeholder: "09:00 1\n21:00 比赛套",
    },
    {
      key: "checkEverySec",
      type: "number",
      label: "检查间隔（秒）",
      hint: "到点后最多延迟这么久切换。只有目标配装变化时才会真的发请求。",
      default: 60,
      min: 30,
      max: 3600,
      step: 30,
    },
    {
      key: "dryRun",
      type: "boolean",
      label: "演练模式（只记录，不切换）",
      hint: "第一次用建议先开一天，确认时间表与配装号选对了再关掉。",
      default: false,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      busy: boolean;
      lastIdle: string;
      /** 已经成功装载过的目标（plan 里的写法，如 "#1" / "@比赛套"） */
      appliedKey: string | null;
      /** 上次失败的 目标 + 时间，用于退避重试 */
      failKey: string | null;
      failAt: number;
      warned: Set<string>;
    };
    S.busy = false;
    S.lastIdle = "";
    // 每次启动都重新对齐一次（中途手动换过装备也能纠正回来）
    S.appliedKey = null;
    S.failKey = null;
    S.failAt = 0;
    S.warned = new Set();

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("定时配装", msg);
    };
    const warnOnce = (key: string, msg: string) => {
      if (S.warned.has(key)) return;
      S.warned.add(key);
      ctx.log.warn("定时配装", msg);
    };

    /* ---------- 启动时先把时间表讲清楚（不发网络请求，避免拖慢账号启动） ---------- */
    {
      const { entries, errors } = parsePlan(ctx.config.plan);
      for (const err of errors) ctx.log.warn("定时配装", err);
      if (ctx.config.dryRun === true) {
        ctx.log.info("定时配装", "演练模式已开启：只记录「该切哪个配装」，不会真的切换");
      }
      if (entries.length) {
        const cur = pickPlanEntry(entries, new Date());
        ctx.log.info(
          "定时配装",
          `时间表 ${entries.length} 条：${entries
            .map((e) => `${e.at}→${describeTarget(e.target)}`)
            .join("，")}；现在应对应 ${cur ? describeTarget(cur.target) : "无"}`,
        );
      } else {
        ctx.log.warn("定时配装", "时间表为空，本功能不会做任何事（请填写「HH:MM 配装号或配装名」）");
      }
    }

    const run = async (trigger: string) => {
      if (S.busy) return;
      S.busy = true;
      try {
        const { entries } = parsePlan(ctx.config.plan);
        if (!entries.length) return;

        const target = pickPlanEntry(entries, new Date());
        if (!target) return;

        const want = targetKey(target.target);
        if (S.appliedKey === want) {
          idle(`${trigger}：已在用 ${describeTarget(target.target)}`);
          return;
        }

        // 失败退避：同一个目标没成功过，5 分钟内不再重试（连配装列表都不再拉，
        // 免得配置写错时每分钟白打一次接口）
        if (S.failKey === want && Date.now() - S.failAt < FAIL_RETRY_MS) {
          idle(`${trigger}：${describeTarget(target.target)} 上次没切换成功，稍后重试`);
          return;
        }

        // 需要（可能）切换才去读配装列表：正常一天只有到点那几次
        let loadouts: Loadout[];
        try {
          loadouts = parseLoadouts(await ctx.api.gearLoadouts());
        } catch (err) {
          warnOnce("loadouts", `读不到配装列表：${err instanceof Error ? err.message : String(err)}`);
          return;
        }

        const resolved = resolveTarget(target.target, loadouts);
        if (!resolved.ok) {
          S.failKey = want;
          S.failAt = Date.now();
          warnOnce(`target:${want}`, `${target.at} 该切到 ${describeTarget(target.target)}，但${resolved.reason}`);
          return;
        }
        const real = resolved.loadout;

        if (ctx.config.dryRun === true) {
          // 演练模式：记一次就算到位，避免每分钟重复提示
          S.appliedKey = want;
          ctx.log.info(
            "定时配装",
            `[演练] ${target.at} 到点，应切换到 ${describeLoadout(real)}（未真的切换）`,
          );
          return;
        }

        try {
          await ctx.api.loadoutLoad(real.slot);
        } catch (err) {
          S.failKey = want;
          S.failAt = Date.now();
          ctx.log.warn(
            "定时配装",
            `切换到 ${describeLoadout(real)} 失败：${err instanceof Error ? err.message : String(err)}` +
              `（${Math.round(FAIL_RETRY_MS / 60_000)} 分钟后重试；装备被锁定或挂到市场时游戏会拒绝装载）`,
          );
          return;
        }

        S.appliedKey = want;
        S.failKey = null;
        S.failAt = 0;
        S.lastIdle = "";
        ctx.log.info("定时配装", `🔁 ${target.at} 到点，已切换到 ${describeLoadout(real)}`);
      } catch (err) {
        ctx.log.warn("定时配装", `${trigger} 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.busy = false;
      }
    };

    ctx.every(Math.max(30, Number(ctx.config.checkEverySec) || 60) * 1000, () => run("定时检查"));
    // 启动后 15 秒对齐一次：会话在模块启动前就已建好（AccountRuntime.start 先 ensureSession），
    // 这里只是错开启动瞬间的请求，不去和别的模块抢带宽。
    ctx.schedule(15_000, () => run("启动检查"));
  },
};

export default definition;

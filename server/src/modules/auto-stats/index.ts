// 自动加点：把可用属性点按策略分配
//
// 协议（实测）：
//  - GET  /api/me → player.unspentStatPoints 待分配点数
//                   player.stats.base        四维已投入
//  - POST /api/player/stats/allocate { strength, intelligence, luck, endurance }
//    ★ 四个字段必须**全部出现**（可为 0），缺字段会被服务端拒绝
//  - POST /api/player/stats/reset 洗点（会消耗资源，默认不允许）
//
// 三种策略（与旧版行为一致）：
//   priority 全部点数投入主属性
//   ratio    按权重分摊，余数给力量
//   target   按目标值缺口补齐；点数不够时可（可选）洗点搬运
import { type ModuleDefinition } from "../types.ts";
import { STAT_KEYS, STAT_LABELS, type StatKey } from "../shared/rarity.ts";

export type Ratio = Record<StatKey, number>;

/** 解析 "2:3:0:1" → [2,3,0,1]（顺序固定为 力量:智力:运气:耐力） */
export function parseRatio(input: unknown): number[] | null {
  const parts = String(input ?? "")
    .split(/[:：,，\s]+/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (parts.length !== 4) return null;
  const nums = parts.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (nums.every((n) => n === 0)) return null;
  return nums as number[];
}

export function parseTargets(input: unknown): number[] | null {
  const r = parseRatio(input);
  // 目标值允许全 0（表示不加点）
  if (r) return r;
  const parts = String(input ?? "")
    .split(/[:：,，\s]+/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (parts.length !== 4) return null;
  const nums = parts.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums as number[];
}

/** 读四维已投入（缺字段按 0） */
export function investedOf(base: unknown): number[] {
  const b = (base ?? {}) as Record<string, unknown>;
  return STAT_KEYS.map((k) => {
    const v = Number(b[k]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  });
}

/**
 * 配置里的主属性名 → STAT_KEYS 下标；名字不认识时退回「智力」。
 *
 * ★ 单独抽成函数并加测试，是因为这里踩过坑：
 *   原写法 `Math.max(0, STAT_KEYS.indexOf(x)) || 1` —— 下标 **0 是 falsy**，
 *   于是用户选「力量」（STAT_KEYS[0]）会被静默改成下标 1 的「智力」：
 *   界面上勾了力量，点数全加到智力上，而且没有任何报错。
 */
export function statIndex(primary: unknown): number {
  const idx = (STAT_KEYS as readonly string[]).indexOf(String(primary));
  return idx >= 0 ? idx : 1;
}

export type AllocationPlan = {
  /** 四维投放数量（顺序与 STAT_KEYS 一致，全部字段都会出现） */
  amounts: number[];
  /** 给用户看的说明 */
  notes: string[];
};

/**
 * 算出本轮投放方案（纯函数，便于单测）。
 *
 * @param mode      策略
 * @param unspent   可用点数
 * @param invested  四维已投入
 * @param ratio     权重（ratio / priority 用）
 * @param targets   目标值（target 用）
 * @param primary   主属性下标（priority 用）
 * @param autoReset 是否允许洗点搬运
 * @param minPoints 门槛
 */
export function planAllocation(input: {
  mode: string;
  unspent: number;
  invested: number[];
  ratio: number[] | null;
  targets: number[] | null;
  primary: number;
  autoReset: boolean;
  minPoints: number;
}): AllocationPlan | { error: string } | { skip: string } {
  const { mode, unspent, invested, ratio, targets, primary, autoReset, minPoints } = input;
  const amounts = [0, 0, 0, 0];
  const notes: string[] = [];

  if (unspent < minPoints) return { skip: `可用点数 ${unspent} 未达门槛（${minPoints}）` };

  if (mode === "priority") {
    amounts[primary] = unspent;
  } else if (mode === "ratio") {
    if (!ratio) return { error: "配比配置无效" };
    const total = ratio.reduce((a, b) => a + b, 0);
    if (total <= 0) return { error: "配比全为 0" };
    let left = unspent;
    // 最后一维吃掉舍入余数，保证 sum(amounts) === unspent。
    // 这是刻意与旧版保持一致的分配顺序（从力量到耐力依次取 floor 份额）。
    STAT_KEYS.forEach((_k, i) => {
      const isLast = i === STAT_KEYS.length - 1;
      const share = isLast ? left : Math.floor((unspent * (ratio[i] ?? 0)) / total);
      amounts[i] = Math.max(0, share);
      left -= amounts[i] as number;
    });
    // 理论上 left 此时为 0（最后一维已吃掉全部剩余）；防御性兜底
    if (left > 0) amounts[STAT_KEYS.length - 1] = (amounts[STAT_KEYS.length - 1] as number) + left;
  } else if (mode === "target") {
    if (!targets) return { error: "目标值配置无效" };

    const missing = targets.map((t, i) => Math.max(0, Math.floor(t) - (invested[i] ?? 0)));
    const missingTotal = missing.reduce((a, b) => a + b, 0);
    const surplus = invested.reduce((a, have, i) => a + Math.max(0, have - Math.floor(targets[i] ?? 0)), 0);

    if (missingTotal === 0) return { skip: "已全部达到目标值" };

    if (unspent >= missingTotal) {
      missing.forEach((m, i) => (amounts[i] = m));
      const leftover = unspent - missingTotal;
      if (leftover > 0) notes.push(`溢出 ${leftover} 点留存（目标已满）`);
    } else {
      const canRecover = surplus > 0 && unspent + surplus >= missingTotal;
      if (canRecover && autoReset) {
        // 洗点搬运：调用方负责真正执行 statsReset 并重算
        return { error: "__NEED_RESET__" };
      }
      if (canRecover && !autoReset) {
        return { skip: `需搬运 ${surplus} 点才能补齐目标，未开启「自动洗点搬运」，点数保留` };
      }
      // 无法补齐：按 力量→智力→运气→耐力 顺序尽量填，不超额
      let pool = unspent;
      missing.forEach((m, i) => {
        const put = Math.min(pool, m);
        amounts[i] = put;
        pool -= put;
      });
      if (pool > 0) notes.push(`目标未达成（缺 ${missingTotal - unspent} 点），本次先投 ${unspent} 点`);
    }
  } else {
    return { error: `未知策略：${mode}` };
  }

  const total = amounts.reduce((a, b) => a + b, 0);
  if (total <= 0) return { skip: "按当前策略没有可分配的点" };
  if (total < minPoints) return { skip: `可投放 ${total} 点低于门槛 ${minPoints}，保留` };

  return { amounts, notes };
}

const definition: ModuleDefinition = {
  id: "auto-stats",
  name: "自动加点",
  version: "2.0.0",
  description:
    "有可用属性点时自动分配。支持「主属性优先」「按比例」「加到目标值」三种策略；目标模式下点数已达标的属性不再动，避免浪费。",
  defaultEnabled: false,
  defaultConfig: {
    mode: "priority",
    primary: "intelligence",
    ratio: "2:3:0:1",
    targets: "0:2000:0:100",
    autoReset: false,
    minPoints: 1,
  },
  configSchema: [
    {
      key: "mode",
      type: "select",
      label: "加点策略",
      default: "priority",
      options: [
        { value: "priority", label: "主属性优先（全部投给主属性）" },
        { value: "ratio", label: "按比例分摊" },
        { value: "target", label: "加到目标值" },
      ],
    },
    {
      key: "primary",
      type: "select",
      label: "主属性（priority 模式）",
      default: "intelligence",
      options: STAT_KEYS.map((k) => ({ value: k, label: STAT_LABELS[k] })),
    },
    {
      key: "ratio",
      type: "string",
      label: "配比（ratio 模式）",
      hint: "四项按 力量:智力:运气:耐力 的顺序，用冒号分隔，例如 2:3:0:1",
      default: "2:3:0:1",
      placeholder: "2:3:0:1",
    },
    {
      key: "targets",
      type: "string",
      label: "目标值（target 模式）",
      hint: "四项按 力量:智力:运气:耐力 的顺序。某位写 0 表示该属性不加",
      default: "0:2000:0:100",
      placeholder: "0:2000:0:100",
    },
    {
      key: "autoReset",
      type: "boolean",
      label: "允许自动洗点搬运",
      hint: "目标模式下点数不够时，自动重置再按目标重配。会消耗洗点资源，默认关闭。",
      default: false,
    },
    {
      key: "minPoints",
      type: "number",
      label: "至少累积多少点才加",
      default: 1,
      min: 1,
      max: 1000,
      step: 1,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      allocating: boolean;
      lastIdle: string;
      pendingTimer: NodeJS.Timeout | null;
      lastRunAt: number;
    };
    S.allocating = false;
    S.lastIdle = "";
    S.pendingTimer = null;
    S.lastRunAt = 0;

    const skipOnce = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("自动加点", msg);
    };

    const detail = (amounts: number[]) =>
      STAT_KEYS.map((k, i) => (amounts[i] ? `${STAT_LABELS[k]}+${amounts[i]}` : null)).filter(Boolean).join("、");

    const allocate = async (trigger: string) => {
      if (S.allocating) return;
      S.allocating = true;
      try {
        const me = await ctx.api.me();
        const player = me?.player;
        if (!player) return;

        let unspent = Math.max(0, Math.floor(Number(player.unspentStatPoints) || 0));
        const minPoints = Math.max(1, Math.floor(Number(ctx.config.minPoints) || 1));
        if (unspent < minPoints) {
          skipOnce(`${trigger}：可用点数 ${unspent} 未达门槛（${minPoints}）`);
          return;
        }

        const mode = String(ctx.config.mode ?? "priority");
        const primaryIdx = statIndex(ctx.config.primary);

        const callPlan = (invested: number[], spendable: number) =>
          planAllocation({
            mode,
            unspent: spendable,
            invested,
            ratio: parseRatio(ctx.config.ratio),
            targets: parseTargets(ctx.config.targets),
            primary: primaryIdx,
            autoReset: Boolean(ctx.config.autoReset),
            minPoints,
          });

        let invested = investedOf(player.stats?.base);
        let plan = callPlan(invested, unspent);

        // target 模式判定需要洗点：执行一次 reset 后重算
        if ("error" in plan && plan.error === "__NEED_RESET__") {
          ctx.log.info("自动加点", `${trigger}：点数不足，执行洗点搬运`);
          await ctx.api.statsReset();
          const me2 = await ctx.api.me();
          unspent = Math.max(0, Math.floor(Number(me2?.player?.unspentStatPoints) || 0));
          invested = investedOf(me2?.player?.stats?.base);
          plan = callPlan(invested, unspent);
        }

        if ("error" in plan) {
          ctx.log.warn("自动加点", `${trigger}：${plan.error}`);
          return;
        }
        if ("skip" in plan) {
          skipOnce(`${trigger}：${plan.skip}`);
          return;
        }

        // 四个字段必须全部出现（含 0），否则服务端拒绝
        const body = {
          strength: plan.amounts[0] ?? 0,
          intelligence: plan.amounts[1] ?? 0,
          luck: plan.amounts[2] ?? 0,
          endurance: plan.amounts[3] ?? 0,
        };
        const total = plan.amounts.reduce((a, b) => a + b, 0);

        const r = await ctx.api.statsAllocate(body);
        const left = r?.player?.unspentStatPoints;
        ctx.log.info(
          "自动加点",
          `✅ 分配 ${total} 点 → ${detail(plan.amounts)}` +
            (plan.notes.length ? `（${plan.notes.join("；")}）` : "") +
            (left != null ? `，剩余待分配 ${left}` : ""),
        );
        S.lastIdle = "";
      } catch (err) {
        ctx.log.warn("自动加点", `${trigger} 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.allocating = false;
        S.lastRunAt = Date.now();
      }
    };

    /** 延后执行（合并同一波内的多次触发） */
    const scheduleRun = (delayMs: number) => {
      if (S.pendingTimer) return;
      S.pendingTimer = ctx.schedule(delayMs, () => {
        S.pendingTimer = null;
        void allocate("点数到账");
      });
    };

    // 升级点数随 fishing:sync 的 playerPatch 到账 → 延后 3 秒合并一批
    ctx.on("fishing:sync", (evt: any) => {
      const patchUnspent = Number(evt?.playerPatch?.unspentStatPoints);
      if (patchUnspent > 0) scheduleRun(3000);
    });

    // 兜底轮询：没有渔获时也要能加点
    ctx.every(45_000, () => void allocate("定时检查"));

    // 启动后尽快跑一次
    ctx.schedule(15_000, () => void allocate("启动检查"));
  },
};

export default definition;

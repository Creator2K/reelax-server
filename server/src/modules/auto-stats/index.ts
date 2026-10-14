// 自动加点：把可用属性点按策略分配
//
// 协议（实测）：
//  - GET  /api/me → player.unspentStatPoints 待分配点数
//                   player.stats.base        四维已投入
//  - POST /api/player/stats/allocate { strength, intelligence, luck, endurance }
//    ★ 四个字段必须**全部出现**（可为 0），缺字段会被服务端拒绝
//  - POST /api/player/stats/reset 洗点（会消耗资源，默认不允许）
//
// 三种策略：
//   priority 全部点数投入**顺序里的第一项**
//   ratio    按权重分摊（权重就是列表里的数字），余数给顺序的最后一项
//   target   按目标值缺口补齐；点数不够时**按用户排的顺序**依次填（可洗点搬运）
//
// ★ 顺序由用户决定（配置里的 `statPlan`：有序 + 带数值的列表）。
//   旧版是 "2:3:0:1" 这种**按固定位置解释**的字符串，顺序写死在代码里
//   （力量:智力:运气:耐力），用户既改不了「先加谁」，写错顺序也不会报错 ——
//   真踩过：`Math.max(0, STAT_KEYS.indexOf(x)) || 1` 把「力量」静默换成「智力」。
import { type ModuleDefinition } from "../types.ts";
import { STAT_KEYS, STAT_LABELS, type StatKey } from "../shared/rarity.ts";

/** 配置里的「属性顺序 + 数值」一项 */
export type StatPlanItem = { key: string; value: number };

/** 归一化配置里的 statPlan：只认四维、按配置顺序保留、缺的补 0 */
export function readStatPlan(input: unknown): { key: StatKey; value: number }[] {
  const raw = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const out: { key: StatKey; value: number }[] = [];

  for (const item of raw) {
    const key = String((item as { key?: unknown })?.key ?? "");
    if (!(STAT_KEYS as readonly string[]).includes(key) || seen.has(key)) continue;
    seen.add(key);
    const v = Number((item as { value?: unknown })?.value);
    out.push({ key: key as StatKey, value: Number.isFinite(v) && v > 0 ? Math.floor(v) : 0 });
  }
  for (const key of STAT_KEYS) {
    if (!seen.has(key)) out.push({ key, value: 0 });
  }
  return out;
}

/** 读四维已投入（缺字段按 0） */
export function investedOf(base: unknown): number[] {
  const b = (base ?? {}) as Record<string, unknown>;
  return STAT_KEYS.map((k) => {
    const v = Number(b[k]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  });
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
 * @param mode      策略：priority / ratio / target
 * @param unspent   可用点数
 * @param invested  四维已投入（与 STAT_KEYS 同序）
 * @param plan      属性顺序 + 数值（顺序 = 用户排的先后）
 * @param autoReset 是否允许洗点搬运
 * @param minPoints 门槛
 */
export function planStatAllocation(input: {
  mode: string;
  unspent: number;
  invested: number[];
  plan: { key: StatKey; value: number }[];
  autoReset: boolean;
  minPoints: number;
}): AllocationPlan | { error: string } | { skip: string } {
  const { mode, unspent, invested, plan, autoReset, minPoints } = input;
  const amounts = [0, 0, 0, 0];
  const notes: string[] = [];

  if (unspent < minPoints) return { skip: `可用点数 ${unspent} 未达门槛（${minPoints}）` };
  if (!plan.length) return { error: "属性列表为空" };

  /** 用户排出来的顺序（下标 → STAT_KEYS 下标） */
  const order = plan.map((p) => STAT_KEYS.indexOf(p.key));
  const valueAt = (statIdx: number) => plan.find((p) => STAT_KEYS.indexOf(p.key) === statIdx)?.value ?? 0;

  if (mode === "priority") {
    // 全部投给顺序里的第一项（旧版是单独一个「主属性」下拉框，现在顺序本身就是它）
    amounts[order[0]!] = unspent;
  } else if (mode === "ratio") {
    const weights = plan.map((p) => Math.max(0, Math.floor(p.value)));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return { error: "配比全为 0（请在属性列表里填权重）" };

    let left = unspent;
    // ★ 按**用户排的顺序**依次取整，余数给顺序里的最后一项（既保证 sum=unspent，也可预期）
    order.forEach((statIdx, pos) => {
      const isLast = pos === order.length - 1;
      const share = isLast ? left : Math.floor((unspent * (weights[pos] ?? 0)) / total);
      amounts[statIdx] = Math.max(0, share);
      left -= amounts[statIdx] as number;
    });
    if (left > 0) {
      const last = order[order.length - 1]!;
      amounts[last] = (amounts[last] as number) + left;
    }
    notes.push(
      `配比 ${plan.map((p) => `${STAT_LABELS[p.key]}${Math.max(0, Math.floor(p.value))}`).join(":")}` +
        `（余数给 ${STAT_LABELS[plan[plan.length - 1]!.key]}）`,
    );
  } else if (mode === "target") {
    const missing = new Array(4).fill(0) as number[];
    for (let i = 0; i < 4; i++) missing[i] = Math.max(0, valueAt(i) - (invested[i] ?? 0));
    const missingTotal = missing.reduce((a, b) => a + b, 0);
    const surplus = invested.reduce((a, have, i) => a + Math.max(0, have - valueAt(i)), 0);

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
      // 无法补齐：**按用户排的顺序**依次填，不超额（旧版写死 力量→智力→运气→耐力）
      let pool = unspent;
      for (const statIdx of order) {
        const put = Math.min(pool, missing[statIdx] ?? 0);
        amounts[statIdx] = put;
        pool -= put;
        if (pool <= 0) break;
      }
      notes.push(`目标未达成（缺 ${missingTotal - unspent} 点），本次按顺序先投 ${unspent} 点`);
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
  version: "3.0.0",
  description:
    "有可用属性点时自动分配。属性顺序由你拖动决定，每种策略都按这个顺序执行：「全部投给第一项」「按配比分摊（余数给最后一项）」「按目标值补齐（点数不够时按顺序依次填）」。",
  defaultEnabled: false,
  defaultConfig: {
    mode: "target",
    statPlan: [
      { key: "intelligence", value: 2000 },
      { key: "endurance", value: 100 },
      { key: "strength", value: 0 },
      { key: "luck", value: 0 },
    ],
    autoReset: false,
    minPoints: 1,
  },
  configSchema: [
    {
      key: "mode",
      type: "select",
      label: "加点策略",
      hint:
        "三种策略都用下面那份「属性顺序 + 数值」，只是数字的含义不同：\n" +
        "到目标值 = 数字是各属性的目标值；按配比 = 数字是权重；全部给第一项 = 数字忽略。",
      default: "target",
      options: [
        { value: "target", label: "到目标值（数字 = 目标值）" },
        { value: "ratio", label: "按配比（数字 = 权重）" },
        { value: "priority", label: "全部投给第一项" },
      ],
    },
    {
      key: "statPlan",
      type: "order-number",
      label: "属性顺序与数值",
      hint:
        "拖动或用 ↑ ↓ 调整顺序：到目标值模式下顺序决定「点数不够时先补谁」，按配比模式下余数给最后一项，" +
        "「全部给第一项」模式下顺序第一项就是主属性。",
      default: [
        { key: "intelligence", value: 2000 },
        { key: "endurance", value: 100 },
        { key: "strength", value: 0 },
        { key: "luck", value: 0 },
      ],
      options: STAT_KEYS.map((k) => ({ value: k, label: STAT_LABELS[k] })),
      unit: "值",
      min: 0,
      max: 10_000_000,
      step: 1,
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

        const mode = String(ctx.config.mode ?? "target");
        const statPlan = readStatPlan(ctx.config.statPlan);

        const callPlan = (invested: number[], spendable: number) =>
          planStatAllocation({
            mode,
            unspent: spendable,
            invested,
            plan: statPlan,
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

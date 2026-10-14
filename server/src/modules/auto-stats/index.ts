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

/** 天气缓存时长：切方案前要读当前地图天气，但不必每 45 秒都问一次 */
const WEATHER_TTL_MS = 60_000;
/** 方案切换的确认延时：天气偶尔抖动时不要来回洗点 */
const SWITCH_CONFIRM_MS = 60_000;
/** 奥秘涌流的天气 id（与自动换饵 / 自动切图一致） */
const ARCANE_SURGE = "arcane_surge";

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

/**
 * 「把全部点数按这套方案从零重配一次会得到什么」。
 *
 * 用途：判断切换方案时要不要洗点 —— 只要当前配点已经等于这个结果，
 * 就不该白花一次洗点（游戏洗点有成本）。
 */
export function planFromScratch(input: {
  mode: string;
  plan: { key: StatKey; value: number }[];
  totalPoints: number;
}): number[] | null {
  const r = planStatAllocation({
    mode: input.mode,
    unspent: Math.max(0, Math.floor(input.totalPoints)),
    invested: [0, 0, 0, 0],
    plan: input.plan,
    autoReset: false,
    minPoints: 1,
  });
  return "amounts" in r ? r.amounts : null;
}

/** 两组投放量是否等价（都与 STAT_KEYS 同序） */
export function sameAllocation(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

const definition: ModuleDefinition = {
  id: "auto-stats",
  name: "自动加点",
  version: "4.0.0",
  description:
    "有可用属性点时自动分配。属性顺序由你拖动决定，每种策略都按这个顺序执行：「全部投给第一项」「按配比分摊（余数给最后一项）」「按目标值补齐（点数不够时按顺序依次填）」。可另配一套「涌流方案」：奥秘涌流期间自动洗点切成它，涌流结束后切回平时方案。",
  defaultEnabled: false,
  defaultConfig: {
    mode: "target",
    statPlan: [
      { key: "intelligence", value: 2000 },
      { key: "endurance", value: 100 },
      { key: "strength", value: 0 },
      { key: "luck", value: 0 },
    ],
    surgeEnabled: false,
    surgeMode: "target",
    surgePlan: [
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
      key: "surgeEnabled",
      type: "boolean",
      label: "奥秘涌流期间切换到另一套方案",
      hint:
        "涌流期间（当前地图天气 = 奥秘涌流）按下面的「涌流方案」重配属性，涌流结束后切回上面的平时方案。\n" +
        "★ 切换需要**洗点重配**：游戏洗点会消耗资源（金币或遗物），所以只在「当前配点 ≠ 目标方案」时才动手；" +
        "两套方案一样时不会洗点。",
      default: false,
    },
    {
      key: "surgeMode",
      type: "select",
      label: "涌流方案：策略",
      hint: "与平时那套同义：到目标值 = 数字是目标值；按配比 = 数字是权重；全部给第一项 = 数字忽略。",
      default: "target",
      options: [
        { value: "target", label: "到目标值（数字 = 目标值）" },
        { value: "ratio", label: "按配比（数字 = 权重）" },
        { value: "priority", label: "全部投给第一项" },
      ],
    },
    {
      key: "surgePlan",
      type: "order-number",
      label: "涌流方案：属性顺序与数值",
      hint:
        "默认与平时一致（所以只看不改 = 不会洗点）。想让涌流期间堆某项，就把它拖到第一行并把数值调大：\n" +
        "例如「全部给第一项 + 运气在第一位」= 涌流期间所有点数都给运气；「按配比 3:2:0:0」= 按权重分摊。",
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
      label: "允许自动洗点搬运 / 切换方案",
      hint:
        "需要洗点才能达成方案时自动洗点（会消耗资源，默认关闭）。两种情况会用到它：\n" +
        "· 目标模式下点数不够、得把加错的点搬回来；\n" +
        "· 开启了「涌流期间切换方案」，且当前配点与目标方案不一致。",
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
      /** 当前已应用哪套方案："normal" / "surge"（跨重启保留，避免重启就再洗一次点） */
      appliedPlan: string;
      /** 待确认的方案切换（防天气抖动来回洗点） */
      pendingPlan: string;
      pendingSince: number;
      /** 天气缓存（省掉每 45 秒一次接口调用；只是缓存，跨重启残留也没关系） */
      weatherSurge?: boolean;
      weatherAt?: number;
    };
    S.allocating = false;
    S.lastIdle = "";
    S.pendingTimer = null;
    S.lastRunAt = 0;
    S.appliedPlan = typeof S.appliedPlan === "string" ? S.appliedPlan : "";
    S.pendingPlan = "";
    S.pendingSince = 0;

    const skipOnce = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("自动加点", msg);
    };

    const detail = (amounts: number[]) =>
      STAT_KEYS.map((k, i) => (amounts[i] ? `${STAT_LABELS[k]}+${amounts[i]}` : null)).filter(Boolean).join("、");

    /** 四个字段必须全部出现（含 0），否则服务端拒绝 */
    const bodyOf = (amounts: number[]) => ({
      strength: amounts[0] ?? 0,
      intelligence: amounts[1] ?? 0,
      luck: amounts[2] ?? 0,
      endurance: amounts[3] ?? 0,
    });

    /* ---------- 两套方案（平时 / 奥秘涌流） ---------- */
    const normal = { mode: String(ctx.config.mode ?? "target"), plan: readStatPlan(ctx.config.statPlan) };
    const surge = { mode: String(ctx.config.surgeMode ?? "target"), plan: readStatPlan(ctx.config.surgePlan) };
    const surgeEnabled = ctx.config.surgeEnabled === true;
    const autoReset = Boolean(ctx.config.autoReset);
    const planLabel = (target: "surge" | "normal") => (target === "surge" ? "涌流方案" : "平时方案");
    const planCfg = (target: "surge" | "normal") => (target === "surge" ? surge : normal);

    /** 当前已应用到哪套方案（跨重启保留；"" = 还没判断过） */
    const appliedPlan = () => (S.appliedPlan === "surge" ? "surge" : S.appliedPlan === "normal" ? "normal" : null);

    /**
     * 当前地图天气是不是「奥秘涌流」。
     * 拿不到天气时返回 null —— 此时**什么都不切**（保持现状），避免因为一次接口失败就洗点。
     * 结果缓存在 state 里（60 秒），不必每 45 秒都问一次。
     */
    const surgeActive = async (): Promise<boolean | null> => {
      const now = Date.now();
      if (typeof S.weatherSurge === "boolean" && now - (S.weatherAt || 0) < WEATHER_TTL_MS) return S.weatherSurge;
      try {
        const d = await ctx.api.biomes();
        const cur = (d?.biomes ?? []).find((b: any) => b?.isCurrent);
        const id = cur?.weather?.weatherId ?? cur?.weather?.id ?? null;
        if (!id) return null;
        S.weatherSurge = id === ARCANE_SURGE;
        S.weatherAt = now;
        return S.weatherSurge;
      } catch {
        return null;
      }
    };

    /**
     * 切换到目标方案（必要时洗点重配）。
     *
     * ★ 只在「当前配点 ≠ 那套方案从零重配的结果」时才洗点：
     *   游戏洗点有成本，两套方案一样、或已经在那套配点上时白洗一次毫无意义。
     * ★ 没开「允许自动洗点搬运 / 切换方案」时只提示，不动手（下次还会再判断）。
     */
    const switchPlan = async (
      target: "surge" | "normal",
      now: { invested: number[]; unspent: number },
    ): Promise<boolean> => {
      const cfg = planCfg(target);
      const total = now.invested.reduce((a, b) => a + b, 0) + now.unspent;
      const desired = planFromScratch({ mode: cfg.mode, plan: cfg.plan, totalPoints: total });
      S.pendingPlan = "";

      if (!desired) {
        S.appliedPlan = target;
        ctx.log.warn("自动加点", `${planLabel(target)}的配置无效，跳过切换`);
        return false;
      }
      if (sameAllocation(now.invested, desired)) {
        S.appliedPlan = target;
        S.lastIdle = "";
        ctx.log.info("自动加点", `🔄 ${planLabel(target)}已生效（当前配点就是它，未洗点）`);
        return false;
      }
      if (!autoReset) {
        skipOnce(
          `需要洗点才能切到${planLabel(target)}（当前配点与它不一致），但未开启「允许自动洗点搬运 / 切换方案」`,
        );
        return false;
      }

      ctx.log.info("自动加点", `🔄 切换到${planLabel(target)}：先洗点，再按方案重配（共 ${total} 点）`);
      await ctx.api.statsReset();
      const me2 = await ctx.api.me();
      const unspent2 = Math.max(0, Math.floor(Number(me2?.player?.unspentStatPoints) || 0));
      const after = planStatAllocation({
        mode: cfg.mode,
        unspent: unspent2,
        invested: [0, 0, 0, 0],
        plan: cfg.plan,
        autoReset: false,
        minPoints: 1,
      });
      if ("amounts" in after) {
        const r = await ctx.api.statsAllocate(bodyOf(after.amounts));
        S.appliedPlan = target;
        S.lastIdle = "";
        ctx.log.info(
          "自动加点",
          `✅ ${planLabel(target)}已生效 → ${detail(after.amounts)}` +
            (r?.player?.unspentStatPoints != null ? `，剩余待分配 ${r.player.unspentStatPoints}` : ""),
        );
      } else {
        // 洗了点却没配上：如实记下来（下一轮会再判断）
        ctx.log.warn(
          "自动加点",
          `洗点后按${planLabel(target)}重配失败：${"skip" in after ? after.skip : after.error}`,
        );
      }
      return true;
    };

    const allocate = async (trigger: string) => {
      if (S.allocating) return;
      S.allocating = true;
      try {
        const me = await ctx.api.me();
        const player = me?.player;
        if (!player) return;

        let unspent = Math.max(0, Math.floor(Number(player.unspentStatPoints) || 0));
        let invested = investedOf(player.stats?.base);
        const minPoints = Math.max(1, Math.floor(Number(ctx.config.minPoints) || 1));

        /* ---------- 方案切换：在加点之前判断（没有待分配点数时也要能切） ---------- */
        if (surgeEnabled) {
          const active = await surgeActive();
          const want: "surge" | "normal" | null = active === null ? null : active ? "surge" : "normal";
          if (want && appliedPlan() !== want) {
            const confirmSec = Math.round(SWITCH_CONFIRM_MS / 1000);
            // 等一小会儿再动手：天气偶尔抖动时不要来回洗点
            if (S.pendingPlan !== want) {
              S.pendingPlan = want;
              S.pendingSince = Date.now();
              skipOnce(`${trigger}：检测到要切到${planLabel(want)}，等 ${confirmSec} 秒确认（本轮先不加点）`);
              return;
            }
            if (Date.now() - S.pendingSince < SWITCH_CONFIRM_MS) {
              // 等待确认期间不按旧方案加点：否则刚加的这几点马上会被洗掉重配
              skipOnce(`${trigger}：等 ${confirmSec} 秒确认${planLabel(want)}，本轮先不加点`);
              return;
            }
            const switched = await switchPlan(want, { invested, unspent });
            if (switched) return; // 刚洗完点重配完，剩余点数下一轮再补
            // 没洗（不需要 / 未开启）：继续走下面的加点点数流程
          } else if (want) {
            S.pendingPlan = "";
            if (!appliedPlan()) S.appliedPlan = want; // 首次判断：记下来，之后靠它判断"状态变了"
          }
        }

        if (unspent < minPoints) {
          skipOnce(`${trigger}：可用点数 ${unspent} 未达门槛（${minPoints}）`);
          return;
        }

        // 用**当前生效的那套方案**加点（涌流期间就是涌流方案）
        const activeCfg = surgeEnabled && appliedPlan() === "surge" ? surge : normal;
        const mode = activeCfg.mode;
        const statPlan = activeCfg.plan;

        const callPlan = (curInvested: number[], spendable: number) =>
          planStatAllocation({
            mode,
            unspent: spendable,
            invested: curInvested,
            plan: statPlan,
            autoReset,
            minPoints,
          });

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

        const total = plan.amounts.reduce((a, b) => a + b, 0);

        const r = await ctx.api.statsAllocate(bodyOf(plan.amounts));
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

    // 启动后尽快跑一次（返回 Promise 便于测试 await，定时器本身忽略它）
    ctx.schedule(15_000, () => allocate("启动检查"));
  },
};

export default definition;

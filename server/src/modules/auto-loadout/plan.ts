// 配装时间表的解析与取值
//
// 语法（每行一条；空行、以 # 或 // 开头的注释行会被忽略）：
//
//   09:00 1          每天 09:00 起使用「1 号配装」
//   21:00 比赛套      每天 21:00 起使用名字叫「比赛套」的配装
//
// 语义是「到点生效」的里程碑，没有时间空档：
//   当前该用哪一个 = 时间 ≤ 现在的最后一条；今天还没有任何一条到点，就用昨天的最后一条。
//   例：`09:00 1` + `21:00 2` → 09:00~21:00 用 1 号，21:00~次日 09:00 用 2 号。
//
// 时间表的解析与「到点取值」在 modules/shared/schedule.ts（与「航线助手调度」共用）；
// 这里只负责把「值」解释成配装号 / 配装名，并把它解析成真实的配装。
import {
  MAX_SCHEDULE_LINES,
  describeSchedule,
  parseSchedule,
  pickScheduleEntry,
  type ScheduleEntry,
} from "../shared/schedule.ts";
import { type Loadout, loadoutLabel } from "./loadout.ts";

export type PlanTarget = { kind: "slot"; slot: number } | { kind: "name"; name: string };

/** 一条配装时间表（= 通用时间表条目 + 解释后的目标） */
export type PlanEntry = ScheduleEntry & { target: PlanTarget };

export type PlanParseResult = {
  entries: PlanEntry[];
  errors: string[];
};

/** 时间表行数上限（与通用时间表一致） */
export const MAX_PLAN_LINES = MAX_SCHEDULE_LINES;

const clip = (s: string): string => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

/** 目标的可读写法 */
export function describeTarget(t: PlanTarget): string {
  return t.kind === "slot" ? `${t.slot} 号配装` : `「${t.name}」`;
}

/** 同一条目标是否指向同一个配装（用于判断「已经切过了」） */
export function targetKey(t: PlanTarget): string {
  return t.kind === "slot" ? `#${t.slot}` : `@${t.name}`;
}

/** 解析时间表；非法行收进 errors，由调用方展示 */
export function parsePlan(text: unknown): PlanParseResult {
  const { entries, errors } = parseSchedule(text, { valueLabel: "配装号或配装名" });

  const out: PlanEntry[] = [];
  for (const e of entries) {
    if (/^\d+$/.test(e.value)) {
      const slot = Number(e.value);
      if (slot < 1 || slot > 99) {
        errors.push(`第 ${e.line} 行「${clip(e.raw)}」配装号 ${slot} 超出范围（1 ~ 99）`);
        continue;
      }
      out.push({ ...e, target: { kind: "slot", slot } });
    } else {
      out.push({ ...e, target: { kind: "name", name: e.value } });
    }
  }
  return { entries: out, errors };
}

/**
 * 现在该用哪一条。
 * 没有一条到点（凌晨且第一条在更晚）→ 用最后一条（= 昨天最后生效的那条）。
 */
export function pickPlanEntry(entries: PlanEntry[], now: Date): PlanEntry | null {
  return pickScheduleEntry(entries, now);
}

/** 配装号/配装名 → 真实配装（找不到返回 null，并给出原因） */
export function resolveTarget(
  target: PlanTarget,
  loadouts: Loadout[],
): { ok: true; loadout: Loadout } | { ok: false; reason: string } {
  if (target.kind === "slot") {
    const found = loadouts.find((l) => l.slot === target.slot);
    if (!found) {
      return { ok: false, reason: `没有 ${target.slot} 号配装（可用：${loadouts.map(loadoutLabel).join("、") || "无"}）` };
    }
    if (!found.name) return { ok: false, reason: `${target.slot} 号配装是空的，先在游戏里存一套进去` };
    return { ok: true, loadout: found };
  }

  const wanted = target.name.trim();
  const found = loadouts.find((l) => l.name && l.name.trim() === wanted);
  if (!found) {
    const named = loadouts.filter((l) => l.name);
    return {
      ok: false,
      reason:
        `没有叫「${target.name}」的配装` +
        (named.length ? `（现有：${named.map(loadoutLabel).join("、")}）` : "（还没有任何已保存的配装）"),
    };
  }
  return { ok: true, loadout: found };
}

/** 配置预览：把时间表摊平成人类可读的几行 */
export function describePlan(text: unknown, now: Date, timeZone: string): string[] {
  const { entries, errors } = parsePlan(text);
  const lines = entries.length
    ? [`时间表（按容器时区 ${timeZone} 判断）`]
    : [];

  lines.push(
    ...describeSchedule(entries, now, {
      emptyHint: "写法：每行「HH:MM 配装号或配装名」，例如「09:00 1」「21:00 比赛套」。",
      valueOf: (e) => describeTarget(e.target),
    }),
  );

  for (const err of errors) lines.push(`⚠ ${err}`);
  return lines;
}

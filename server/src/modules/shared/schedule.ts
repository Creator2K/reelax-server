// 时间表解析（「HH:MM 值」一行一条）—— 供「定时配装」「航线助手调度」共用
//
// 语法（每行一条；空行、以 # 或 // 开头的注释行会被忽略）：
//
//   09:00 1
//   21:00 比赛套
//
// 语义是「到点生效」的里程碑，没有时间空档：
//   当前该用哪一条 = 时间 ≤ 现在的最后一条；今天还没有任何一条到点，就用昨天的最后一条。
//   例：`09:00 A` + `21:00 B` → 09:00~21:00 用 A，21:00~次日 09:00 用 B。
//   想中途换回来，再加一条即可（`22:00 A`）。
//
// 为什么是文本：配置面板由 configSchema 驱动，文本能直接复用 textarea 与「配置预览」，
// 前端一行都不用改；而且解析与取值都是纯函数，可以脱离网络单测。
//
// `值` 的含义由调用方决定（配装号/配装名、on/off……），本文件只负责「时间 + 值」的切分与排序。
// 这也是它与「配装」解耦的原因：两个功能共用同一套时间表语义，避免各写一份解析后来走样。

export type ScheduleEntry = {
  /** 一天中的第几分钟（0~1439） */
  minutes: number;
  /** 展示用 HH:MM */
  at: string;
  /** 冒号后面那一串（原样保留首尾已去空白的文本） */
  value: string;
  /** 来源行号（1 起，报错与日志里指出来源） */
  line: number;
  /** 原始行 */
  raw: string;
};

export type ScheduleParseResult = {
  entries: ScheduleEntry[];
  errors: string[];
};

/** 时间表行数上限：防手滑贴进一大段文本把预览刷爆 */
export const MAX_SCHEDULE_LINES = 200;

export const pad2 = (n: number): string => String(n).padStart(2, "0");

const clip = (s: string): string => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

/**
 * 解析时间表。
 * 非法行**不抛错**：收集到 errors 里由调用方展示 —— 用户可能正在编辑，
 * 不能因为一行写错就让整张表罢工。
 *
 * @param opts.valueLabel 值那一段在报错里的说法（例如「配装号或配装名」「on / off」）
 */
export function parseSchedule(text: unknown, opts: { valueLabel?: string } = {}): ScheduleParseResult {
  const valueLabel = opts.valueLabel ?? "值";
  const errors: string[] = [];
  const raw = typeof text === "string" ? text : "";
  const lines = raw.split(/\r?\n/);
  if (lines.length > MAX_SCHEDULE_LINES) {
    errors.push(`时间表最多 ${MAX_SCHEDULE_LINES} 行，多出来的已忽略`);
  }

  const parsed: ScheduleEntry[] = [];
  for (const [i, line] of lines.slice(0, MAX_SCHEDULE_LINES).entries()) {
    const s = line.trim();
    if (!s || s.startsWith("#") || s.startsWith("//")) continue;
    const lineNo = i + 1;

    const m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})\s*(.*)$/.exec(s);
    if (!m) {
      errors.push(`第 ${lineNo} 行「${clip(s)}」看不懂：应为「HH:MM ${valueLabel}」`);
      continue;
    }
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) {
      errors.push(`第 ${lineNo} 行「${clip(s)}」时间非法（只能是 00:00 ~ 23:59）`);
      continue;
    }

    // 分隔符可写可不写：`09:00 1` / `09:00 = 1` / `09:00 -> 比赛套`
    const value = (m[3] ?? "").replace(/^\s*(?:=|->|→|,|，|:)?\s*/, "").trim();
    if (!value) {
      errors.push(`第 ${lineNo} 行「${clip(s)}」只写了时间，没写${valueLabel}`);
      continue;
    }

    parsed.push({ minutes: hh * 60 + mm, at: `${pad2(hh)}:${pad2(mm)}`, value, line: lineNo, raw: s });
  }

  // 同一时刻写了两条：以最后一条为准（用户的直觉是「后写的覆盖前面的」）
  const byMinutes = new Map<number, ScheduleEntry>();
  for (const e of parsed) {
    if (byMinutes.has(e.minutes)) errors.push(`时刻 ${e.at} 重复，以最后一条「${clip(e.raw)}」为准`);
    byMinutes.set(e.minutes, e);
  }

  return { entries: [...byMinutes.values()].sort((a, b) => a.minutes - b.minutes), errors };
}

/**
 * 现在该用哪一条。
 * 没有一条到点（凌晨且第一条在更晚）→ 用最后一条（= 昨天最后生效的那条）。
 * 泛型是为了让调用方拿回自己的条目类型（例如带 `target` 的配装条目）。
 */
export function pickScheduleEntry<T extends ScheduleEntry>(entries: T[], now: Date): T | null {
  if (!entries.length) return null;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let best: T | null = null;
  for (const e of entries) {
    if (e.minutes <= nowMinutes) best = e;
  }
  return best ?? entries[entries.length - 1] ?? null;
}

/** 时间表的通用预览：列出每一条并标出当前生效的那条（泛型同 pickScheduleEntry） */
export function describeSchedule<T extends ScheduleEntry>(
  entries: T[],
  now: Date,
  opts: { emptyHint: string; valueOf: (e: T) => string },
): string[] {
  const lines: string[] = [];
  if (!entries.length) {
    lines.push("时间表是空的 —— 本功能不会做任何事。");
    lines.push(opts.emptyHint);
    return lines;
  }
  const current = pickScheduleEntry(entries, now);
  for (const e of entries) {
    lines.push(`${e.at} 起 → ${opts.valueOf(e)}${e === current ? "   ← 现在生效" : ""}`);
  }
  return lines;
}

/* ---------- 「到点开/关」这一类时间表（两处共用） ---------- */

export type OnOffEntry = ScheduleEntry & { on: boolean };

const ON_WORDS = new Set(["on", "开", "开启", "打开", "启用", "true", "1", "yes", "y"]);
const OFF_WORDS = new Set(["off", "关", "关闭", "停", "停用", "false", "0", "no", "n"]);

/**
 * 解析「HH:MM on / off」时间表。
 * 中英文与 1/0 都认 —— 用户手写时间表时不该因为写「开」而报错。
 */
export function parseOnOffPlan(text: unknown, valueLabel = "on / off"): ScheduleParseResult & { entries: OnOffEntry[] } {
  const { entries, errors } = parseSchedule(text, { valueLabel });

  const out: OnOffEntry[] = [];
  for (const e of entries) {
    const word = e.value.trim().toLowerCase();
    if (ON_WORDS.has(word)) out.push({ ...e, on: true });
    else if (OFF_WORDS.has(word)) out.push({ ...e, on: false });
    else errors.push(`第 ${e.line} 行「${e.raw}」只能写 on / off（或 开 / 关），写的是「${e.value}」`);
  }
  return { entries: out, errors };
}

/** 现在该开还是该关（没有一条到点则用昨天的最后一条） */
export function pickOnOffEntry(entries: OnOffEntry[], now: Date): OnOffEntry | null {
  return pickScheduleEntry(entries, now);
}

/**
 * 这一条**最近一次生效**的时刻（毫秒）。
 *
 * 用途：区分「已经执行过这一档」与「刚跨过这一档」。
 * 「定时启停账号」这种东西**不能**每 30 秒强制对齐一次状态 ——
 * 那样用户手动点「停止」会在半分钟内被拉起来，看起来像关不掉。
 * 只在跨过新的一档时动作，手动操作就能一直保留到下一档。
 */
export function milestoneOccurrence(entry: ScheduleEntry, now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const at = midnight + entry.minutes * 60_000;
  return at <= now.getTime() ? at : at - 86_400_000;
}

/** 「开/关」时间表的预览 */
export function describeOnOffPlan(
  text: unknown,
  now: Date,
  timeZone: string,
  opts: { title: string; onLabel: string; offLabel: string; emptyHint: string; valueLabel?: string },
): string[] {
  const { entries, errors } = parseOnOffPlan(text, opts.valueLabel);
  const lines = entries.length ? [`${opts.title}（按容器时区 ${timeZone} 判断）`] : [];

  lines.push(
    ...describeSchedule(entries, now, {
      emptyHint: opts.emptyHint,
      valueOf: (e) => (e.on ? opts.onLabel : opts.offLabel),
    }),
  );

  for (const err of errors) lines.push(`⚠ ${err}`);
  return lines;
}

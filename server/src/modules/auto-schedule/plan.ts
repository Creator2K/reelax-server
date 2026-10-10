// 定时挂机：时间表的解析与预览
//
// ★ 这个功能的执行者**不在这个模块里**：账号级启停由服务端调度器负责
//   （services/account-schedule-service.ts）—— 因为账号一旦被停掉，模块自己也停了，
//   靠模块自己是永远起不来的。模块只提供「配置入口 + 开关 + 日志」。
//
// 时间表语法与「航线助手调度」完全一致（解析在 modules/shared/schedule.ts）：
//
//   08:00 on        每天 08:00 起启动这个账号
//   02:00 off       每天 02:00 起停止这个账号
import { describeOnOffPlan, parseOnOffPlan, pickOnOffEntry, type OnOffEntry } from "../shared/schedule.ts";

export type SchedulePlanEntry = OnOffEntry;

export const PLAN_VALUE_LABEL = "on / off";

/** 解析「定时挂机」时间表 */
export function parseSchedulePlan(text: unknown): { entries: SchedulePlanEntry[]; errors: string[] } {
  return parseOnOffPlan(text, PLAN_VALUE_LABEL);
}

/** 现在该开还是该关 */
export function pickSchedulePlanEntry(entries: SchedulePlanEntry[], now: Date): SchedulePlanEntry | null {
  return pickOnOffEntry(entries, now);
}

/** 配置预览 */
export function describeSchedulePlan(text: unknown, now: Date, timeZone: string): string[] {
  return describeOnOffPlan(text, now, timeZone, {
    title: "定时启停",
    onLabel: "启动账号",
    offLabel: "停止账号",
    emptyHint:
      "写法：每行「HH:MM on」或「HH:MM off」，例如「08:00 on」「02:00 off」。留空表示不按时间表启停。",
  });
}

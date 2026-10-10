// 模块配置预览
//
// 有些配置项的效果光看文字说明想象不出来（「日报包含哪些内容」「标题里加变量」）。
// 让模块自己提供一个预览函数，前端就能在配置表单旁边实时渲染出结果。
//
// 为什么做成注册表而不是在 configSchema 里加个 preview 字段：
// 预览逻辑是**可执行代码**，不该出现在给前端的数据结构里（那会变成一条隐蔽的
// 「配置下发即执行」通道）。放这里由服务端显式登记，边界清楚。
import { DEFAULT_DIGEST_TEMPLATE, findUnknownVars, previewDigestTemplate } from "./daily-digest/template.ts";
import { describePlan } from "./auto-loadout/plan.ts";
import { describeSchedulePlan } from "./auto-schedule/plan.ts";

/** 容器时区（预览里要说清「按哪个时区判断到点」） */
const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";

export type PreviewBuilder = (config: Record<string, unknown>) => string | string[] | null;

/**
 * moduleId → 预览函数。
 * 返回 null 表示「当前配置下没有可预览的内容」，前端会隐藏预览区。
 */
const BUILDERS: Record<string, PreviewBuilder> = {
  "daily-digest": (config) => {
    const template = String(config.template ?? "").trim() || DEFAULT_DIGEST_TEMPLATE;
    const lines = previewDigestTemplate(template);
    // 模板写错变量时在预览里直接点出来（比等到第二天早上发现强）
    const unknown = findUnknownVars(template);
    if (unknown.length) {
      lines.push("", `⚠ 不认识的变量（会原样显示）：${unknown.map((v) => `{${v}}`).join("、")}`);
    }
    return lines;
  },
  /**
   * 定时配装：时间表是文本，写错一行不会报错（只会不生效），
   * 所以把「解析成什么样、现在这条对应哪个配装」直接摊开给用户看。
   * 注意：预览只按时间表算，看不到该账号真实有哪些配装（那需要联网），
   * 「配装号/名字是否存在」在运行时校验并在日志里说明。
   */
  "auto-loadout": (config) => describePlan(config.plan, new Date(), localTimeZone()),
  /**
   * 定时挂机：时间表由服务端调度器执行（账号停着也会到点启动），
   * 预览里把「现在该开还是该关」摊开，用户一眼能核对。
   */
  "auto-schedule": (config) => describeSchedulePlan(config.plan, new Date(), localTimeZone()),
};

/** 取某模块的预览；没有预览能力时返回 null */
export function buildModulePreview(moduleId: string, config: Record<string, unknown>): string | string[] | null {
  const builder = BUILDERS[moduleId];
  if (!builder) return null;
  try {
    return builder(config);
  } catch {
    // 预览失败不该影响配置表单：安静地当作「没有预览」
    return null;
  }
}

/** 该模块是否支持预览（前端据此决定要不要请求） */
export function hasPreview(moduleId: string): boolean {
  return moduleId in BUILDERS;
}

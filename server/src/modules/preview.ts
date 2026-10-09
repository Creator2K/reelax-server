// 模块配置预览
//
// 有些配置项的效果光看文字说明想象不出来（「日报包含哪些内容」「标题里加变量」）。
// 让模块自己提供一个预览函数，前端就能在配置表单旁边实时渲染出结果。
//
// 为什么做成注册表而不是在 configSchema 里加个 preview 字段：
// 预览逻辑是**可执行代码**，不该出现在给前端的数据结构里（那会变成一条隐蔽的
// 「配置下发即执行」通道）。放这里由服务端显式登记，边界清楚。
import { DEFAULT_DIGEST_TEMPLATE, findUnknownVars, previewDigestTemplate } from "./daily-digest/template.ts";

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

// 官方航线助手（/api/convenience）冲突检测
//
// 背景：游戏自带「航线助手」，如果它也开着相同功能，两边会互相抢操作。
// 冲突分两档处理（这个分级是实测结论，不要「一刀切」拒绝启动）：
//
//   硬冲突（拒绝启动 + 运行中复查后停手）
//     · 自动换图 —— 两边都会把你换到别的地图，结果是谁也待不住
//
//   软冲突（只提示，不停手）
//     · 自动签到 —— 签到幂等，重复领只会返回 ALREADY_CLAIMED
//     · 渊潮围猎自动报名 —— 属性只认第一次选择，重复提交无副作用
//     · 赛事进图 —— 只让出「进图」这一步，报名照常
//
// 为什么软冲突不让位：官方助手要游戏页面打开、由前端触发；本服务是直连 API，
// 24 小时挂机也会执行。如果软冲突也拒绝启动，用户一开助手就永远启动失败。

/** settings 里的功能键 → 中文名 */
export const ASSISTANT_FEATURE_LABELS = {
  isAutoTravelEnabled: "自动换图",
  isAutoCheckInEnabled: "自动签到",
  isAutoBaitEnabled: "自动鱼饵",
  isAutoWorldBossRegistrationEnabled: "渊潮围猎自动报名",
  isAutoArcaneSacrificeEnabled: "奥秘献祭",
} as const;

export type AssistantFeatureKey = keyof typeof ASSISTANT_FEATURE_LABELS;

export type AssistantState = {
  isEnabled: boolean;
  /** 总开关打开且权益在有效期内 —— 助手真正干活的条件 */
  isOperational: boolean;
  settings: Record<string, unknown>;
  entitlementEndsAt: string | null;
};

/** 读取官方航线助手状态。任何异常都交给调用方决定怎么处理 */
export async function getAssistantState(api: { request: (path: string) => Promise<any> }): Promise<AssistantState> {
  const d = await api.request("/api/convenience");
  const ra = d?.routeAssistant ?? {};
  return {
    isEnabled: ra.isEnabled === true,
    isOperational: ra.isOperational === true,
    settings: (ra.settings ?? {}) as Record<string, unknown>,
    entitlementEndsAt: d?.entitlements?.["route-assistant"]?.endsAt ?? null,
  };
}

export class AssistantConflictError extends Error {
  readonly feature: AssistantFeatureKey;

  constructor(feature: AssistantFeatureKey, myName: string) {
    const label = ASSISTANT_FEATURE_LABELS[feature];
    super(
      `与官方航线助手冲突：助手已开启「${label}」。请先在游戏内关闭航线助手（或它的「${label}」开关），` +
        `再启用${myName}。两者同时工作会互相抢操作。`,
    );
    this.name = "AssistantConflictError";
    this.feature = feature;
  }
}

/** 读不到状态时用这个错误：软警告，不阻断启动 */
export class AssistantUnknownError extends Error {
  readonly softWarning = true;

  constructor(cause: unknown) {
    super(`无法读取官方航线助手状态（${cause instanceof Error ? cause.message : String(cause)}），已跳过冲突检查`);
    this.name = "AssistantUnknownError";
  }
}

/**
 * 启动前冲突检查：助手已生效且打开了指定功能时抛 AssistantConflictError。
 * 读取失败抛 softWarning 错误（调用方应只记日志、继续启动）—— fail-open。
 */
export async function assertNoAssistantConflict(
  api: { request: (path: string) => Promise<any> },
  feature: AssistantFeatureKey,
  myName: string,
): Promise<AssistantState> {
  let state: AssistantState;
  try {
    state = await getAssistantState(api);
  } catch (err) {
    throw new AssistantUnknownError(err);
  }
  if (state.isOperational && state.settings[feature]) {
    throw new AssistantConflictError(feature, myName);
  }
  return state;
}

export function isSoftWarning(err: unknown): boolean {
  return Boolean((err as { softWarning?: boolean })?.softWarning);
}

/**
 * 运行时软检测：助手中途被打开时，本模块应当停手。
 * 返回 true 表示「现在该停手」；读取失败返回 false（fail-open，不因一次网络抖动停掉挂机）。
 */
export async function assistantTakesOver(
  api: { request: (path: string) => Promise<any> },
  feature: AssistantFeatureKey,
): Promise<boolean> {
  try {
    const st = await getAssistantState(api);
    return st.isOperational && Boolean(st.settings[feature]);
  } catch {
    return false;
  }
}

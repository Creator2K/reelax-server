// React Query 查询键与数据钩子
//
// 账号列表的数据来源有两个：REST（首次/重连补齐）与 WS 快照（增量）。
// 两者写同一个 queryKey，因此页面只订阅一处，不会出现两份状态。
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { useRealtime, type LogEntry } from "./realtime.tsx";

export const ACCOUNTS_QUERY_KEY = ["accounts"] as const;
export const PROXIES_QUERY_KEY = ["proxies"] as const;
export const MODULES_QUERY_KEY = ["modules"] as const;

/* ---------- 账号 ---------- */

export type AccountStatus = "stopped" | "starting" | "online" | "reconnecting" | "error" | "expired";

export type ConfigIssue = { key: string; message: string; value: unknown };

export type ModuleRuntimeState = {
  id: string;
  /** 展示名（后端直接给出，前端不必再查模块清单） */
  name: string;
  enabled: boolean;
  running: boolean;
  startError: string | null;
  config: Record<string, unknown>;
  /** 旧版本遗留配置或取值异常（不影响运行，但要让用户看见） */
  configIssues: ConfigIssue[];
};

/** 保底进度（稀有鱼 / 宝箱 / 神器）—— 服务端已算好 remaining 与 percent */
export type PityProgress = {
  key: string;
  label: string;
  /** 已累计（杆 / 个） */
  dry: number;
  /** 硬保底阈值；null = 当前条件下游戏没有硬保底 */
  total: number | null;
  /** 还差多少（没有硬保底时为 null） */
  remaining: number | null;
  /** 0~100（没有硬保底时为 null） */
  percent: number | null;
  /** 下一杆/下一个必出 */
  ready: boolean;
  /** false = 当前条件无硬保底（界面写明，而不是把这一行藏掉） */
  hardPity: boolean;
};

/** 近 10 分钟同步健康度（服务端滚动窗口算好） */
export type SyncHealth = {
  windowSec: number;
  attempts: number;
  ok: number;
  failed: number;
  timeouts: number;
  /** 0~100；没有样本时为 null（显示「—」，不是 100%） */
  successRate: number | null;
  /** 当前连续失败次数（0 = 正常） */
  failStreak?: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
};

/**
 * 经验速率（服务端按近 30 分钟的**终身累计经验**增量算好）。
 *
 * 只有「每小时经验」：升级很快、本级经验会归零，所以「还要多久升级」那种预估一直在变，
 * 参考价值不大（用户明确要求去掉）。
 */
export type XpRate = {
  /** 实际覆盖的时间跨度（秒） */
  windowSec: number;
  /** 每小时经验 */
  perHour: number;
  /** 参与折算的样本数 */
  samples: number;
  /** 窗口内升了几级 */
  levelGain: number;
};

export type StatusPanel = {
  biomeId: string | null;
  biomeName: string | null;
  valueMultiplier: number | null;
  weatherId: string | null;
  weatherName: string | null;
  weatherXpPct: number;
  xpTotal: number;
  sections: Record<string, number>;
  buffs: { tag: string; bp: number; endsAt: string | null; source: string | null }[];
  guildBoosts: { biomeId: string; name: string; bp: number; endsAt: string | null }[];
  level: number | null;
  experience: number | null;
  experienceToNextLevel: number | null;
  gold: number | null;
  relics: number | null;
  fragments: number | null;
  baitId: string | null;
  baitName: string | null;
  baitUnitPrice: number | null;
  /** 保底进度（拿不到的项不出现） */
  pity: PityProgress[];
  /** 近 10 分钟的同步健康度（判断「结算变少」是不是链路问题） */
  sync: SyncHealth | null;
  /** 经验速率：每小时经验 + 按该速度估算的升级剩余时间（样本不足时为 null） */
  xpRate: XpRate | null;
  /** 当前是第几轮转生 */
  reincarnationRound?: number | null;
  fleet: { boatName: string | null; boatBiomeName: string | null; sameAsCurrent: boolean } | null;
  reincarnation: {
    requiredLevel: number | null;
    levelShortfall: number | null;
    goldCost: number | null;
    goldShortfall: number | null;
    awardedPoints: number | null;
    eligible: boolean;
  } | null;
  at?: number;
};

export type AccountStats = {
  startedAt: number;
  syncs: number;
  castsResolved: number;
  gold: number;
  experience: number;
  fishCount: number;
};

export type Account = {
  id: string;
  label: string;
  authType: "credentials" | "cookie";
  email: string;
  hasPassword: boolean;
  hasCookie: boolean;
  baseUrl: string;
  proxyId: string | null;
  proxyLabel: string | null;
  autoStart: boolean;
  status: AccountStatus;
  lastError: string | null;
  createdAt: number;
  /** 凭证是否可解密（MASTER_KEY 不匹配时为 false，前端要明确提示） */
  credentialOk: boolean;
  credentialError: string | null;
  player: { nickname: string | null; level: number | null; gold: number | null } | null;
  onlinePlayerCount: number | null;
  lastSyncAt: number | null;
  run: { id: string; status: string; totalCasts: number; remainingCasts: number } | null;
  modules: ModuleRuntimeState[];
  stats: AccountStats;
  statusPanel: StatusPanel | null;
};

export function useAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: () => api.get<Account[]>("/api/accounts"),
    staleTime: 5_000,
  });
}

export function useAccount(id: string | undefined) {
  const { data: accounts } = useAccounts();
  return accounts?.find((a) => a.id === id) ?? null;
}

/* ---------- 地图与天气（手动换图面板） ---------- */

export type MapWeather = { id: string; name: string; xpMultiplier: number };

export type MapItem = {
  id: string;
  name: string;
  isUnlocked: boolean;
  isCurrent: boolean;
  valueMultiplier: number;
  weather: MapWeather | null;
  /** 这张图上有比赛在跑 */
  competitionActive: boolean;
  /** 我报名的比赛就在这张图时的说明（进行中 / 即将开赛） */
  myCompetition: string | null;
  requiredLevel: number;
  unlockCost: number;
};

export type AccountMaps = {
  currentBiomeId: string | null;
  current: MapItem | null;
  party: { inParty: boolean; canChangeBoatBiome: boolean; boatName: string | null; boatBiomeId: string | null } | null;
  maps: MapItem[];
};

/**
 * 地图与天气：数据由服务端**强制刷新**一次游戏接口后返回（用户主动打开，看到的是"现在"）。
 * 缓存时间给短一点，切完图回来能立刻看到新的「当前地图」。
 */
export function useAccountMaps(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["account-maps", id],
    queryFn: () => api.get<AccountMaps>(`/api/accounts/${id}/maps`),
    enabled: Boolean(id) && enabled,
    staleTime: 15_000,
    retry: false,
  });
}

/* ---------- 内置模块清单 ---------- */

export type ConfigField =
  | { key: string; type: "boolean"; label: string; hint?: string; default?: boolean }
  | {
      key: string;
      type: "number";
      label: string;
      hint?: string;
      default?: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | { key: string; type: "string"; label: string; hint?: string; default?: string; placeholder?: string }
  | { key: string; type: "textarea"; label: string; hint?: string; default?: string; placeholder?: string }
  | {
      key: string;
      type: "select";
      label: string;
      hint?: string;
      default?: string;
      options: { value: string; label: string; hint?: string }[];
    }
  | {
      /** 从固定清单里挑几项（值是一组 id） */
      key: string;
      type: "multi-select";
      label: string;
      hint?: string;
      default?: string[];
      options: { value: string; label: string; hint?: string }[];
    }
  | {
      /** 有序列表：从固定清单里按顺序挑若干项（顺序有意义，值是一组 id） */
      key: string;
      type: "order";
      label: string;
      hint?: string;
      default?: string[];
      options: { value: string; label: string; hint?: string }[];
      min?: number;
    }
  | {
      /** 有序 + 带数值的列表：每一项都有一个数字，顺序也有意义 */
      key: string;
      type: "order-number";
      label: string;
      hint?: string;
      default?: { key: string; value: number }[];
      options: { value: string; label: string; hint?: string }[];
      unit?: string;
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      /**
       * 模板：一段带 {变量} 的文本。
       * vars / defaultTemplate 由服务端注入（单一来源），前端只负责渲染按钮。
       */
      key: string;
      type: "template";
      label: string;
      hint?: string;
      default?: string;
      placeholder?: string;
      rows?: number;
      vars?: { group: string; vars: { name: string; desc: string; token: string }[] }[];
      defaultTemplate?: string;
    };

export type ModuleDefinition = {
  id: string;
  name: string;
  description: string;
  version: string;
  defaultEnabled: boolean;
  defaultConfig: Record<string, unknown>;
  configSchema: ConfigField[];
  /** 该功能是否依赖推送通道（如收益日报） */
  requiresNotification: boolean;
  /** 非 null 表示当前不可用，内容是可展示给用户的原因 */
  unavailable: string | null;
};

export function useModuleDefinitions() {
  return useQuery({
    queryKey: MODULES_QUERY_KEY,
    queryFn: () => api.get<ModuleDefinition[]>("/api/modules"),
    // 通道状态会变（微信扫码成功/掉线），所以缓存别太久
    staleTime: 30_000,
  });
}

/* ---------- 推送通道 ---------- */

export type NotifyKind = "serverchan" | "wechat";
export type NotifyStatus = "idle" | "starting" | "qrcode" | "scanned" | "online" | "bound" | "error";

export type NotifyChannel = {
  id: string;
  kind: NotifyKind;
  label: string;
  enabled: boolean;
  /** 配置是否完整可用 */
  usable: boolean;
  status: NotifyStatus;
  statusDetail: string | null;
  target: { id: string; label: string | null } | null;
  /** 微信登录二维码内容（原始字符串，前端自己渲染成二维码） */
  qrText: string | null;
  sentCount: number;
  lastSentAt: number | null;
  lastError: string | null;
  createdAt: number;
  configHint: string | null;
  /** 微信：正在等用户把验证码发回给机器人 */
  awaitingVerify: boolean;
  /** 微信：验证码还有多久过期（毫秒） */
  verifyExpiresInMs: number | null;
  /**
   * 微信：当前有效的 6 位绑定验证码（没有则为 null）。
   * 只有通道所有者能看到（接口按 user_id 过滤）—— 用户要把它从微信发给机器人核对。
   */
  verifyCode: string | null;
};

export type NotifyAvailability = {
  hasUsableChannel: boolean;
  usableCount: number;
  total: number;
  hint: string | null;
};

export function useNotifyChannels() {
  return useQuery({
    queryKey: ["notify"],
    queryFn: () => api.get<NotifyChannel[]>("/api/notify"),
    // 微信扫码过程中状态会变，轮询快一点
    refetchInterval: (q) => {
      const data = q.state.data as NotifyChannel[] | undefined;
      const pending = data?.some((c) => c.status === "qrcode" || c.status === "starting" || c.status === "scanned");
      return pending ? 3000 : 30_000;
    },
  });
}

export function useNotifyAvailability() {
  return useQuery({
    queryKey: ["notify", "availability"],
    queryFn: () => api.get<NotifyAvailability>("/api/notify/availability"),
    staleTime: 10_000,
  });
}

/* ---------- 更新记录 ---------- */

export type ChangeKind = "feature" | "improve" | "fix";

export type ChangelogEntry = {
  version: string;
  date: string;
  title: string;
  notice?: string;
  changes: { kind: ChangeKind; text: string }[];
};

export type ChangelogResponse = {
  version: string;
  latest: ChangelogEntry;
  entries: ChangelogEntry[];
};

/**
 * 更新记录（公开接口，登录前也能取）。
 * 缓存久一点没关系：它只随发版变化。
 */
export function useChangelog() {
  return useQuery({
    queryKey: ["changelog"],
    queryFn: () => api.get<ChangelogResponse>("/api/auth/changelog"),
    staleTime: 30 * 60_000,
  });
}

/* ---------- 代理 ---------- */

export type ProxyRow = {
  id: string;
  label: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string | null;
  hasPassword: boolean;
  /** 绑定了该代理的账号数 */
  boundAccounts: number;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastCheckMs: number | null;
  lastExitIp: string | null;
  lastError: string | null;
  createdAt: number;
};

export function useProxies() {
  return useQuery({
    queryKey: PROXIES_QUERY_KEY,
    queryFn: () => api.get<ProxyRow[]>("/api/proxies"),
    staleTime: 10_000,
  });
}

/* ---------- 日志 ---------- */

/** 订阅实时日志流（只有用它的组件会重渲染） */
export function useLiveLogs(): LogEntry[] {
  const { logStore } = useRealtime();
  return useSyncExternalStore(logStore.subscribe, logStore.getSnapshot, logStore.getSnapshot);
}

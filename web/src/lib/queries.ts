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
  /** 硬保底阈值 */
  total: number;
  /** 还差多少 */
  remaining: number;
  /** 0~100 */
  percent: number;
  /** 下一杆/下一个必出 */
  ready: boolean;
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
      options: { value: string; label: string }[];
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

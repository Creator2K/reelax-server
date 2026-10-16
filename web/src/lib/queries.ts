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

/* ---------- 船队（组队） ---------- */

export type PartyInvitation = { id: string; from: string | null; boatName: string | null };

export type PartyMember = {
  publicId: string;
  nickname: string;
  level: number | null;
  role: "captain" | "helmsman" | "crew";
  biomeId: string | null;
  biomeName: string | null;
  fishing: "online" | "offline" | "none";
  /** 是否计入本船的经验加成（同船同图） */
  effective: boolean;
};

export type AccountParty = {
  inParty: boolean;
  boatName: string | null;
  boatBiomeId: string | null;
  boatBiomeName: string | null;
  /** 我在船上的身份 */
  role: "captain" | "helmsman" | "crew" | null;
  isCaptain: boolean;
  /** 能否改变船队航线（= 船长 / 舵手） */
  canChangeBoatBiome: boolean;
  /** 是否允许船长 / 舵手换图时把自己一起带走 */
  canBeSummoned: boolean;
  onBoat: boolean | null;
  /** 船队运营状态（停航待保养 / 租赁到期） */
  status: string | null;
  /** 邀请码（船长与船员都能分享） */
  joinCode: string | null;
  capacity: number | null;
  isCrowdfunded: boolean;
  /** 只有租用中的船可以转让船长 */
  canTransferCaptain: boolean;
  members: PartyMember[];
  /** 船长不能直接离开时的说明 */
  leaveBlockedReason: string | null;
  invitations: PartyInvitation[];
};

/** 船队状态：每次打开现读（船队状态变化频繁） */
export function useAccountParty(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["account-party", id],
    queryFn: () => api.get<AccountParty>(`/api/accounts/${id}/party`),
    enabled: Boolean(id) && enabled,
    staleTime: 10_000,
    retry: false,
  });
}

/* ---------- 交换助手（专精换鱼） ---------- */

export type SwapFishView = {
  fishId: string;
  name: string;
  /** `B2` 这种简称 */
  biomeCode: string | null;
  biomeName: string | null;
  rarity: string;
  rarityLabel: string;
};

export type SwapHopView = {
  orderId: string;
  owner: string | null;
  /** 这一对组合最多还能成交几次 */
  capacity: number;
  give: SwapFishView;
  get: SwapFishView;
};

export type SwapPathTarget = {
  fishId: string;
  name: string;
  rarity: string;
  rarityLabel: string;
  biomeId: string | null;
  biomeCode: string | null;
  biomeName: string | null;
  /** 这个目标还差几条 */
  remaining: number;
};

export type SwapPathView = {
  key: string;
  targetFishId: string;
  length: number;
  /** 起点鱼所在地图 */
  startBiomeId: string | null;
  startBiomeCode: string | null;
  /** 目标鱼完整信息（同一鱼种可能是多张图的专精目标，筛选与显示都用它，不去别处按 id 找） */
  target: SwapPathTarget;
  /** 目标地图等级 ≥ 起点地图等级（false = 高换低） */
  upgrade: boolean;
  hops: SwapHopView[];
};

export type SwapTargetView = {
  fishId: string;
  name: string;
  rarity: string;
  rarityLabel: string;
  biomeId: string | null;
  biomeCode: string | null;
  biomeName: string | null;
  /** 专精还差几条 */
  remaining: number;
  /** 背包里现在有几条 */
  available: number;
  /** 当前筛选下这个目标有几条可行链 */
  pathCount: number;
};

/** 批量「换 N 条」的进度 */
export type SwapRunView = {
  status: "idle" | "running" | "done" | "stopped";
  /** 本次打算换到几条 */
  targetCount: number;
  /** 已经换到几条 */
  doneCount: number;
  /** 当前正在走什么（没在跑就是 null） */
  current: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 结束说明：换够了 / 没得换了 / 被叫停 */
  note: string | null;
};

export type SwapLogEntry = { t: number; level: "info" | "warn" | "error"; text: string };

export type SwapState = {
  status: "idle" | "scanning" | "ready" | "error";
  progress: { phase: string; pages: number; orders: number };
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 执行过之后数据就旧了：提示重新扫描 */
  stale: boolean;
  result: {
    stats: {
      orders: number;
      edges: number;
      targets: number;
      paths: number;
      pages: number;
      truncated: boolean;
      scannedAt: number;
    };
    /** 下拉候选项（稀有度全列；地图跟着已选稀有度收窄） */
    options: {
      rarities: { value: string; label: string }[];
      biomes: { value: string; label: string }[];
    };
    /** 当前筛选下真有链的目标（服务端已经过滤好） */
    targets: SwapTargetView[];
    /** 当前筛选下的可行链（跳数少的在前） */
    paths: SwapPathView[];
    counts: {
      totalPaths: number;
      matchedPaths: number;
      totalTargets: number;
      chainTargets: number;
      matchedTargets: number;
      hopless: number;
      filteredTargets: number;
    };
  } | null;
  run: SwapRunView;
  /** 面板下方的日志（最近的在前） */
  log: SwapLogEntry[];
};

export type SwapExecuteResult = {
  ok: boolean;
  done: number;
  steps: { index: number; orderId: string; ok: boolean; error?: string }[];
  error?: string;
};

/** 交换助手的筛选条件（都可选，空 = 不限） */
export type SwapFilterInput = {
  rarity?: string | null;
  biomeId?: string | null;
  targetFishId?: string | null;
  /** true = 去掉「高等级地图换低等级地图」的链 */
  onlyUpgrade?: boolean;
};

/**
 * 交换助手的扫描 / 执行状态。
 *
 * 筛选条件作为查询参数发给服务端 —— 列表、下拉候选、计数都由服务端按同一份数据算好，
 * 面板不再自己过滤（否则「数字说 9 条、列表列了一堆」这种不一致迟早出现）。
 * 扫描与「换 N 条」进行中时自动轮询，都停下来就停止请求。
 */
export function useSwapState(accountId: string | undefined, filter: SwapFilterInput = {}, enabled = true) {
  const rarity = filter.rarity ?? "";
  const biomeId = filter.biomeId ?? "";
  const targetFishId = filter.targetFishId ?? "";
  const onlyUpgrade = filter.onlyUpgrade === true;

  return useQuery({
    queryKey: ["account-swap", accountId, rarity, biomeId, targetFishId, onlyUpgrade],
    queryFn: () =>
      api.get<SwapState>(`/api/accounts/${accountId}/swap`, {
        ...(rarity ? { rarity } : {}),
        ...(biomeId ? { biomeId } : {}),
        ...(targetFishId ? { targetFishId } : {}),
        ...(onlyUpgrade ? { onlyUpgrade: "true" } : {}),
      }),
    enabled: Boolean(accountId) && enabled,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => {
      const s = query.state.data;
      return s?.status === "scanning" || s?.run?.status === "running" ? 1500 : false;
    },
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

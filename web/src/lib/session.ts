// 会话：当前登录用户
//
// 用 React Query 缓存 /api/auth/me；401 时视为未登录（不抛给页面，交给路由守卫处理）。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api.ts";
import { clearUserQueries, replaceSession, SESSION_QUERY_KEY } from "./session-cache.ts";
export { SESSION_QUERY_KEY } from "./session-cache.ts";

export type UserRole = "user" | "admin";
export type UserStatus = "pending" | "approved" | "banned";

export type SessionUser = {
  id: string;
  /** 登录标识。历史上这一列存的是邮箱，现在新用户是用户名 */
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
  lastLoginAt: number | null;
  /** 该用户当前游戏账号数与上限 */
  accountCount: number;
  accountLimit: number;
  /** 单独设置的账号额度；null/缺失 = 跟随全局默认 */
  quotaOverride?: number | null;
};

export type SystemInfo = {
  version: string;
  baseUrl: string;
  allowRegistration: boolean;
  /** 注册是否需要邀请码（后台可关） */
  requireInvite: boolean;
  maxAccountsPerUser: number;
  /** 是否已有用户（首个注册者成为管理员） */
  hasUsers: boolean;
};

export const SYSTEM_QUERY_KEY = ["session", "system"] as const;

export async function fetchMe(): Promise<SessionUser | null> {
  try {
    const data = await api.get<{ user: SessionUser }>("/api/auth/me");
    return data.user;
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) return null;
    throw err;
  }
}

export function useSession() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      const user = await fetchMe();
      const previous = qc.getQueryData<SessionUser | null>(SESSION_QUERY_KEY);
      if (previous?.id !== user?.id) await clearUserQueries(qc);
      return user;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: SYSTEM_QUERY_KEY,
    queryFn: () => api.get<SystemInfo>("/api/auth/system"),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useAuthActions() {
  const qc = useQueryClient();

  return {
    /** 登录标识可以是用户名，也可以是历史上注册的邮箱 */
    async login(username: string, password: string): Promise<SessionUser> {
      const data = await api.post<{ user: SessionUser }>("/api/auth/login", { username, password });
      await replaceSession(qc, data.user);
      return data.user;
    },
    async register(input: {
      username: string;
      password: string;
      /** 可不填，后端会用用户名兜底 */
      displayName?: string;
      inviteCode?: string;
    }): Promise<{ user: SessionUser; becameAdmin: boolean }> {
      const data = await api.post<{ user: SessionUser; becameAdmin: boolean }>("/api/auth/register", input);
      await replaceSession(qc, data.user);
      return data;
    },
    async logout(): Promise<void> {
      try {
        await api.post("/api/auth/logout");
      } finally {
        await replaceSession(qc, null);
      }
    },
    async refresh(): Promise<void> {
      await qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  };
}

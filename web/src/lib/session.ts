// 会话：当前登录用户
//
// 用 React Query 缓存 /api/auth/me；401 时视为未登录（不抛给页面，交给路由守卫处理）。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api.ts";

export type UserRole = "user" | "admin";
export type UserStatus = "pending" | "approved" | "banned";

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
  lastLoginAt: number | null;
  /** 该用户当前游戏账号数与上限 */
  accountCount: number;
  accountLimit: number;
};

export type SystemInfo = {
  version: string;
  baseUrl: string;
  allowRegistration: boolean;
  maxAccountsPerUser: number;
  /** 是否已有用户（首个注册者成为管理员） */
  hasUsers: boolean;
};

export const SESSION_QUERY_KEY = ["session", "me"] as const;
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
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchMe,
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
    async login(email: string, password: string): Promise<SessionUser> {
      const data = await api.post<{ user: SessionUser }>("/api/auth/login", { email, password });
      qc.setQueryData(SESSION_QUERY_KEY, data.user);
      return data.user;
    },
    async register(input: {
      email: string;
      password: string;
      displayName: string;
      inviteCode?: string;
    }): Promise<{ user: SessionUser; becameAdmin: boolean }> {
      const data = await api.post<{ user: SessionUser; becameAdmin: boolean }>("/api/auth/register", input);
      qc.setQueryData(SESSION_QUERY_KEY, data.user);
      return data;
    },
    async logout(): Promise<void> {
      try {
        await api.post("/api/auth/logout");
      } finally {
        qc.setQueryData(SESSION_QUERY_KEY, null);
        qc.removeQueries({ queryKey: ["accounts"] });
        qc.removeQueries({ queryKey: ["proxies"] });
        qc.removeQueries({ queryKey: ["logs"] });
      }
    },
    async refresh(): Promise<void> {
      await qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  };
}

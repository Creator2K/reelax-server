// 业务写操作的 mutation 钩子
//
// 统一处理：成功 toast + 失效相关查询；失败由调用方 catch 后展示（useMutation 的 onError）。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "./api.ts";
import { ACCOUNTS_QUERY_KEY, MODULES_QUERY_KEY, PROXIES_QUERY_KEY } from "./queries.ts";
import { SYSTEM_QUERY_KEY } from "./session.ts";

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/* ---------------- 账号 ---------------- */

export type CreateAccountBody = {
  label?: string;
  authType: "credentials" | "cookie";
  email?: string;
  password?: string;
  cookie?: string;
  baseUrl?: string;
  proxyId?: string | null;
  autoStart?: boolean;
};

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccountBody) => api.post("/api/accounts", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      toast.success("账号已添加");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: {
        label?: string;
        email?: string;
        password?: string;
        cookie?: string;
        authType?: "credentials" | "cookie";
        autoStart?: boolean;
        proxyId?: string | null;
      };
    }) => api.patch(`/api/accounts/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      toast.success("已保存");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/accounts/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      toast.success("账号已删除");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useStartAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/accounts/${id}/start`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      toast.success("引擎已启动");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useStopAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/accounts/${id}/stop`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      toast.success("引擎已停止");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 模块 ---------------- */

export function useUpdateModule(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      moduleId,
      patch,
    }: {
      moduleId: string;
      patch: { enabled?: boolean; config?: Record<string, unknown> };
    }) => api.patch<{ states: unknown[]; startError: string | null }>(`/api/accounts/${accountId}/modules/${moduleId}`, patch),
    onSuccess: (data, vars) => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      // 后端会回报启动失败原因（例如与官方航线助手硬冲突）—— 必须让用户看到
      if (data?.startError) {
        toast.error(`「${vars.moduleId}」启动失败：${data.startError}`, { duration: 8000 });
      } else {
        toast.success("已保存");
      }
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useResetModule(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (moduleId: string) => api.post(`/api/accounts/${accountId}/modules/${moduleId}/reset`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      toast.success("已恢复默认配置");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 代理 ---------------- */

export type CreateProxyBody = {
  label?: string;
  url?: string;
  protocol?: "http" | "https" | "socks5";
  host?: string;
  port?: number;
  username?: string;
  password?: string;
};

export function useCreateProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProxyBody) => api.post("/api/proxies", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROXIES_QUERY_KEY });
      toast.success("代理已添加");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useUpdateProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: {
        label?: string;
        protocol?: "http" | "https" | "socks5";
        host?: string;
        port?: number;
        username?: string | null;
        password?: string;
      };
    }) => api.patch(`/api/proxies/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROXIES_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      toast.success("已保存");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useDeleteProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean; unboundAccounts: number }>(`/api/proxies/${id}`),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: PROXIES_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      toast.success(data?.unboundAccounts ? `代理已删除，${data.unboundAccounts} 个账号已改为直连` : "代理已删除");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export type ProxyTestResult = {
  ok: boolean;
  latencyMs: number | null;
  exitIp: string | null;
  status: number | null;
  errorCode: string | null;
  error: string | null;
  checkedAt: number;
};

/** 测试已保存的代理 */
export function useTestProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ProxyTestResult>(`/api/proxies/${id}/test`),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: PROXIES_QUERY_KEY });
      if (data.ok) {
        toast.success(`代理连通${data.latencyMs != null ? `（${data.latencyMs}ms` : ""}${data.exitIp ? `，出口 ${data.exitIp}` : ""}${data.latencyMs != null ? "）" : ""}`);
      } else {
        // 失败分类要展示给用户，否则无法判断是代理坏了还是游戏侧问题
        toast.error(data.error ?? "代理测试失败", { duration: 8000 });
      }
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/** 测试尚未保存的配置（「先测再用」） */
export function useTestProxyAdhoc() {
  return useMutation({
    mutationFn: (body: CreateProxyBody) => api.post<ProxyTestResult>("/api/proxies/test", body),
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 推送通道 ---------------- */

export const NOTIFY_QUERY_KEY = ["notify"] as const;
export const NOTIFY_AVAILABILITY_KEY = ["notify", "availability"] as const;

export type CreateNotifyBody =
  | { kind: "serverchan"; label?: string; sendkey: string }
  | { kind: "wechat"; label?: string };

export function useCreateNotify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateNotifyBody) => api.post("/api/notify", body),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: NOTIFY_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: NOTIFY_AVAILABILITY_KEY });
      void qc.invalidateQueries({ queryKey: MODULES_QUERY_KEY });
      toast.success(vars.kind === "serverchan" ? "Server酱 通道已添加" : "微信通道已添加，请扫码登录");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useUpdateNotify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { label?: string; enabled?: boolean } }) =>
      api.patch(`/api/notify/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NOTIFY_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: NOTIFY_AVAILABILITY_KEY });
      void qc.invalidateQueries({ queryKey: MODULES_QUERY_KEY });
      toast.success("已保存");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useDeleteNotify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/notify/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NOTIFY_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: NOTIFY_AVAILABILITY_KEY });
      void qc.invalidateQueries({ queryKey: MODULES_QUERY_KEY });
      toast.success("通道已删除");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export type NotifyTestResult = { ok: boolean; error?: string };

export function useTestNotify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<NotifyTestResult>(`/api/notify/${id}/test`),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: NOTIFY_QUERY_KEY });
      if (data.ok) toast.success("测试消息已发送，请查看手机");
      else toast.error(data.error ?? "发送失败", { duration: 8000 });
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/**
 * 微信通道动作：login（重新扫码）/ reconnect（用已保存凭证重连）/ unbind（换接收人）
 * / retry / bind-code（生成绑定验证码，在网页端展示，用户从微信发回来核对）
 */
export function useNotifyAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "login" | "reconnect" | "retry" | "unbind" | "bind-code";
    }) => api.post(`/api/notify/${id}/${action}`),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: NOTIFY_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: NOTIFY_AVAILABILITY_KEY });
      const label = {
        login: "已重新开始扫码登录",
        reconnect: "正在用已保存的登录状态重连",
        retry: "正在重连",
        unbind: "已解绑，请重新生成绑定验证码",
        "bind-code": "验证码已生成：请用微信把它发给机器人",
      }[vars.action];
      toast.success(label);
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 管理员：运行时设置 ---------------- */

export type SettingItem = {
  key: string;
  label: string;
  hint: string;
  type: "boolean" | "number";
  value: unknown;
  envValue: unknown;
  overridden: boolean;
};

export const SETTINGS_QUERY_KEY = ["admin", "settings"] as const;

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<{ changed: string[]; items: SettingItem[] }>("/api/admin/settings", { patch }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      // 注册开关会影响登录/注册页的文案
      void qc.invalidateQueries({ queryKey: SYSTEM_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["admin", "system"] });
      toast.success(data.changed.length ? `已保存 ${data.changed.length} 项，立即生效` : "没有变化");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 管理员：批量操作 ---------------- */

export type BulkAction = "ban" | "unban" | "promote" | "demote";

export function useBulkUpdateUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userIds: string[]; action: BulkAction }) =>
      api.post<{ updated: string[]; failed: { userId: string; reason: string }[] }>("/api/admin/users/bulk", input),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      void qc.invalidateQueries({ queryKey: ["admin", "audit"] });
      if (data.failed.length === 0) {
        toast.success(`已处理 ${data.updated.length} 个用户`);
      } else {
        // 部分失败要说清楚是什么原因（例如「不能封禁最后一个管理员」）
        toast.warning(`成功 ${data.updated.length} 个，失败 ${data.failed.length} 个：${data.failed[0]?.reason ?? ""}`, {
          duration: 9000,
        });
      }
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 在线更新 ---------------- */

export type UpdateStep = "idle" | "preflight" | "git-pull" | "install" | "build" | "recreate" | "done" | "failed";

export type UpdateProgress = {
  running: boolean;
  mode: "updater" | "local" | "none";
  step: UpdateStep;
  label: string;
  tail: string[];
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
  before: string | null;
  after: string | null;
};

export type UpdateCheck = {
  current: { sha: string; short: string; message: string; date: string | null; author: string | null } | null;
  latest: { sha: string; short: string; message: string; date: string | null; author: string | null } | null;
  hasUpdate: boolean;
  behindBy: number | null;
  branch: string | null;
  repo: string | null;
  canApplyLocal: boolean;
  updaterAvailable: boolean;
  manualHint: string | null;
  note: string | null;
};

export type UpdateApplyResult = { ok: boolean; message: string; restarting: boolean; log?: string };

/** 更新进度轮询：只在「正在更新」时保持较快的间隔，其余时间基本不打扰服务端 */
export function useUpdateProgress(enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "update", "status"],
    queryFn: () => api.get<UpdateProgress>("/api/admin/update/status"),
    enabled,
    refetchInterval: (q) => {
      const d = q.state.data as UpdateProgress | undefined;
      // 正在更新 → 1.5 秒看一次；已完成/失败 → 停
      if (!d) return 1500;
      return d.running ? 1500 : false;
    },
    // 更新期间服务会重启，请求失败是预期内的，不要反复弹错
    retry: false,
  });
}

export function useCheckUpdate() {
  return useMutation({
    mutationFn: () => api.get<UpdateCheck>("/api/admin/update/check"),
    onError: (err) => toast.error(errMessage(err)),
  });
}

/**
 * 探活：更新会重启服务，用它判断「服务回来了」。
 *
 * ★ 只判断 HTTP 200 是不够的：`docker compose up -d --build` 期间**旧容器一直在服务
 *   /api/health**（构建在前、重建在后），所以点完更新 8 秒就会探到 200，
 *   于是构建还在跑、甚至构建失败时，界面都显示「更新完成，服务已重启」。
 *   这里额外读 /api/health 的 uptime：只有「刚起来的进程」（uptime 很小）才算真重启过。
 */
const FRESH_UPTIME_MS = 180_000;

export async function probeHealth(timeoutMs = 3000): Promise<{ online: boolean; fresh: boolean }> {
  try {
    const r = await fetch("/api/health", { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { online: false, fresh: false };
    const j = (await r.json().catch(() => null)) as { uptime?: number } | null;
    const uptime = Number(j?.uptime);
    return { online: true, fresh: Number.isFinite(uptime) && uptime < FRESH_UPTIME_MS };
  } catch {
    return { online: false, fresh: false };
  }
}

export function useApplyUpdate() {
  return useMutation({
    mutationFn: () => api.post<UpdateApplyResult>("/api/admin/update/apply"),
    onSuccess: (data) => {
      if (data.ok) {
        toast.success(data.message, { duration: 12_000 });
      } else {
        toast.error(data.message, { duration: 12_000 });
      }
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 管理员：编辑用户（显示名 / 单独额度） ---------------- */

export function useEditUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      patch,
    }: {
      userId: string;
      patch: { displayName?: string; quotaOverride?: number | null };
    }) => api.patch(`/api/admin/users/${userId}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      void qc.invalidateQueries({ queryKey: ["admin", "audit"] });
      toast.success("已保存");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 管理员：重置用户口令 ---------------- */

export function useResetUserPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, password }: { userId: string; password: string }) =>
      api.post(`/api/admin/users/${userId}/password`, { password }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      toast.success("口令已重置，该用户的所有登录态已失效");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 个人设置 ---------------- */

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (displayName: string) => api.patch("/api/auth/profile", { displayName }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["session", "me"] });
      toast.success("显示名已更新");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) => api.post("/api/auth/password", body),
    onSuccess: () => {
      toast.success("口令已更新，请重新登录");
      // 改口令会作废全部会话，必须回登录页
      setTimeout(() => location.assign("/login"), 800);
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

/* ---------------- 管理 ---------------- */

/**
 * 通过「待确认」的账号。
 *
 * 注意：不再叫「批准」—— 注册早已不需要审批，这个动作只是把
 * 被管理员临时改成待确认的账号恢复为可用。
 */
export function useApproveUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/users/${id}/approve`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("已恢复为正常");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useSetUserStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: "pending" | "approved" | "banned" }) =>
      api.patch(`/api/admin/users/${id}/status`, { status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("状态已更新");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useSetUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: "user" | "admin" }) =>
      api.patch(`/api/admin/users/${id}/role`, { role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("角色已更新");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { maxUses?: number | null; expiresInDays?: number | null; note?: string }) =>
      api.post<{ code: string }>("/api/admin/invites", body),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["admin", "invites"] });
      toast.success(`邀请码已生成：${data.code}`, { duration: 10000 });
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export function useDeleteInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/admin/invites/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "invites"] });
      toast.success("邀请码已删除");
    },
    onError: (err) => toast.error(errMessage(err)),
  });
}

export { errMessage };

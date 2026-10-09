// 业务写操作的 mutation 钩子
//
// 统一处理：成功 toast + 失效相关查询；失败由调用方 catch 后展示（useMutation 的 onError）。
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "./api.ts";
import { ACCOUNTS_QUERY_KEY, MODULES_QUERY_KEY, PROXIES_QUERY_KEY } from "./queries.ts";

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

/** 微信通道动作：login（重新扫码）/ unbind（换接收人）/ retry（重试登录） */
export function useNotifyAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "login" | "unbind" | "retry" }) =>
      api.post(`/api/notify/${id}/${action}`),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: NOTIFY_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: NOTIFY_AVAILABILITY_KEY });
      const label = { login: "已开始重新登录，请扫码", unbind: "已解绑，请重新给机器人发一条消息", retry: "正在重试登录" }[vars.action];
      toast.success(label);
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

export function useApproveUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/users/${id}/approve`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("已批准");
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

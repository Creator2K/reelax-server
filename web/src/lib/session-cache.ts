import type { QueryClient } from "@tanstack/react-query";

export const SESSION_QUERY_KEY = ["session", "me"] as const;

/** 会话是缓存边界：先取消旧请求，再删除全部业务缓存（包括推送验证码和管理员数据）。 */
export async function clearUserQueries(qc: QueryClient): Promise<void> {
  const filters = { predicate: (q: { queryKey: readonly unknown[] }) =>
    !(q.queryKey.length === 2 && q.queryKey[0] === "session" && q.queryKey[1] === "me") };
  await qc.cancelQueries(filters);
  qc.removeQueries(filters);
  qc.getMutationCache().clear();
}

export async function replaceSession<T extends { id: string }>(qc: QueryClient, user: T | null): Promise<void> {
  await qc.cancelQueries({ queryKey: SESSION_QUERY_KEY, exact: true });
  await clearUserQueries(qc);
  qc.setQueryData(SESSION_QUERY_KEY, user);
}

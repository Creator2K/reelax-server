// 后台「用户管理」页签
//
// 功能：搜索（用户名/显示名）、状态与角色筛选、分页、勾选后批量操作
//      （封禁 / 解封 / 提升 / 降级）、单人改口令、查看账号数与注册/登录时间。
//
// 为什么批量走「逐条执行」而不是一条 SQL：单条逻辑里有「不能封自己」
// 「不能封禁最后一个管理员」这些约束，批处理绕过去会把管理员锁在门外。
// 服务端因此逐条执行并回报哪些失败、为什么失败。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import {
  IconAlertTriangle,
  IconCheck,
  IconEdit,
  IconKey,
  IconSearch,
  IconShieldLock,
  IconUserCheck,
  IconUserX,
  IconX,
} from "@tabler/icons-react";
import { Card } from "@/components/ui/card.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { api } from "@/lib/api.ts";
import { useSession, type SessionUser, type UserRole, type UserStatus } from "@/lib/session.ts";
import {
  useApproveUser,
  useBulkUpdateUsers,
  useEditUser,
  useResetUserPassword,
  useSetUserRole,
  useSetUserStatus,
} from "@/lib/mutations.ts";
import { cn } from "@/lib/utils.ts";

const PAGE_SIZE = 20;

type AdminUsersResponse = {
  users: SessionUser[];
  filtered: number;
  counts: { total: number; pending: number; approved: number; banned: number };
};

/** 状态文案：不再用「已审批」这种流程词，用户只关心正不正常 */
const STATUS_META: Record<UserStatus, { label: string; variant: "online" | "warn" | "error" }> = {
  approved: { label: "正常", variant: "online" },
  pending: { label: "待确认", variant: "warn" },
  banned: { label: "已封禁", variant: "error" },
};

export function UsersTab() {
  const { data: me } = useSession();
  const myId = me?.id ?? "";

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<UserStatus | "">("");
  const [role, setRole] = useState<UserRole | "">("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pwTarget, setPwTarget] = useState<SessionUser | null>(null);
  const [editTarget, setEditTarget] = useState<SessionUser | null>(null);

  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (status) params.set("status", status);
  if (role) params.set("role", role);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  const queryString = params.toString();

  const { data, isPending, error, isFetching } = useQuery({
    queryKey: ["admin", "users", queryString],
    queryFn: () => api.get<AdminUsersResponse>(`/api/admin/users?${queryString}`),
  });

  const approve = useApproveUser();
  const setStatusMut = useSetUserStatus();
  const setRoleMut = useSetUserRole();
  const bulk = useBulkUpdateUsers();

  const users = useMemo(() => data?.users ?? [], [data]);
  const counts = data?.counts;
  const filtered = data?.filtered ?? 0;
  const totalPages = Math.max(1, Math.ceil(filtered / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  /** 可被批量操作的目标（排除自己：不能封/降自己） */
  const selectable = users.filter((u) => u.id !== myId);
  const allSelected = selectable.length > 0 && selectable.every((u) => selected.has(u.id));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectable.map((u) => u.id)));
  };
  const toggleOne = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBulk = async (action: "ban" | "unban" | "promote" | "demote") => {
    if (!selected.size) return;
    await bulk.mutateAsync({ userIds: [...selected], action });
    setSelected(new Set());
  };

  return (
    <div className="space-y-4">
      {/* ---------- 筛选条 ---------- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <IconSearch className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
            placeholder="搜索用户名或显示名"
            className="pl-8"
            aria-label="搜索用户"
          />
        </div>

        <SelectChips
          value={status}
          onChange={(v) => {
            setStatus(v);
            setOffset(0);
          }}
          options={[
            { value: "", label: "全部状态" },
            { value: "approved", label: `正常 ${counts?.approved ?? 0}` },
            { value: "pending", label: `待确认 ${counts?.pending ?? 0}` },
            { value: "banned", label: `已封禁 ${counts?.banned ?? 0}` },
          ]}
        />
        <SelectChips
          value={role}
          onChange={(v) => {
            setRole(v);
            setOffset(0);
          }}
          options={[
            { value: "", label: "全部角色" },
            { value: "admin", label: "管理员" },
            { value: "user", label: "普通用户" },
          ]}
        />
      </div>

      {/* ---------- 批量操作条 ---------- */}
      <AnimatePresence>
        {selected.size > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="bg-muted flex flex-wrap items-center gap-2 rounded-2xl px-3.5 py-2.5"
          >
            <span className="text-xs">
              已选 <strong>{selected.size}</strong> 个
            </span>
            <Separator orientation="vertical" className="h-4" />
            <Button size="xs" variant="outline" onClick={() => void runBulk("ban")} disabled={bulk.isPending}>
              <IconUserX className="size-3.5" />
              封禁
            </Button>
            <Button size="xs" variant="outline" onClick={() => void runBulk("unban")} disabled={bulk.isPending}>
              <IconUserCheck className="size-3.5" />
              解封
            </Button>
            <Button size="xs" variant="outline" onClick={() => void runBulk("promote")} disabled={bulk.isPending}>
              <IconShieldLock className="size-3.5" />
              设为管理员
            </Button>
            <Button size="xs" variant="outline" onClick={() => void runBulk("demote")} disabled={bulk.isPending}>
              降为普通用户
            </Button>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              <IconX className="size-3.5" />
              取消选择
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ---------- 列表 ---------- */}
      {isPending ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertDescription>读取用户失败：{(error as Error).message}</AlertDescription>
        </Alert>
      ) : users.length === 0 ? (
        <Card className="py-10 text-center">
          <p className="text-muted-foreground text-sm">
            {q || status || role ? "没有符合筛选条件的用户" : "还没有用户"}
          </p>
        </Card>
      ) : (
        <Card className={cn("gap-0 overflow-hidden py-0", isFetching && "opacity-70")}>
          <div className="divide-border divide-y">
            {/* 表头：全选 */}
            <div className="bg-muted/40 flex items-center gap-3 px-4 py-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="size-3.5 accent-foreground"
                aria-label="全选"
                disabled={selectable.length === 0}
              />
              <span className="text-muted-foreground text-[11px]">
                共 {filtered} 个{filtered !== counts?.total ? `（全部 ${counts?.total ?? 0}）` : ""}
              </span>
            </div>

            {users.map((u, i) => {
              const st = STATUS_META[u.status];
              const isSelf = u.id === myId;
              return (
                <motion.div
                  key={u.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2, delay: Math.min(i * 0.015, 0.2) }}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggleOne(u.id)}
                    disabled={isSelf}
                    className="size-3.5 accent-foreground"
                    aria-label={`选择 ${u.displayName}`}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{u.displayName}</span>
                      {u.role === "admin" ? (
                        <Badge variant="secondary" className="gap-1">
                          <IconShieldLock className="size-3" />
                          管理员
                        </Badge>
                      ) : null}
                      <Badge variant={st.variant}>{st.label}</Badge>
                      {isSelf ? <Badge variant="outline">你</Badge> : null}
                    </div>
                    <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                      <span className="mono-num">{u.email}</span>
                      <span>
                        游戏账号 {u.accountCount} / {u.accountLimit}
                      </span>
                      <span>注册 {fmtShort(u.createdAt)}</span>
                      <span>{u.lastLoginAt ? `最近登录 ${fmtShort(u.lastLoginAt)}` : "从未登录"}</span>
                    </div>
                  </div>

                  <div className="row-actions flex shrink-0 flex-wrap items-center gap-1.5">
                    {u.status === "pending" ? (
                      <Button size="xs" onClick={() => approve.mutate(u.id)} disabled={approve.isPending}>
                        <IconCheck className="size-3.5" />
                        通过
                      </Button>
                    ) : null}
                    {u.status === "approved" && !isSelf ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setStatusMut.mutate({ id: u.id, status: "banned" })}
                        disabled={setStatusMut.isPending}
                      >
                        <IconUserX className="size-3.5" />
                        封禁
                      </Button>
                    ) : null}
                    {u.status === "banned" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setStatusMut.mutate({ id: u.id, status: "approved" })}
                        disabled={setStatusMut.isPending}
                      >
                        解封
                      </Button>
                    ) : null}
                    {!isSelf ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setRoleMut.mutate({ id: u.id, role: u.role === "admin" ? "user" : "admin" })}
                        disabled={setRoleMut.isPending}
                        title={u.role === "admin" ? "降为普通用户" : "设为管理员"}
                      >
                        {u.role === "admin" ? "降级" : "设为管理员"}
                      </Button>
                    ) : null}
                    <Button size="xs" variant="ghost" onClick={() => setPwTarget(u)} title="重置该用户的口令">
                      <IconKey className="size-3.5" />
                      改口令
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setEditTarget(u)} title="编辑显示名与账号额度">
                      <IconEdit className="size-3.5" />
                      编辑
                    </Button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ---------- 分页 ---------- */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-xs">
            第 {page} / {totalPages} 页
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              下一页
            </Button>
          </div>
        </div>
      ) : null}

      <ResetPasswordDialog target={pwTarget} onClose={() => setPwTarget(null)} />
      <EditUserDialog target={editTarget} onClose={() => setEditTarget(null)} />
    </div>
  );
}

/**
 * 编辑用户：显示名 + 单独的账号额度。
 *
 * 额度留空 = 跟随「后台设置」里的全局默认；填了就只对这个人生效。
 * 做成「留空跟随默认」而不是强制填数字，是为了让全局默认的改动
 * 能自动传导到大多数人（只有需要特例的人才填）。
 */
function EditUserDialog({ target, onClose }: { target: SessionUser | null; onClose: () => void }) {
  const edit = useEditUser();
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const [inited, setInited] = useState<string | null>(null);

  // 换目标时初始化表单（用 id 记标记，避免同一目标重复打开时状态残留）
  if (target && inited !== target.id) {
    setInited(target.id);
    setName(target.displayName);
    setQuota(target.quotaOverride == null ? "" : String(target.quotaOverride));
  }

  const close = () => {
    setInited(null);
    onClose();
  };

  const quotaNum = quota.trim() === "" ? null : Number(quota);
  const quotaBad = quotaNum !== null && (!Number.isFinite(quotaNum) || quotaNum < 1 || quotaNum > 100);
  const canSubmit = name.trim().length > 0 && !quotaBad;

  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑「{target?.displayName}」</DialogTitle>
          <DialogDescription>登录名（{target?.email}）不可修改。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="eu-name">显示名</Label>
            <Input id="eu-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="eu-quota">账号额度</Label>
            <Input
              id="eu-quota"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={quota}
              placeholder="留空 = 跟随全局默认"
              onChange={(e) => setQuota(e.target.value)}
              className="max-w-48"
            />
            {quotaBad ? (
              <p className="text-[var(--status-error)] text-xs">填 1~100 之间的整数，或留空跟随默认</p>
            ) : (
              <p className="text-muted-foreground text-xs">
                当前已用 {target?.accountCount ?? 0} 个
                {target?.quotaOverride == null ? "，额度跟随全局默认" : "，额度是单独设置的"}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <Button
            disabled={!canSubmit || edit.isPending}
            onClick={async () => {
              if (!target) return;
              await edit.mutateAsync({
                userId: target.id,
                patch: { displayName: name.trim(), quotaOverride: quotaNum },
              });
              close();
            }}
          >
            {edit.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一排「药丸」按钮做单选筛选（比下拉轻，且一眼看到各项数量） */
function SelectChips<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] transition-colors",
            value === o.value ? "bg-foreground text-background font-medium" : "bg-muted text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 重置口令对话框。
 *
 * 注意：重置会让目标用户的**所有登录态立刻失效**（包括他正在用的浏览器），
 * 所以文案里必须写清楚，避免管理员以为「只是改个密码」。
 */
export function ResetPasswordDialog({ target, onClose }: { target: SessionUser | null; onClose: () => void }) {
  const reset = useResetUserPassword();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");

  const close = () => {
    setPw("");
    setConfirm("");
    onClose();
  };

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const canSubmit = pw.length >= 8 && pw === confirm;

  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置「{target?.displayName}」的口令</DialogTitle>
          <DialogDescription>
            设置一个新口令。该用户当前的所有登录会立即失效，需要用新口令重新登录。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="rp-new">新口令（至少 8 位）</Label>
            <Input
              id="rp-new"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="new-password"
            />
            {tooShort ? <p className="text-[var(--status-error)] text-xs">至少 8 个字符</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="rp-confirm">再输一次</Label>
            <Input
              id="rp-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
            {mismatch ? <p className="text-[var(--status-error)] text-xs">两次输入不一致</p> : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <Button
            disabled={!canSubmit || reset.isPending}
            onClick={async () => {
              if (!target) return;
              await reset.mutateAsync({ userId: target.id, password: pw });
              close();
            }}
          >
            {reset.isPending ? "提交中…" : "重置口令"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 列表里的时间用短格式：只到分钟，省地方 */
function fmtShort(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

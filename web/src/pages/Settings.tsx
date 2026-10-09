// 个人设置：显示名 / 改口令 / 危险操作
import { useState } from "react";
import { IconLogout, IconShieldLock, IconTrash, IconUser } from "@tabler/icons-react";
import { PageContainer } from "@/components/layout/PageContainer.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useAuthActions, useSession } from "@/lib/session.ts";
import { useChangePassword, useUpdateProfile } from "@/lib/mutations.ts";
import { api } from "@/lib/api.ts";
import { toast } from "sonner";
import { fmtDateTime } from "@/lib/utils.ts";

export default function SettingsPage() {
  const { data: user } = useSession();
  const { logout } = useAuthActions();
  const updateProfile = useUpdateProfile();
  const changePassword = useChangePassword();

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  usePageHeader("个人设置", "账号信息与安全设置");

  const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const passwordInvalid = newPassword.length < 8 || newPassword !== confirmPassword || !currentPassword;

  return (
    <PageContainer>
      <div className="space-y-4">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <IconUser className="size-4" />
              账号信息
            </CardTitle>
            <CardDescription>显示名只影响控制台里的称呼，与游戏账号无关。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Row label="登录名" value={user?.email ?? "—"} />
              <Row label="角色" value={user?.role === "admin" ? "管理员" : "普通用户"} />
              {/* 状态文案与后台保持一致：用户只关心「正不正常」 */}
              <Row
                label="状态"
                value={user?.status === "approved" ? "正常" : user?.status === "pending" ? "待确认" : "已封禁"}
              />
              <Row label="注册时间" value={user?.createdAt ? fmtDateTime(user.createdAt) : "—"} />
              <Row label="最近登录" value={user?.lastLoginAt ? fmtDateTime(user.lastLoginAt) : "—"} />
              <Row label="账号配额" value={user ? `${user.accountCount} / ${user.accountLimit}` : "—"} />
            </div>

            <Separator />

            <div className="space-y-2">
              <Label htmlFor="set-name">显示名</Label>
              <div className="flex gap-2">
                <Input
                  id="set-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="max-w-64"
                />
                <Button
                  size="sm"
                  onClick={() => updateProfile.mutate(displayName)}
                  disabled={
                    updateProfile.isPending || !displayName.trim() || displayName.trim() === user?.displayName
                  }
                >
                  保存
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <IconShieldLock className="size-4" />
              修改口令
            </CardTitle>
            <CardDescription>
              修改后**所有登录会话都会失效**（包括当前会话），需要用新口令重新登录。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="set-cur">当前口令</Label>
              <Input
                id="set-cur"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="max-w-64"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="set-new">新口令</Label>
              <Input
                id="set-new"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="max-w-64"
              />
              <p className="text-muted-foreground text-xs">至少 8 个字符</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="set-confirm">确认新口令</Label>
              <Input
                id="set-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="max-w-64"
                aria-invalid={passwordMismatch}
              />
              {passwordMismatch ? <p className="text-destructive text-xs">两次输入的口令不一致</p> : null}
            </div>

            <Button
              size="sm"
              onClick={() => changePassword.mutate({ currentPassword, newPassword })}
              disabled={passwordInvalid || changePassword.isPending}
            >
              {changePassword.isPending ? "提交中…" : "修改口令"}
            </Button>
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-sm">会话</CardTitle>
            <CardDescription>如果你在别处登录过，或者怀疑凭证泄漏，可以一次性注销全部会话。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const r = await api.post<{ removed: number }>("/api/auth/logout-all");
                  toast.success(`已注销 ${r.removed} 个会话，请重新登录`);
                  setTimeout(() => location.assign("/login"), 800);
                } catch {
                  toast.error("操作失败");
                }
              }}
            >
              <IconLogout className="size-3.5" />
              注销全部会话
            </Button>
            <Button size="sm" variant="outline" onClick={() => void logout()}>
              退出登录
            </Button>
          </CardContent>
        </Card>

        <Alert variant="warn">
          <IconTrash />
          <AlertTitle>关于数据</AlertTitle>
          <AlertDescription>
            游戏凭证用 AES-256-GCM 加密保存，任何地方都无法再读回明文。删除账号会同时删掉它的配置与统计数据。
          </AlertDescription>
        </Alert>
      </div>
    </PageContainer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="outline" className="font-normal">
        {value}
      </Badge>
    </div>
  );
}

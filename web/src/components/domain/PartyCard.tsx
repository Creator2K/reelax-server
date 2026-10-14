// 船队（组队）面板：不打开游戏就能加入 / 离开船队、处理邀请、管理成员
//
// 为什么放在助手侧：船队只影响「组队经验加成」与「跟着船换图」，
// 而这两件事都由助手代管 —— 每次为了接受一条邀请去开游戏、点半天反而多余。
//
// 成员管理（任命舵手 / 移出成员 / 转让船长）只有**船长**能看到按钮；
// 游戏服务端也会再校验一次身份，所以这里只是"看不到就不点"的界面收敛。
import { useState } from "react";
import {
  IconAlertTriangle,
  IconAnchor,
  IconCheck,
  IconCopy,
  IconDoorExit,
  IconLoader2,
  IconMail,
  IconShip,
  IconUserMinus,
  IconUserPlus,
  IconUsers,
} from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useAccountParty, type PartyMember } from "@/lib/queries.ts";
import {
  useJoinParty,
  useLeaveParty,
  useManagePartyMember,
  useRespondPartyInvitation,
} from "@/lib/mutations.ts";

const ROLE_LABEL: Record<PartyMember["role"], string> = { captain: "船长", helmsman: "舵手", crew: "船员" };
const FISHING_LABEL: Record<PartyMember["fishing"], string> = {
  online: "在线钓鱼",
  offline: "离线钓鱼",
  none: "未钓鱼",
};

const STATUS_HINT: Record<string, string> = {
  maintenance_due: "停航待保养：经验、邀请、身份与协同切图暂时停止；成员仍可支付保养或离船。",
  rental_due: "租赁已到期：经验、邀请、身份与协同切图暂时停止；任意成员续租后即可恢复。",
};

export function PartyCard({ accountId }: { accountId: string }) {
  const { data, isPending, error } = useAccountParty(accountId);
  const join = useJoinParty(accountId);
  const leave = useLeaveParty(accountId);
  const respond = useRespondPartyInvitation(accountId);
  const manage = useManagePartyMember(accountId);

  const [code, setCode] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [kickTarget, setKickTarget] = useState<PartyMember | null>(null);
  const [transferTarget, setTransferTarget] = useState<PartyMember | null>(null);
  const [copied, setCopied] = useState(false);

  const busy = join.isPending || leave.isPending || respond.isPending || manage.isPending;
  const isCaptain = Boolean(data?.isCaptain);

  const copyCode = async () => {
    if (!data?.joinCode) return;
    try {
      await navigator.clipboard.writeText(data.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非 https / 未授权）时不打扰用户：码就在眼前，手动选中即可
    }
  };

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <IconShip className="size-4" />
          船队
          {busy ? <IconLoader2 className="text-muted-foreground size-3.5 animate-spin" /> : null}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {isPending ? <Skeleton className="h-16" /> : null}

        {error ? (
          <Alert variant="destructive">
            <IconAlertTriangle />
            <AlertDescription>读取船队失败：{(error as Error).message}</AlertDescription>
          </Alert>
        ) : null}

        {/* 停航 / 到期提示：这两句话解释了"为什么经验加成没了" */}
        {data?.status && STATUS_HINT[data.status] ? (
          <Alert>
            <IconAlertTriangle />
            <AlertDescription>{STATUS_HINT[data.status]}</AlertDescription>
          </Alert>
        ) : null}

        {/* 待处理邀请：有就放在最上面（最需要马上处理） */}
        {data?.invitations.length ? (
          <div className="space-y-1.5">
            <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              <IconMail className="size-3.5" />
              组队邀请 {data.invitations.length} 条
            </div>
            {data.invitations.map((inv) => (
              <div key={inv.id} className="bg-muted/40 flex items-center justify-between gap-2 rounded-xl px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-xs">
                  {inv.from ? `${inv.from} ` : ""}
                  {inv.boatName ? `邀请你加入「${inv.boatName}」` : "邀请你加入船队"}
                </span>
                <span className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => respond.mutate({ invitationId: inv.id, action: "accept" })}
                  >
                    接受
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => respond.mutate({ invitationId: inv.id, action: "reject" })}
                  >
                    拒绝
                  </Button>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {data && !data.inParty ? (
          <div className="space-y-2">
            <div className="text-muted-foreground text-xs">当前未加入船队</div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) join.mutate(code.trim());
              }}
            >
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="粘贴船队邀请码"
                className="h-8 flex-1 text-xs"
                disabled={busy}
              />
              <Button type="submit" size="sm" className="gap-1.5" disabled={busy || !code.trim()}>
                <IconUserPlus className="size-3.5" />
                加入
              </Button>
            </form>
            <p className="text-muted-foreground text-[11px]">
              邀请码由船长在游戏里生成（船队管理 → 邀请码）；有邀请时也可以直接在上面点「接受」。
            </p>
          </div>
        ) : null}

        {data?.inParty ? (
          <div className="space-y-2.5">
            <div className="bg-muted/50 space-y-1 rounded-xl px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">{data.boatName ?? "船队"}</span>
                {data.role ? <Badge variant="secondary">{ROLE_LABEL[data.role]}</Badge> : null}
                {data.onBoat === false ? <Badge variant="secondary">当前不在船上</Badge> : null}
                {!data.canBeSummoned ? <Badge variant="secondary">不跟随船长换图</Badge> : null}
              </div>
              <div className="text-muted-foreground text-[11px]">
                船在 {data.boatBiomeName ?? data.boatBiomeId ?? "未知地图"}
                {data.capacity ? ` · 满载 ${data.capacity} 人` : ""}
              </div>
            </div>

            {/* 邀请码：船长与船员都能分享 */}
            {data.joinCode ? (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">邀请码</span>
                <code className="bg-muted rounded px-1.5 py-0.5 font-mono">{data.joinCode}</code>
                <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5" onClick={() => void copyCode()}>
                  {copied ? <IconCheck className="size-3" /> : <IconCopy className="size-3" />}
                  {copied ? "已复制" : "复制"}
                </Button>
              </div>
            ) : null}

            {/* 成员列表：船长可以看到管理按钮 */}
            {data.members.length ? (
              <div className="space-y-1">
                <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                  <IconUsers className="size-3.5" />
                  船员 {data.members.length}
                  {data.capacity ? ` / ${data.capacity}` : ""}
                  {isCaptain ? "（你是船长，可以管理成员）" : ""}
                </div>

                {data.members.map((m) => (
                  <div key={m.publicId} className="bg-muted/30 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2.5 py-1.5">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
                      {m.role === "captain" ? <IconAnchor className="size-3 shrink-0" /> : null}
                      <span className="min-w-0 truncate font-medium">{m.nickname}</span>
                      <Badge variant="outline" className="shrink-0">
                        {ROLE_LABEL[m.role]}
                      </Badge>
                      {m.effective ? (
                        <Badge variant="online" className="shrink-0">
                          计入协作
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-[11px]">
                      {(m.biomeName ?? m.biomeId ?? "未知地图")} · {FISHING_LABEL[m.fishing]}
                    </span>

                    {isCaptain && m.role !== "captain" ? (
                      <span className="flex shrink-0 gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[11px]"
                          disabled={busy}
                          onClick={() =>
                            manage.mutate({
                              publicId: m.publicId,
                              action: "role",
                              role: m.role === "helmsman" ? "crew" : "helmsman",
                            })
                          }
                        >
                          {m.role === "helmsman" ? "撤销舵手" : "任命舵手"}
                        </Button>
                        {data.canTransferCaptain ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-[11px]"
                            disabled={busy}
                            onClick={() => setTransferTarget(m)}
                          >
                            转让船长
                          </Button>
                        ) : null}
                        {!data.isCrowdfunded ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive h-6 px-1.5 text-[11px]"
                            disabled={busy}
                            onClick={() => setKickTarget(m)}
                          >
                            <IconUserMinus className="size-3" />
                          </Button>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {data.leaveBlockedReason ? <p className="text-muted-foreground text-[11px]">{data.leaveBlockedReason}</p> : null}

            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={busy || Boolean(data.leaveBlockedReason)}
              onClick={() => setConfirmLeave(true)}
            >
              <IconDoorExit className="size-3.5" />
              离开船队
            </Button>
          </div>
        ) : null}
      </CardContent>

      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>离开船队？</AlertDialogTitle>
            <AlertDialogDescription>
              离开后不再享受这条船的组队经验加成，也不会再被船长换图时带走（仍可照常钓鱼，随时能用邀请码重新加入）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                leave.mutate();
                setConfirmLeave(false);
              }}
            >
              确认离开
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(kickTarget)} onOpenChange={(o) => !o && setKickTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移出「{kickTarget?.nickname}」？</AlertDialogTitle>
            <AlertDialogDescription>
              移出后对方不再享受本船的组队经验加成与协同换图，但仍可继续钓鱼。对方可以再用邀请码加入。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (kickTarget) manage.mutate({ publicId: kickTarget.publicId, action: "remove" });
                setKickTarget(null);
              }}
            >
              确认移出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(transferTarget)} onOpenChange={(o) => !o && setTransferTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>把船长转让给「{transferTarget?.nickname}」？</AlertDialogTitle>
            <AlertDialogDescription>
              转让后对方接管邀请、成员管理、退租与买断权限，你变为船员。此操作不可撤销（可以让对方再转回来）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (transferTarget) manage.mutate({ publicId: transferTarget.publicId, action: "captain" });
                setTransferTarget(null);
              }}
            >
              确认转让
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

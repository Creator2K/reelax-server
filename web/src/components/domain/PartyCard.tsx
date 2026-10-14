// 船队（组队）面板：不打开游戏就能加入 / 离开船队、处理组队邀请
//
// 为什么放在助手侧：船队只影响「组队经验加成」与「跟着船换图」，
// 而这两件事都由助手代管 —— 每次为了接受一条邀请去开游戏、点半天反而多余。
import { useState } from "react";
import {
  IconAlertTriangle,
  IconDoorExit,
  IconLoader2,
  IconMail,
  IconShip,
  IconUserPlus,
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
import { useAccountParty } from "@/lib/queries.ts";
import { useJoinParty, useLeaveParty, useRespondPartyInvitation } from "@/lib/mutations.ts";

export function PartyCard({ accountId }: { accountId: string }) {
  const { data, isPending, error } = useAccountParty(accountId);
  const join = useJoinParty(accountId);
  const leave = useLeaveParty(accountId);
  const respond = useRespondPartyInvitation(accountId);
  const [code, setCode] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);

  const busy = join.isPending || leave.isPending || respond.isPending;

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

        {/* 待处理邀请：有就放在最上面（最需要马上处理） */}
        {data?.invitations.length ? (
          <div className="space-y-1.5">
            <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              <IconMail className="size-3.5" />
              组队邀请 {data.invitations.length} 条
            </div>
            {data.invitations.map((inv) => (
              <div
                key={inv.id}
                className="bg-muted/40 flex items-center justify-between gap-2 rounded-xl px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs">
                  {inv.from ? `${inv.from} ` : ""}
                  {inv.boatName ? `邀请你加入「${inv.boatName}」` : "邀请你加入船队"}
                </span>
                <span className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="default"
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
                {data.canChangeBoatBiome ? <Badge variant="secondary">你可以改航线</Badge> : null}
                {data.onBoat === false ? <Badge variant="secondary">当前不在船上</Badge> : null}
                {!data.canBeSummoned ? <Badge variant="secondary">不跟随船长换图</Badge> : null}
              </div>
              <div className="text-muted-foreground text-[11px]">
                船在 {data.boatBiomeName ?? data.boatBiomeId ?? "未知地图"}
              </div>
            </div>

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
    </Card>
  );
}

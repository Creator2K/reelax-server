// 推送设置页：Server酱 + 微信机器人
//
// 为什么单独一页：日报的推送目标就是这里。没有可用通道时，账号详情里的
// 「收益日报」会被服务端标记为不可用（前端禁用开关并显示原因）。
import { useEffect, useState } from "react";
import {
  IconAlertTriangle,
  IconBroadcast,
  IconBrandWechat,
  IconCheck,
  IconDeviceMobile,
  IconPlus,
  IconQrcode,
  IconRefresh,
  IconSend,
  IconShieldCheck,
  IconTrash,
  IconUserCog,
} from "@tabler/icons-react";
import QRCode from "qrcode-generator";
import { PageContainer, EmptyState, SectionTitle } from "@/components/layout/PageContainer.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
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
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useNotifyAvailability, useNotifyChannels, type NotifyChannel } from "@/lib/queries.ts";
import {
  useCreateNotify,
  useDeleteNotify,
  useNotifyAction,
  useTestNotify,
  useUpdateNotify,
} from "@/lib/mutations.ts";
import { fmtRelative } from "@/lib/utils.ts";

/** 把二维码内容渲染成内联 SVG（登录串只在本机流转，不走第三方图片服务） */
function QrSvg({ text, size = 176 }: { text: string; size?: number }) {
  const svg = useState(() => {
    try {
      const qr = QRCode(0, "M");
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 1 });
    } catch {
      return "";
    }
  })[0];
  if (!svg) return <div className="text-muted-foreground text-xs">二维码渲染失败，请点「重试」</div>;
  return (
    <div
      className="[&>svg]:h-auto [&>svg]:w-full"
      style={{ width: size, maxWidth: "100%" }}
      // 内容是我们自己用 qrcode-generator 生成的 SVG，不含外部输入
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default function NotifyPage() {
  const { data: channels, isPending, error } = useNotifyChannels();
  const { data: availability } = useNotifyAvailability();
  const test = useTestNotify();
  const update = useUpdateNotify();
  const del = useDeleteNotify();
  const action = useNotifyAction();

  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<NotifyChannel | null>(null);

  usePageHeader(
    "推送",
    "收益日报等消息会推送给你配置的通道。Server酱 最简单（填 SendKey 即可），微信机器人支持双向交互。",
    <Button size="sm" onClick={() => setAddOpen(true)} disabled={(channels?.length ?? 0) >= 10}>
      <IconPlus className="size-3.5" />
      添加通道
    </Button>,
  );

  const list = channels ?? [];

  return (
    <PageContainer>
      {error ? (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertDescription>读取推送通道失败：{(error as Error).message}</AlertDescription>
        </Alert>
      ) : null}

      {availability && !availability.hasUsableChannel ? (
        <Alert variant="info" className="mb-4">
          <IconBroadcast />
          <AlertTitle>还没有可用的推送通道</AlertTitle>
          <AlertDescription>
            {availability.hint}
            <br />
            没有可用通道时，「收益日报」功能会被标记为不可用（它只会在日志里写一条，不会推到你手机上）。
          </AlertDescription>
        </Alert>
      ) : null}

      {isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<IconBroadcast />}
          title="还没有配置推送"
          description="推荐先用 Server酱：在 sct.ftqq.com 用微信扫码登录就能拿到 SendKey，填进来即可。想双向交互（在微信里发命令查状态）就配微信机器人。"
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              添加通道
            </Button>
          }
        />
      ) : (
        <>
          <SectionTitle>{`${list.length} 个通道`}</SectionTitle>
          <div className="space-y-3">
            {list.map((c) => (
              <ChannelCard
                key={c.id}
                channel={c}
                testing={test.isPending && test.variables === c.id}
                acting={action.isPending && action.variables?.id === c.id}
                onTest={() => test.mutate(c.id)}
                onToggle={(enabled) => update.mutate({ id: c.id, patch: { enabled } })}
                onDelete={() => setPendingDelete(c)}
                onAction={(a) => action.mutate({ id: c.id, action: a })}
              />
            ))}
          </div>
        </>
      )}

      <AddChannelDialog open={addOpen} onOpenChange={setAddOpen} />

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{pendingDelete?.label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后就不再通过它推送消息。微信通道的本地登录凭证也会一并清理。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) del.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}

const STATUS_TEXT: Record<string, string> = {
  idle: "未就绪",
  starting: "正在登录",
  qrcode: "待扫码",
  scanned: "手机确认中",
  online: "已登录（待绑定）",
  bound: "已连接",
  error: "出错",
};

function ChannelCard({
  channel,
  testing,
  acting,
  onTest,
  onToggle,
  onDelete,
  onAction,
}: {
  channel: NotifyChannel;
  testing: boolean;
  acting: boolean;
  onTest: () => void;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
  onAction: (a: "login" | "reconnect" | "retry" | "unbind") => void;
}) {
  const isWechat = channel.kind === "wechat";
  const usable = channel.enabled && channel.usable;

  return (
    <Card className="gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            {isWechat ? <IconBrandWechat className="size-4" /> : <IconDeviceMobile className="size-4" />}
            <span className="truncate text-sm font-medium">{channel.label}</span>
            <Badge variant="outline" className="font-normal">
              {isWechat ? "微信机器人" : "Server酱"}
            </Badge>
            {usable ? (
              <Badge variant="online" className="gap-1">
                <IconCheck className="size-3" />
                可用
              </Badge>
            ) : (
              <Badge variant={channel.status === "error" ? "error" : "warn"}>
                {channel.enabled ? (STATUS_TEXT[channel.status] ?? channel.status) : "已停用"}
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground flex flex-wrap gap-x-3 text-[11px]">
            {channel.configHint ? <span className="font-mono">{channel.configHint}</span> : null}
            <span>已推送 {channel.sentCount} 条</span>
            {channel.lastSentAt ? <span>上次 {fmtRelative(channel.lastSentAt)}</span> : null}
            {channel.target ? <span>接收人 {channel.target.id}</span> : null}
          </div>
          {channel.statusDetail ? <div className="text-muted-foreground text-xs">{channel.statusDetail}</div> : null}
          {channel.lastError ? (
            <div className="text-[var(--status-error)] text-xs" title={channel.lastError}>
              {channel.lastError}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-[11px]">启用</span>
            <Switch checked={channel.enabled} onCheckedChange={onToggle} aria-label="启用该通道" />
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onDelete} title="删除通道" aria-label="删除通道">
            <IconTrash className="size-4" />
          </Button>
        </div>
      </div>

      {/* 微信扫码区 */}
      {isWechat && (channel.status === "qrcode" || channel.status === "starting") && channel.qrText ? (
        <div className="flex flex-wrap items-center gap-4 px-4">
          <QrSvg text={channel.qrText} />
          <div className="text-muted-foreground max-w-56 space-y-1 text-xs">
            <p className="text-foreground font-medium">用微信扫码登录</p>
            <p>扫码后如果手机要求输入数字配对码，按提示输入即可。</p>
            <p>登录成功后，用微信给这个机器人发一条消息完成绑定。</p>
          </div>
        </div>
      ) : null}

      {/* 等待验证码：把这一步说清楚，否则用户不知道绑定为什么没生效 */}
      {isWechat && channel.awaitingVerify ? (
        <div className="px-4">
          <Alert variant="info">
            <IconShieldCheck />
            <AlertDescription>
              验证码已下发。<b>请把机器人回复的 6 位数字发回给它</b>才算绑定成功
              {channel.verifyExpiresInMs != null
                ? `（还有约 ${Math.max(1, Math.ceil(channel.verifyExpiresInMs / 60000))} 分钟有效）`
                : ""}
              。
              <br />
              这一步用于确认这个微信是你本人的，避免陌生人误绑定。
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {isWechat && channel.status === "online" && !channel.awaitingVerify ? (
        <div className="px-4">
          <Alert variant="info">
            <AlertDescription>
              已登录，但还没绑定接收人：请用微信给这个机器人发一条消息，然后按它回复的提示把验证码发回去。
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <Separator />
      <div className="flex flex-wrap gap-1.5 px-4">
        <Button size="xs" variant="outline" onClick={onTest} disabled={testing || !channel.usable}>
          <IconSend className="size-3.5" />
          {testing ? "发送中…" : "发送测试消息"}
        </Button>
        {isWechat ? (
          <>
            {/* 连接失败过用「重新连接」——复用已保存凭证，不必重新扫码 */}
            <Button size="xs" variant="outline" onClick={() => onAction("reconnect")} disabled={acting}>
              <IconRefresh className="size-3.5" />
              重新连接
            </Button>
            <Button size="xs" variant="outline" onClick={() => onAction("login")} disabled={acting}>
              <IconQrcode className="size-3.5" />
              重新扫码登录
            </Button>
            <Button size="xs" variant="ghost" onClick={() => onAction("unbind")} disabled={acting}>
              <IconUserCog className="size-3.5" />
              更换接收人
            </Button>
          </>
        ) : null}
      </div>
    </Card>
  );
}

function AddChannelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateNotify();
  const [kind, setKind] = useState<"serverchan" | "wechat">("serverchan");
  const [label, setLabel] = useState("");
  const [sendkey, setSendkey] = useState("");

  // 关闭时清空，避免下次打开看到上次的密钥
  useEffect(() => {
    if (!open) {
      setSendkey("");
      setLabel("");
      setKind("serverchan");
    }
  }, [open]);

  const submit = async () => {
    if (kind === "serverchan") {
      await create.mutateAsync({ kind: "serverchan", sendkey: sendkey.trim(), ...(label.trim() ? { label: label.trim() } : {}) });
    } else {
      await create.mutateAsync({ kind: "wechat", ...(label.trim() ? { label: label.trim() } : {}) });
    }
    onOpenChange(false);
  };

  const invalid = kind === "serverchan" && !sendkey.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加推送通道</DialogTitle>
          <DialogDescription>当天日报会在设定时间推给所有已启用且可用的通道。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>通道类型</Label>
            <div className="flex gap-1.5">
              <Button
                type="button"
                size="sm"
                variant={kind === "serverchan" ? "secondary" : "outline"}
                onClick={() => setKind("serverchan")}
              >
                <IconDeviceMobile className="size-3.5" />
                Server酱
              </Button>
              <Button
                type="button"
                size="sm"
                variant={kind === "wechat" ? "secondary" : "outline"}
                onClick={() => setKind("wechat")}
              >
                <IconBrandWechat className="size-3.5" />
                微信机器人
              </Button>
            </div>
          </div>

          {kind === "serverchan" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="nt-key">SendKey</Label>
                <Input
                  id="nt-key"
                  value={sendkey}
                  onChange={(e) => setSendkey(e.target.value)}
                  placeholder="SCT 开头的字符串"
                  className="font-mono text-[13px]"
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">
                  在 <span className="font-mono">sct.ftqq.com</span> 用微信扫码登录即可获得。
                  添加时会先发一条测试消息验证，填错会拒绝保存。
                </p>
              </div>
            </>
          ) : (
            <Alert variant="info">
              <AlertDescription>
                添加后会立即生成二维码，用微信扫码登录。登录成功后请给机器人发一条消息完成绑定。
                <br />
                微信机器人支持双向交互：可以直接在微信里发「日报」「状态」「保底」等命令。
                <br />
                <span className="text-muted-foreground">
                  注意：同一个微信号同时只能有一个机器人实例在轮询，不要和别处的机器人共用同一个微信。
                </span>
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="nt-label">备注名（可选）</Label>
            <Input
              id="nt-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="留空则用类型名"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={invalid || create.isPending}>
            {create.isPending ? "添加中…" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 代理页：增删改 + 一键连通性测试（出口 IP / 延迟 / 失败分类）
import { useState } from "react";
import {
  IconAlertTriangle,
  IconBolt,
  IconCircleCheck,
  IconCloudNetwork,
  IconPlugConnected,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { PageContainer, EmptyState } from "@/components/layout/PageContainer.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
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
import { useProxies, type ProxyRow } from "@/lib/queries.ts";
import { useCreateProxy, useDeleteProxy, useTestProxy, useTestProxyAdhoc, type ProxyTestResult } from "@/lib/mutations.ts";
import { fmtRelative } from "@/lib/utils.ts";

export default function ProxiesPage() {
  const { data: proxies, isPending, error } = useProxies();
  const test = useTestProxy();
  const del = useDeleteProxy();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProxyRow | null>(null);

  usePageHeader(
    "代理",
    "每个账号可以绑定一个独立出口。支持 HTTP / HTTPS / SOCKS5，添加前可以先测试连通性。",
    <Button size="sm" onClick={() => setCreateOpen(true)}>
      <IconPlus className="size-3.5" />
      添加代理
    </Button>,
  );

  const list = proxies ?? [];

  return (
    <PageContainer wide>
      {error ? (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertDescription>读取代理失败：{(error as Error).message}</AlertDescription>
        </Alert>
      ) : null}

      {isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<IconCloudNetwork />}
          title="还没有代理"
          description="多账号挂机时，建议为每个账号配置不同的出口 IP。可以直接粘贴机场面板给的整串地址（如 socks5://user:pass@host:1080）。"
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              添加代理
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => (
            <ProxyCard
              key={p.id}
              proxy={p}
              testing={test.isPending && test.variables === p.id}
              onTest={() => test.mutate(p.id)}
              onDelete={() => setPendingDelete(p)}
            />
          ))}
        </div>
      )}

      <CreateProxyDialog open={createOpen} onOpenChange={setCreateOpen} />

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除代理「{pendingDelete?.label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.boundAccounts
                ? `有 ${pendingDelete.boundAccounts} 个账号正在使用它，删除后这些账号会改为直连。`
                : "没有账号在使用它。"}
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

function ProxyCard({
  proxy,
  testing,
  onTest,
  onDelete,
}: {
  proxy: ProxyRow;
  testing: boolean;
  onTest: () => void;
  onDelete: () => void;
}) {
  const ok = proxy.lastCheckOk === true;
  const failed = proxy.lastCheckOk === false;

  return (
    <Card className="gap-3 py-4">
      <div className="flex items-start justify-between gap-2 px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{proxy.label}</span>
            {ok ? (
              <Badge variant="online" className="gap-1">
                <IconCircleCheck className="size-3" />
                连通
              </Badge>
            ) : failed ? (
              <Badge variant="error">不通</Badge>
            ) : (
              <Badge variant="idle">未测试</Badge>
            )}
          </div>
          <code className="text-muted-foreground mt-0.5 block truncate font-mono text-[11px]">
            {proxy.protocol}://{proxy.username ? `${proxy.username}@` : ""}
            {proxy.host}:{proxy.port}
          </code>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={onDelete} title="删除代理" aria-label="删除代理">
          <IconTrash className="size-4" />
        </Button>
      </div>

      <div className="space-y-1 px-4 text-[11px]">
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">绑定账号</span>
          <span className="mono-num">{proxy.boundAccounts}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">上次检测</span>
          <span>{proxy.lastCheckAt ? fmtRelative(proxy.lastCheckAt) : "—"}</span>
        </div>
        {proxy.lastCheckMs != null ? (
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">延迟</span>
            <span className="mono-num">{proxy.lastCheckMs} ms</span>
          </div>
        ) : null}
        {proxy.lastExitIp ? (
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">出口 IP</span>
            <span className="mono-num">{proxy.lastExitIp}</span>
          </div>
        ) : null}
        {proxy.lastError ? (
          <div className="text-[var(--status-error)] line-clamp-2" title={proxy.lastError}>
            {proxy.lastError}
          </div>
        ) : null}
      </div>

      <div className="px-4">
        <Button size="xs" variant="outline" onClick={onTest} disabled={testing}>
          <IconBolt className="size-3.5" />
          {testing ? "测试中…" : "测试连通性"}
        </Button>
      </div>
    </Card>
  );
}

function CreateProxyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateProxy();
  const testAdhoc = useTestProxyAdhoc();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  const reset = () => {
    setUrl("");
    setLabel("");
    setTestResult(null);
  };

  const body = { url: url.trim(), ...(label.trim() ? { label: label.trim() } : {}) };

  const doTest = async () => {
    setTestResult(null);
    const r = await testAdhoc.mutateAsync(body).catch(() => null);
    if (r) setTestResult(r);
  };

  const doCreate = async () => {
    await create.mutateAsync(body);
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加代理</DialogTitle>
          <DialogDescription>
            支持 <code className="font-mono">host:port</code>、
            <code className="font-mono">http://user:pass@host:port</code>、
            <code className="font-mono">socks5://host:port</code> 三种写法。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="px-url">代理地址</Label>
            <Input
              id="px-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="socks5://user:pass@127.0.0.1:1080"
              className="font-mono text-[13px]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="px-label">备注名（可选）</Label>
            <Input
              id="px-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="留空则用地址作为名称"
            />
          </div>

          {testResult ? (
            <Alert variant={testResult.ok ? "info" : "warn"}>
              {testResult.ok ? <IconCircleCheck /> : <IconAlertTriangle />}
              <AlertDescription>
                {testResult.ok ? (
                  <>
                    连通
                    {testResult.latencyMs != null ? `，延迟 ${testResult.latencyMs} ms` : ""}
                    {testResult.exitIp ? `，出口 IP ${testResult.exitIp}` : ""}
                  </>
                ) : (
                  <>
                    {testResult.error ?? "测试失败"}
                    {testResult.errorCode ? (
                      <span className="text-muted-foreground block font-mono text-[11px]">{testResult.errorCode}</span>
                    ) : null}
                  </>
                )}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="outline"
            onClick={() => void doTest()}
            disabled={!url.trim() || testAdhoc.isPending}
          >
            <IconPlugConnected className="size-3.5" />
            {testAdhoc.isPending ? "测试中…" : "先测试"}
          </Button>
          <Button onClick={() => void doCreate()} disabled={!url.trim() || create.isPending}>
            {create.isPending ? "添加中…" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

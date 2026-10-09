import { Link } from "react-router-dom";
import {
  IconActivity,
  IconCoin,
  IconFish,
  IconLoader2,
  IconPlus,
  IconUsers,
} from "@tabler/icons-react";
import { PageContainer, EmptyState, SectionTitle } from "@/components/layout/PageContainer.tsx";
import { StatCard } from "@/components/domain/StatCard.tsx";
import { StatusBadge } from "@/components/domain/StatusBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { useAccounts, type Account } from "@/lib/queries.ts";
import { fmtNum, fmtRelative } from "@/lib/utils.ts";

function AccountTile({ account }: { account: Account }) {
  const panel = account.statusPanel;
  const gold = account.stats.gold;
  const fish = account.stats.fishCount;

  return (
    <Card className="hover:border-ring/60 gap-3 py-4 transition-colors">
      <div className="flex items-start justify-between gap-2 px-4">
        <div className="min-w-0">
          <Link to={`/accounts/${account.id}`} className="truncate text-sm font-medium hover:underline">
            {account.label}
          </Link>
          <div className="text-muted-foreground mt-0.5 truncate text-[11px]">{account.email || "Cookie 导入"}</div>
        </div>
        <StatusBadge status={account.status} />
      </div>

      <div className="space-y-1 px-4 text-xs">
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">地图</span>
          <span className="truncate">
            {panel?.biomeName ?? "—"}
            {panel?.valueMultiplier ? (
              <span className="text-muted-foreground"> ×{panel.valueMultiplier.toFixed(2)}</span>
            ) : null}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">等级 / 经验</span>
          <span className="mono-num">
            {panel?.level ? `Lv ${fmtNum(panel.level)}` : "—"}
            {panel?.xpTotal ? <span className="text-muted-foreground"> · ×{panel.xpTotal.toFixed(2)}</span> : null}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">本轮结算</span>
          <span className="mono-num">
            {fmtNum(account.stats.castsResolved)} 杆 · {fmtNum(gold)} 金 · {fmtNum(fish)} 条
          </span>
        </div>
        {account.lastError ? (
          <div className="text-[var(--status-error)] truncate" title={account.lastError}>
            {account.lastError}
          </div>
        ) : (
          <div className="text-muted-foreground">
            上次同步 {account.lastSyncAt ? fmtRelative(account.lastSyncAt) : "—"}
          </div>
        )}
      </div>

      <div className="flex gap-1.5 px-4">
        <Button asChild variant="outline" size="xs">
          <Link to={`/accounts/${account.id}`}>详情</Link>
        </Button>
      </div>
    </Card>
  );
}

export default function DashboardPage() {
  const { data: accounts, isPending, error } = useAccounts();

  const list = accounts ?? [];
  const online = list.filter((a) => a.status === "online").length;
  const casts = list.reduce((sum, a) => sum + (a.stats?.castsResolved ?? 0), 0);
  const gold = list.reduce((sum, a) => sum + (a.stats?.gold ?? 0), 0);
  const fish = list.reduce((sum, a) => sum + (a.stats?.fishCount ?? 0), 0);

  usePageHeader("总览", undefined, null);

  return (
    <PageContainer wide>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="在线账号"
          value={`${online} / ${list.length}`}
          sub={`${list.filter((a) => a.status !== "stopped").length} 个引擎运行中`}
          icon={<IconUsers />}
        />
        <StatCard label="累计结算" value={fmtNum(casts)} sub="引擎启动以来（杆）" icon={<IconActivity />} />
        <StatCard label="累计金币" value={fmtNum(gold)} sub="税后净金币" icon={<IconCoin />} />
        <StatCard label="累计渔获" value={fmtNum(fish)} sub="鱼条数" icon={<IconFish />} />
      </div>

      <div className="mt-6">
        <SectionTitle
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/accounts">
                <IconPlus className="size-3.5" />
                添加账号
              </Link>
            </Button>
          }
        >
          账号
        </SectionTitle>

        {isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        ) : error ? (
          <EmptyState
            title="读取账号失败"
            description={(error as Error).message}
            action={
              <Button variant="outline" size="sm" onClick={() => location.reload()}>
                重新加载
              </Button>
            }
          />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<IconLoader2 className="animate-spin" />}
            title="还没有游戏账号"
            description="添加一个游戏账号后，开启「保持在线」即可 24 小时挂机。建议同时绑定代理以隔离出口 IP。"
            action={
              <Button asChild size="sm">
                <Link to="/accounts">去添加账号</Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((a) => (
              <AccountTile key={a.id} account={a} />
            ))}
          </div>
        )}
      </div>
    </PageContainer>
  );
}

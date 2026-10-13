// 「关于」：这个项目是什么、能做什么、改了什么、代码在哪
//
// 功能一览直接来自 `/api/modules`（编译进镜像的功能定义），不在这里手抄一份 ——
// 手抄的清单一定会过期，而这个页面本身就是用来说明"当前这版有什么"的。
// 只列功能名（悬停看一句话说明）：十几项的长说明铺满一屏，反而什么都看不清。
//
// 更新记录也在这里（原来单独占一个侧边栏入口）：默认只展开最近两版，其余按需加载。
import { useQuery } from "@tanstack/react-query";
import {
  IconBrandGithub,
  IconExternalLink,
  IconHistory,
  IconInfoCircle,
  IconSparkles,
} from "@tabler/icons-react";
import { PageContainer } from "@/components/layout/PageContainer.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { ChangelogList } from "@/components/domain/Changelog.tsx";
import { useModuleDefinitions } from "@/lib/queries.ts";
import { api } from "@/lib/api.ts";

const REPO = "https://github.com/Creator2K/reelax-server";

export default function AboutPage() {
  usePageHeader("关于", "这是什么、能做什么、改了什么");
  const modules = useModuleDefinitions();
  const health = useQuery({
    queryKey: ["health", "version"],
    queryFn: () => api.get<{ version?: string }>("/api/health"),
    staleTime: 60_000,
  });

  const version = health.data?.version ?? "—";

  return (
    <PageContainer>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <IconInfoCircle className="size-4" />
              摸鱼大师智能助手
              <Badge variant="secondary">v{version}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed">
            <p>
              《奥术摸鱼大师（Arcane Reelax）》的「多用户挂机平台」：在浏览器之外按游戏协议直连服务端，
              自动维持在线钓鱼，并为每个游戏账号提供独立的出口代理。
            </p>
            <p className="text-muted-foreground">
              功能全部由本项目自己实现（用游戏自己的接口），不依赖、也不接管官方的航线助手：
              挂机时助手不生效也没关系，签到、换饵、赛事报名、保底切图、收益统计都会照常跑。
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <a
                href={REPO}
                target="_blank"
                rel="noreferrer"
                className="border-input hover:bg-accent inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors"
              >
                <IconBrandGithub className="size-4" />
                {REPO.replace("https://", "")}
                <IconExternalLink className="size-3.5 opacity-60" />
              </a>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <IconSparkles className="size-4" />
              内置功能（{modules.data?.length ?? 0} 项）
            </CardTitle>
          </CardHeader>
          <CardContent>
            {modules.isLoading ? (
              <div className="text-muted-foreground text-sm">加载中…</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(modules.data ?? []).map((m) => (
                  <Badge key={m.id} variant="secondary" title={m.description} className="font-normal">
                    {m.name}
                    {m.defaultEnabled ? null : (
                      <span className="text-muted-foreground ml-1 text-[10px]">默认关闭</span>
                    )}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <IconHistory className="size-4" />
              更新记录
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChangelogList />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">技术说明</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-1.5 text-sm">
            <p>· 服务端 Node 24（原生 TypeScript，无构建步骤）+ Express + SQLite；前端 React + Vite。</p>
            <p>· 单容器 + 单数据卷，零原生依赖；账号凭证与服务端凭证都加密落库。</p>
            <p>· 每个账号可配独立代理（HTTP / HTTPS / SOCKS5），界面内可测连通性。</p>
            <p>· 支持在线更新：面板一键更新，或 docker compose pull app &amp;&amp; docker compose up -d。</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">免责声明</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm leading-relaxed">
            仅供个人学习与自动化研究使用。请遵守游戏用户协议、控制操作频率，风险自担。
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}

// 认证页共用外壳：居中卡片 + 品牌
import { IconChartDots } from "@tabler/icons-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-md">
          <IconChartDots className="size-5" />
        </div>
        <div className="leading-tight">
          <div className="text-base font-semibold">摸鱼大师智能助手</div>
          <div className="text-muted-foreground text-xs">挂机控制台</div>
        </div>
      </div>

      <Card className="w-full max-w-sm gap-5">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 max-w-sm text-center text-xs">
        仅供个人学习与自动化研究，请遵守游戏用户协议并自担风险。
      </p>
    </div>
  );
}

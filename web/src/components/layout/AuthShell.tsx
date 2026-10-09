// 认证页共用外壳：居中卡片 + 品牌
//
// 动效（对标 workbuddy-manager）：品牌与卡片错峰弹簧入场。
// 这两屏是用户看到的第一眼，入场动效对观感的影响最大，所以给得比内页明显一点。
import { motion } from "motion/react";
import { IconChartDots } from "@tabler/icons-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";

const SPRING = { type: "spring", stiffness: 220, damping: 24 } as const;

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
    <div className="bg-background relative flex min-h-svh flex-col items-center justify-center overflow-hidden px-4 py-10">
      {/* 极淡的径向光晕，纯装饰；用主题色派生，深浅色都协调 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 0%, color-mix(in oklab, var(--foreground) 6%, transparent), transparent 70%)",
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SPRING, delay: 0.02 }}
        className="relative mb-6 flex items-center gap-2.5"
      >
        <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-md">
          <IconChartDots className="size-5" />
        </div>
        <div className="leading-tight">
          <div className="text-base font-semibold">摸鱼大师智能助手</div>
          <div className="text-muted-foreground text-xs">挂机控制台</div>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ ...SPRING, delay: 0.08 }}
        className="relative w-full max-w-sm"
      >
        <Card className="w-full gap-5">
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.35, duration: 0.4 }}
        className="text-muted-foreground relative mt-6 max-w-sm text-center text-xs"
      >
        仅供个人学习与自动化研究，请遵守游戏用户协议并自担风险。
      </motion.p>
    </div>
  );
}

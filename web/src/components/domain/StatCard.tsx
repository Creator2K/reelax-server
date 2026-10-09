// 统计卡片 —— 沿用 LDC StatCard 范式（对标 workbuddy-manager）
//
// 设计要点（别随意改，这是「抄过来」的部分）：
//  · 用 **bg-muted 底色**区分区块，不加边框
//  · `rounded-[20px]` 比常规卡片更圆，是这套观感的识别点
//  · 数值大而紧（tracking-[-0.03em]）+ tabular-nums，多张卡并排时数字不抖
//  · 语义色调统一在这里定义（好/注意/坏），避免各页面各写一套颜色
//  · 入场用 motion 位移淡入，支持 delay 做错峰
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils.ts";

/** 数值语义色调 */
export type StatTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

const TONE_VALUE: Record<StatTone, string> = {
  neutral: "text-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
  info: "text-blue-600 dark:text-blue-400",
  accent: "text-violet-600 dark:text-violet-400",
};

const TONE_ICON: Record<StatTone, string> = {
  neutral: "text-muted-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
  info: "text-blue-600 dark:text-blue-400",
  accent: "text-violet-600 dark:text-violet-400",
};

export function StatCard({
  label,
  value,
  sub,
  hint,
  icon,
  tone = "neutral",
  hintTone,
  delay = 0,
  title,
  className,
}: {
  label: string;
  value: ReactNode;
  /** @deprecated 用 hint；保留是为了兼容旧调用 */
  sub?: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  hintTone?: StatTone;
  delay?: number;
  /** 悬停提示。放精确值用（卡片里的大数是紧凑显示，会丢精度） */
  title?: string;
  className?: string;
}) {
  const footer = hint ?? sub;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay }}
      title={title}
      className={cn("bg-muted min-h-[88px] rounded-[20px] px-3.5 py-3 sm:min-h-[96px] sm:px-4", className)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-muted-foreground truncate text-[11px] font-medium">{label}</div>
        {icon ? (
          <div
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-full bg-white/70 dark:bg-white/[0.05]",
              TONE_ICON[tone],
            )}
          >
            {icon}
          </div>
        ) : null}
      </div>

      {/*
        数值容器：overflow-hidden + break-all 是必要的 ——
        窄卡一行大约只放得下 4 个字符，万一数值比预期更长（例如 8 位纯数字），
        让它断在卡内，而不是把卡片撑宽或挤到卡外。
      */}
      <div
        className={cn(
          "mono-num mt-3 overflow-hidden text-xl font-semibold tracking-[-0.03em] break-all tabular-nums sm:text-2xl",
          TONE_VALUE[tone],
        )}
      >
        {value}
      </div>

      {footer ? (
        <div className={cn("mt-2 text-[11px]", hintTone ? TONE_VALUE[hintTone] : "text-muted-foreground")}>{footer}</div>
      ) : null}
    </motion.div>
  );
}

/**
 * 进度条 —— 用于经验进度与保底进度。
 * 底色是 muted 的深一级，填充用主色；超过阈值时换成 warn/danger。
 */
export function ProgressBar({
  value,
  max,
  tone = "neutral",
  className,
  showSheen = false,
}: {
  value: number;
  max: number;
  tone?: StatTone;
  className?: string;
  /** 进行中时加一条流动光带（更新进度用） */
  showSheen?: boolean;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const fill: Record<StatTone, string> = {
    neutral: "bg-foreground/80",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    danger: "bg-red-500",
    info: "bg-blue-500",
    accent: "bg-violet-500",
  };
  return (
    <div className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.09]", className)}>
      <div
        className={cn("bar-animated relative h-full rounded-full", fill[tone], showSheen && "sheen overflow-hidden")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

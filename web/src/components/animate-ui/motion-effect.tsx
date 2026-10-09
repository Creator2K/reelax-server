// 入场动效包装（移植自 workbuddy-manager / animate-ui，Vite 版）
//
// 为什么用它而不是直接写 motion.div：
// 把「滑入 + 淡入 + 缩放 + 模糊」组合成声明式开关，页面上大量卡片可以一行接上，
// 不必每处重复写 variants。默认用弹簧（spring），这是 LDC 那套的观感基准。
import * as React from "react";
import { AnimatePresence, motion, useInView, type HTMLMotionProps, type UseInViewOptions, type Transition, type Variant } from "motion/react";

type MotionEffectProps = HTMLMotionProps<"div"> & {
  children: React.ReactNode;
  className?: string;
  transition?: Transition;
  delay?: number;
  /** 进入视口才播放（长列表性能友好） */
  inView?: boolean;
  inViewMargin?: UseInViewOptions["margin"];
  inViewOnce?: boolean;
  blur?: string | boolean;
  slide?: { direction?: "up" | "down" | "left" | "right"; offset?: number } | boolean;
  fade?: { initialOpacity?: number; opacity?: number } | boolean;
  zoom?: { initialScale?: number; scale?: number } | boolean;
};

export function MotionEffect({
  ref,
  children,
  className,
  transition = { type: "spring", stiffness: 200, damping: 20 },
  delay = 0,
  inView = false,
  inViewMargin = "0px",
  inViewOnce = true,
  blur = false,
  slide = false,
  fade = false,
  zoom = false,
  ...props
}: MotionEffectProps) {
  const localRef = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(ref, () => localRef.current as HTMLDivElement);

  const inViewResult = useInView(localRef, { once: inViewOnce, margin: inViewMargin });
  const isInView = !inView || inViewResult;

  const hiddenVariant: Variant = {};
  const visibleVariant: Variant = {};

  if (slide) {
    const offset = typeof slide === "boolean" ? 100 : (slide.offset ?? 100);
    const direction = typeof slide === "boolean" ? "left" : (slide.direction ?? "left");
    const axis = direction === "up" || direction === "down" ? "y" : "x";
    hiddenVariant[axis] = direction === "left" || direction === "up" ? -offset : offset;
    visibleVariant[axis] = 0;
  }
  if (fade) {
    hiddenVariant.opacity = typeof fade === "boolean" ? 0 : (fade.initialOpacity ?? 0);
    visibleVariant.opacity = typeof fade === "boolean" ? 1 : (fade.opacity ?? 1);
  }
  if (zoom) {
    hiddenVariant.scale = typeof zoom === "boolean" ? 0.5 : (zoom.initialScale ?? 0.5);
    visibleVariant.scale = typeof zoom === "boolean" ? 1 : (zoom.scale ?? 1);
  }
  if (blur) {
    hiddenVariant.filter = typeof blur === "boolean" ? "blur(10px)" : `blur(${blur})`;
    visibleVariant.filter = "blur(0px)";
  }

  return (
    <AnimatePresence>
      <motion.div
        ref={localRef}
        data-slot="motion-effect"
        initial="hidden"
        animate={isInView ? "visible" : "hidden"}
        exit="hidden"
        variants={{ hidden: hiddenVariant, visible: visibleVariant }}
        transition={{ ...transition, delay: (transition?.delay ?? 0) + delay }}
        className={className}
        {...props}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/** 常用预设：卡片入场 */
export function FadeInUp({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <MotionEffect
      fade
      slide={{ direction: "up", offset: 12 }}
      delay={delay}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
      className={className}
    >
      {children}
    </MotionEffect>
  );
}

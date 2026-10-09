import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.ts";

export const Tabs = TabsPrimitive.Root;

/**
 * 页签条。
 *
 * 移动端要点：后台有 6 个页签，窄屏一行放不下。
 * 用「整条可横向滚动 + 隐藏滚动条」而不是换行 —— 换行会让内容整体下移、
 * 而且相邻两行的页签容易被误点。
 */
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <div className="scroll-slim -mx-1 overflow-x-auto px-1 pb-0.5">
      <TabsPrimitive.List
        className={cn(
          "bg-muted text-muted-foreground inline-flex h-10 items-center rounded-lg p-1 sm:h-9",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "ring-offset-background focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-xs sm:py-1",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn("ring-offset-background focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none", className)}
      {...props}
    />
  );
}

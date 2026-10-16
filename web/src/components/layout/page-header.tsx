// 页面头部上下文：让页面声明标题/描述/操作区，由 AppLayout 统一渲染在顶栏
//
// 比每个页面各画一个 header 更一致（LDC 也是「一个顶栏 + 内容区」的结构）。
//
// ★ 操作区为什么用 portal（PageHeaderActions）而不是直接把 ReactNode 塞进顶栏：
//   顶栏只在**标题/描述变化**时重建（不然每次渲染都会 setState → 死循环），
//   于是塞进去的节点会停在旧的那一份：select 的选中项、按钮的 disabled 与文案
//   都不会跟着页面状态更新（真实踩到过：交换助手的账号下拉切不动、账号详情的
//   启动/停止按钮一直显示旧状态）。改成 portal 后，节点仍属于页面的渲染树，
//   只是"挂"到顶栏的 DOM 位置上，状态永远是最新的。
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type PageHeaderState = {
  title: string;
  description?: string;
};

type Ctx = {
  header: PageHeaderState;
  setHeader: (h: PageHeaderState) => void;
  /** 顶栏里预留的操作区容器（AppHeader 挂上去的） */
  actionsSlot: HTMLElement | null;
  setActionsSlot: (el: HTMLElement | null) => void;
};

const PageHeaderContext = createContext<Ctx | null>(null);

export function PageHeaderProvider({
  children,
  initial = { title: "" },
}: {
  children: ReactNode;
  initial?: PageHeaderState;
}) {
  const [header, setHeaderState] = useState<PageHeaderState>(initial);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const setHeader = useCallback((h: PageHeaderState) => setHeaderState(h), []);
  const value = useMemo(
    () => ({ header, setHeader, actionsSlot, setActionsSlot }),
    [header, setHeader, actionsSlot],
  );
  return <PageHeaderContext.Provider value={value}>{children}</PageHeaderContext.Provider>;
}

export function usePageHeaderContext(): Ctx {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) throw new Error("usePageHeaderContext 必须在 PageHeaderProvider 内使用");
  return ctx;
}

/** 页面声明自己的标题与描述（操作区用 <PageHeaderActions> 单独渲染） */
export function usePageHeader(title: string, description?: string) {
  const { setHeader } = usePageHeaderContext();
  useEffect(() => {
    setHeader({ title, description });
  }, [title, description, setHeader]);
}

/**
 * 顶栏右侧的操作区。
 *
 * 页面把它渲染在自己的 JSX 里（通常是内容最上面），内容会通过 portal 出现在顶栏，
 * 但状态、闭包都属于页面 —— 控件的选中值 / 禁用态永远跟着页面走。
 */
export function PageHeaderActions({ children }: { children: ReactNode }) {
  const { actionsSlot } = usePageHeaderContext();
  if (!actionsSlot) return null;
  return createPortal(children, actionsSlot);
}

// 页面头部上下文：让页面自己声明标题/描述/操作区，由 AppLayout 统一渲染在顶栏
//
// 比每个页面各画一个 header 更一致（LDC 也是「一个顶栏 + 内容区」的结构）。
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type PageHeaderState = {
  title: string;
  description?: string;
  actions?: ReactNode;
};

type Ctx = {
  header: PageHeaderState;
  setHeader: (h: PageHeaderState) => void;
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
  const setHeader = useCallback((h: PageHeaderState) => setHeaderState(h), []);
  const value = useMemo(() => ({ header, setHeader }), [header, setHeader]);
  return <PageHeaderContext.Provider value={value}>{children}</PageHeaderContext.Provider>;
}

export function usePageHeaderContext(): Ctx {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) throw new Error("usePageHeaderContext 必须在 PageHeaderProvider 内使用");
  return ctx;
}

/**
 * 页面声明自己的头部。actions 是 ReactNode，每次渲染都会变，
 * 所以依赖数组只比较 title/description，actions 通过 ref 每次更新。
 */
export function usePageHeader(title: string, description?: string, actions?: ReactNode) {
  const { setHeader } = usePageHeaderContext();
  useEffect(() => {
    // actions 每次渲染可能都是新对象，但把它放进依赖会导致无限循环，
    // 因此这里只跟随 title/description 变化重建，actions 随同刷新。
    setHeader({ title, description, actions });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, setHeader]);
}

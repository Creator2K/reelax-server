// 主题：亮/暗切换，跟随系统偏好
//
// 与 index.html 里的首帧内联脚本共用 storage key "reelax-theme"。
// 切换方式是给 <html> 加/去 .dark 类（与 LDC 的 next-themes 配置等价）。
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "reelax-theme";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const fromDom = document.documentElement.dataset.theme;
  if (fromDom === "dark" || fromDom === "light") return fromDom;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    /* localStorage 不可用 */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* 忽略 */
    }
  }, [theme]);

  // 用户没手动选过时，跟随系统变化
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      try {
        if (localStorage.getItem(STORAGE_KEY)) return;
      } catch {
        /* 忽略 */
      }
      setThemeState(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggleTheme = useCallback(() => setThemeState((t) => (t === "dark" ? "light" : "dark")), []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 <ThemeProvider> 内使用");
  return ctx;
}

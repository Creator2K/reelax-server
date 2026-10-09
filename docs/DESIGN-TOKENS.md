# 视觉规范

对标 [LINUX DO CDK](https://github.com/linux-do/cdk)（MIT）。风格是
**shadcn/ui (new-york) + Tailwind v4 + 中性 zinc 灰阶**：干净、克制、类 GitHub 的社区产品质感。

样式全部落在 `web/src/styles.css` 与 `web/components.json`。**改任何颜色/圆角前请先读本文**，
这里的表格是验收基准。

---

## 1. 圆角

| token | 值 |
| --- | --- |
| `--radius` | `0.625rem`（10px） |
| `--radius-sm` | `calc(var(--radius) - 4px)` |
| `--radius-md` | `calc(var(--radius) - 2px)` |
| `--radius-lg` | `var(--radius)` |
| `--radius-xl` | `calc(var(--radius) + 4px)` |

## 2. 亮色（`:root`）

| token | 值 |
| --- | --- |
| `--background` | `oklch(1 0 0)` |
| `--foreground` | `oklch(0.141 0.005 285.823)` |
| `--card` / `--popover` | `oklch(1 0 0)` |
| `--card-foreground` / `--popover-foreground` | `oklch(0.141 0.005 285.823)` |
| `--primary` | `oklch(0.21 0.006 285.885)` |
| `--primary-foreground` | `oklch(0.985 0 0)` |
| `--secondary` | `oklch(0.967 0.001 286.375)` |
| `--secondary-foreground` | `oklch(0.21 0.006 285.885)` |
| `--muted` / `--accent` | `oklch(0.967 0.001 286.375)` |
| `--muted-foreground` | `oklch(0.552 0.016 285.938)` |
| `--accent-foreground` | `oklch(0.21 0.006 285.885)` |
| `--destructive` | `oklch(0.577 0.245 27.325)` |
| `--border` / `--input` | `oklch(0.92 0.004 286.32)` |
| `--ring` | `oklch(0.705 0.015 286.067)` |
| `--sidebar` / `--sidebar-accent` | `rgb(249, 250, 251)` （bg-gray-50） |
| `--sidebar-foreground` | `oklch(0.141 0.005 285.823)` |
| `--sidebar-primary` | `oklch(0.21 0.006 285.885)` |
| `--sidebar-primary-foreground` | `oklch(0.985 0 0)` |
| `--sidebar-accent-foreground` | `oklch(0.15 0.01 285.885)` |
| `--sidebar-border` | `transparent`（LDC 特意去掉了侧边栏边框） |
| `--sidebar-ring` | `oklch(0.705 0.015 286.067)` |
| `--chart-1..5` | `oklch(0.646 0.222 41.116)`, `oklch(0.6 0.118 184.704)`, `oklch(0.398 0.07 227.392)`, `oklch(0.828 0.189 84.429)`, `oklch(0.769 0.188 70.08)` |

## 3. 暗色（`.dark`）

| token | 值 |
| --- | --- |
| `--background` | `oklch(0.141 0.005 285.823)` |
| `--foreground` | `oklch(0.985 0 0)` |
| `--card` / `--popover` | `oklch(0.21 0.006 285.885)` |
| `--card-foreground` / `--popover-foreground` | `oklch(0.985 0 0)` |
| `--primary` | `oklch(0.92 0.004 286.32)` |
| `--primary-foreground` | `oklch(0.21 0.006 285.885)` |
| `--secondary` / `--muted` / `--accent` | `oklch(0.274 0.006 286.033)` |
| `--secondary-foreground` / `--accent-foreground` | `oklch(0.985 0 0)` |
| `--muted-foreground` | `oklch(0.705 0.015 286.067)` |
| `--destructive` | `oklch(0.704 0.191 22.216)` |
| `--border` | `oklch(1 0 0 / 10%)` |
| `--input` | `oklch(1 0 0 / 15%)` |
| `--ring` | `oklch(0.552 0.016 285.938)` |
| `--sidebar` / `--sidebar-accent` | `rgb(31, 41, 55)` （bg-gray-800） |
| `--sidebar-foreground` | `oklch(0.985 0 0)` |
| `--sidebar-primary` | `oklch(0.488 0.243 264.376)` |
| `--sidebar-accent-foreground` | `oklch(0.95 0.01 0)` |
| `--sidebar-border` | `transparent` |
| `--chart-1..5` | `oklch(0.488 0.243 264.376)`, `oklch(0.696 0.17 162.48)`, `oklch(0.769 0.188 70.08)`, `oklch(0.627 0.265 303.9)`, `oklch(0.645 0.246 16.439)` |

> 构建时 Tailwind v4 的压缩器会把 `oklch(1 0 0)` 改写成 `oklch(100% 0 0)`、
> 把 `rgb(249,250,251)` 改写成 `#f9fafb`。这是**等价改写**，不是值被改动 ——
> 校验时按等价形式比对即可（见 `test` 里的做法）。

## 4. 字体

```css
--font-sans: var(--font-inter), var(--font-noto-sans-sc), system-ui, -apple-system, "Segoe UI", sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

LDC 用 Inter + Noto Sans SC；本项目的 `--font-sans` 保持同一栈（前置变量未加载时
自动退回 `system-ui`，中文在 Windows/macOS 上都有合适回退，不引外链字体 CDN —— 服务器在国内
可达性差，且避免多一个外部依赖）。

## 5. 全局基础

```css
* { @apply border-border outline-ring/50; }
body { @apply bg-background text-foreground; }
button { cursor: pointer; }
```

- 暗色通过 `<html class="dark">` 切换；`index.html` 里有首帧内联脚本避免闪白/闪黑
- 主题偏好存 `localStorage["reelax-theme"]`（**改 key 要同时改 `index.html` 与 `lib/theme.tsx`**）

## 6. 侧边栏选中态

LDC 用 `data-slot` + `data-active` 属性选择器表达选中态：

| 主题 | 背景 | 文字 |
| --- | --- | --- |
| 亮色 | `rgb(243, 244, 246)` （bg-gray-100） | `var(--sidebar-primary)` |
| 暗色 | `rgb(55, 65, 81)` （bg-gray-700） | `var(--sidebar-primary-foreground)` |

选择器：`[data-slot="sidebar-menu-button"][data-active="true"]`

（实现细节：NavLink 的 `className` 拿不到 `isActive`，所以用 children 渲染函数把
`data-active` 打在 `<a>` 自身。）

## 7. Toast 图标着色（sonner）

| 类型 | 亮色 | 暗色 |
| --- | --- | --- |
| success | `#10b981` | `#34d399` |
| error | `#ef4444` | `#f87171` |
| warning | `#f59e0b` | `#fbbf24` |
| info | `#3b82f6` | `#60a5fa` |
| loading | `#6b7280` | `#9ca3af` |

图标 `margin-inline-end: 8px`。

## 8. 本项目额外加的状态色

LDC 没有「运行状态」的概念，这里补了一组语义色，**只用于小圆点与徽章**，
不做大面积铺色（保持整体中性灰的克制感）。

| 语义 | 亮色 | 暗色 |
| --- | --- | --- |
| online | `oklch(0.62 0.14 152)` | `oklch(0.7 0.15 152)` |
| warn | `oklch(0.72 0.15 75)` | `oklch(0.79 0.16 78)` |
| error | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` |
| idle | `oklch(0.705 0.015 286.067)` | `oklch(0.552 0.016 285.938)` |

用法：`.status-dot[data-status="online"]`，可选 `data-pulse="true"` 做呼吸动画。

---

## 9. 明令禁止

这些是这个风格的核心红线，**验收会查**：

- ❌ 玻璃拟态：大面板上的 `backdrop-blur`
- ❌ 霓虹发光效果
- ❌ 主色渐变（`from-*-500 to-*-500` 之类）
- ❌ 彩色卡片阴影

层次只用 **`border` + `bg-card` / `bg-muted`** 表达。

`web/eslint.config.mjs` 里有一条 `no-restricted-syntax` 规则会在
`components/**` 与 `pages/**` 下拦截 `backdrop-blur` 与渐变主色字面量 —— 这是有意为之的防线。

## 10. 组件基线

依赖版本与 LDC 对齐（见 `web/package.json`）：

- Tailwind v4（`@tailwindcss/vite` 插件）+ `tw-animate-css`
- Radix 系列：dialog / alert-dialog / dropdown-menu / select / switch / tabs / tooltip /
  separator / label / progress / avatar / popover / scroll-area / slot
- `class-variance-authority` + `clsx` + `tailwind-merge`（`cn()`）
- `sonner`（toast）
- `@tabler/icons-react`（主）+ `lucide-react`
- React 19 + Vite（**不上 Next.js**：本服务是长驻进程 + SPA，
  Next 只会引入 SSR/RSC 复杂度而无收益；设计系统照搬，框架不照搬）

# 已知问题与取舍

这份文档记录**已确认存在、但决定暂不修**的问题，都是代码审计或实测出来的真实问题（不是猜测）。
按影响排序，每条都写明「为什么现在不修」，避免下一个人重复排查。

修复历史见 `git log`；严重问题的修复都带了回归测试（见 `server/test/`）。

---

## 一、安全 / 加固（影响有限）

| # | 问题 | 位置 | 说明与原因 |
| --- | --- | --- | --- |
| 1 | 微信登录凭证是明文 | `data/wechat-creds/<通道>/credentials.json` | 上游 SDK 用 `storage: "file"` 落地会话。周边的游戏凭证/代理密码都是 AES-256-GCM 加密的，这一处是卷里的弱环节 —— **不要把 data 卷整体外发**（已在 DEPLOY.md 提示）。 |
| 2 | 数据快照与数据库同卷 | `lib/../db/client.ts` 的 `backupNow` | 每天一份、保留 3 份，但都在同一个卷里，卷损坏会一起丢。异地备份建议见 DEPLOY.md 第 3 节。 |
| 3 | `updater` 以 root 跑 `git` | `updater/Dockerfile`、`docker-compose.yml` | 挂载宿主机仓库后以 root 操作。在 Linux 主机上、仓库不属于 root 时 git ≥2.35 会拒绝（`dubious ownership`）。Windows/Docker Desktop 未触发过，未在真实 Linux 主机上验证过，所以没改。 |
| 4 | 账号 `baseUrl` 没有白名单 | `services/proxy-input.ts`、`api/routes/accounts.ts` | 已登录用户可以把它指向内网地址，借此探测端口（路径固定为游戏协议）。不构成提权链条：updater 唯一的状态变更接口是 `POST /update`，客户端不会发这个请求。 |
| 5 | 微信推送验证码是「持有即可用」 | `services/notify-service.ts` | 现在的语义是：知道验证码的人就能完成绑定。验证码只在已登录的网页端显示，所以只有机主（或能登进后台的人）拿得到。要更强就得上「网页端 + 微信端双向确认」，成本不划算。 |
| 6 | 没有 CSP / X-Frame-Options | `api/server.ts` | 目前只设了 `X-Content-Type-Options` 与 `Referrer-Policy`。没有 XSS 注入点，点击劫持风险低；加 CSP 需要先梳理前端内联样式/脚本，单独一次改动更合适。 |
| 7 | WebSocket 连接不会因会话失效被踢 | `api/ws-gateway.ts` | 只在升级时鉴权，之后不再校验；登出/改密不会断开已连接。推送内容仍严格按 `userId` 过滤，仅影响「攻击者已经握有会话」的场景。 |
| 8 | 5xx 错误文本只在 `NODE_ENV=production` 时隐藏 | `api/server.ts` | 镜像里固定 production，裸机开发时不要把 8580 暴露出去即可。 |

## 二、正确性（低危，边界场景）

| # | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| 1 | `TtlCache` 把 `null` 当「未加载」 | `lib/timers.ts` | 没选鱼饵时 `bait` 返回 `null`，缓存判定为无效 → 每个 tick 多一次 `GET /api/baits`（约 6 秒一次）。要修得给它加一个独立的 `loaded` 标志。 |
| 2 | 只改代理密码不生效 | `game/proxy.ts` | 指纹里不含密码，改密码后判定「没变化」，不会重建连接池。修法是让指纹带上密码哈希。 |
| 3 | 单请求的超时覆盖没有传下去 | `game/client.ts` | `request(path, {timeoutMs})` 未转发给底层，实际仍用默认超时；失败文案会报出被忽略的覆盖值，容易误导排查。 |
| 4 | `start` 对 `expired`/`error` 是静默 no-op | `game/runner-registry.ts` | 接口返回 200 且审计记为「已启动」，实际什么都没做（需要先「停止」再「启动」）。更好的行为是返回 409 并说明原因。 |
| 5 | 页面头部的按钮状态会冻结 | `web/src/components/layout/page-header.tsx` | `usePageHeader` 的依赖数组不含 `actions`，所以账号详情页的「启动/停止」按钮不随状态变化（点完不会变成「停止」）。需要改成 ref + 每次渲染更新。 |
| 6 | 统计按天分桶用**容器时区** | `db/repositories/stats.ts`、`modules/shared/format.ts` | 容器时区由 `TZ` 决定（默认 `Asia/Shanghai`）。若之后改 `TZ`，历史数据的「天」边界不会跟着变。 |
| 7 | `account_modules.state_json` 只在已有配置行时写入 | `db/repositories/account-modules.ts` | 不能为存状态而插入新行（新行 `enabled=0` 会把默认启用的模块关掉）。因此「默认启用且用户从没配置过」的模块不保留状态 —— 目前只有 `keep-online` 属于这类，而它没有需要持久化的状态。 |
| 8 | 管理员概览的「可用邀请码」用列表数据 | `web/src/components/domain/DashboardTab.tsx` | 邀请码接口上限 200 条，超过后这个数字会偏小（用户数、管理员数已经改成后端 COUNT）。 |

## 三、性能 / 体验（可优化）

| # | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| 1 | 日志历史受「每用户 2 万条」限制 | `db/repositories/logs.ts` | 已把「本轮没做什么」的说明降到 debug（不落库），实测从 ~53 行/分钟降到 ~1 行/分钟。若把 `LOG_LEVEL` 改成 `debug`，它们会回到内存与实时页面，但仍不落库。 |
| 2 | WS 每 2 秒推一次全量快照 | `api/ws-gateway.ts` | 每个连接每 2 秒一次 `listForUser` + `JSON.stringify`，钓鱼同步时还会额外强制一次。连接数多时值得加脏标记/去抖。 |
| 3 | 前端首屏 518 KB | `web/src/App.tsx` | 已按路由懒加载（原先 895 KB 单包）。还可以再拆 vendor（react/router/motion）改善缓存命中。 |
| 4 | 健康检查不碰数据库 | `api/server.ts` | 只返回静态信息，数据库锁死或引擎停摆时仍然返回 200。加一句 `SELECT 1` 会更真实。 |

## 四、有意保留的 API 面（不是缺陷）

这些没有调用方，但删除会让对应的抽象/事件彻底失去出口，因此保留：

- `security/vault.ts` 的 `rotatePayloads` 与多版本 Keyring —— 代码路径已具备，但**没有 CLI**，
  所以 `MASTER_KEY` 目前**不可轮换**（文档里已明确警告，误换会导致所有凭证无法解密）。
- `security/crypto.ts` 的 `safeEqual`、`game/errors.ts` 的 `isAuthIssue`、
  `AccountRuntime.reportError`、`EVENTS.MODULE_ERROR` —— 属于错误分类与事件面的公共 API。

## 五、部署时需要注意

- `TRUST_PROXY` 默认 `0`。放在 Nginx/Caddy 后面才设 1，并且必须让反代**覆盖**
  `X-Forwarded-For`（用 `$proxy_add_x_forwarded_for` 追加的话，客户端伪造的前缀仍在最左边）。
- `TZ` 默认 `Asia/Shanghai`：日报的「每天几点」、统计按天分桶都跟着它。
- 「在线更新」面板的成功判定是「updater 报成功」或「探活看到 uptime 很小的新进程」，
  不再只看健康检查返回 200（构建期间旧容器一直是健康的）。
- `APP_COMMIT` 必须是构建参数：手工 `docker compose up -d --build` 不传它的话，
  「当前版本」会读不到，更新检查会一直显示「已是最新」。
- 容器内存上限默认 1G（`MAX_RUNNING_ACCOUNTS=50` 按每个账号几 MB 估算）。

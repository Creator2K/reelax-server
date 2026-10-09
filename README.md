# 摸鱼大师智能助手

《奥术摸鱼大师（Arcane Reelax）》的**多用户挂机平台**：在浏览器之外按游戏协议直连服务端，
自动维持**在线钓鱼**，并为每个游戏账号提供独立的出口代理。

- **多用户**：邀请码注册，**注册即可用**（无需审批）；管理员只做后台管理（用户 / 邀请码 / 系统）
- **内置功能**（12 项，非插件）：保持在线 · 每日签到 · 自动加点 · 自动专精献祭 · 自动切图 ·
  **保底切图** · 自动换饵 · 自动报名赛事 · 渊潮围猎参战 · 自动卖装备 · 自动 Buff · 收益日报
- **每账号独立代理**：HTTP / HTTPS / SOCKS5，UI 内一键测连通性（出口 IP + 延迟 + 失败分类）
- **消息推送**：Server酱 与微信机器人（扫码登录、可双向发命令），日报未配推送则不可启用
- **在线更新**：容器内点「立即更新」即可拉代码 + 重建 + 重启（可选 updater 服务）
- **Docker 一键部署**：单容器 + 单数据卷，零原生依赖（不需要编译工具链）

> 仅供个人学习与自动化研究。请遵守游戏用户协议、控制操作频率，风险自担。

---

## 一、快速开始（Docker，推荐）

```bash
git clone https://github.com/Creator2K/reelax-server.git
cd reelax-server

# 1) 生成凭证加密主密钥（★ 必须长期保存）
cp .env.example .env
echo "MASTER_KEY=$(openssl rand -hex 32)" >> .env   # Windows: 见下方说明

# 2) 起服务（想用界面里的「一键更新」就带上 --profile update）
docker compose --profile update up -d --build

# 3) 看日志确认启动成功
docker compose logs -f app
```

打开 `http://<服务器IP>:8580`：

1. **管理员账号已自动创建**：用户名 `admin`，口令是**部署时随机生成**的。
   它出现在两处（找一处即可）：
   - 容器启动日志：`docker compose logs app | grep 初始口令`
   - 数据目录里的 `data/INITIAL_ADMIN.txt`（权限 0600）
2. 用 `admin` + 那个口令登录 → 直接进**后台管理**（管理员看不到挂机面板，这是刻意的）
   - 后台是「概览 / 用户 / 邀请码 / 设置 / 系统 / 更新记录」六个页签
   - 先在「设置」里按需调整：是否允许注册、注册是否要邀请码、每人可挂几个账号…
     **改完立即生效，不用重启**
3. 在「邀请码」生成邀请码发给要用的人
4. 对方注册（**只要用户名 + 口令**，不需要邮箱），注册完直接可用，没有审批环节
5. 建议先去「推送」配一个通道（Server酱 最省事），这样日报才有地方发
6. 回「账号」页添加游戏账号 → 绑定代理 → 确认「保持在线」已启用
7. 登录后请**立刻在「设置」里改掉管理员口令**，然后删掉 `INITIAL_ADMIN.txt`

> 忘了管理员口令怎么办？在 `.env` 里设 `ADMIN_PASSWORD=新口令` 然后重启，
> 启动时会把 `admin` 的口令重置成它。也可以让另一个管理员在
> 「后台管理 → 用户 → 改口令」里重置。

> 不想用 `admin` 这个登录名？改 `ADMIN_USERNAME`。
> 想完全关掉自动创建？把它设为空 —— 此时「第一个注册的用户」会成为管理员（适合本地自用）。

### 账号标识（用户名）

**所有人都用「用户名」登录。** 注册只需要用户名 + 口令：

- 3~32 个字符，可用中英文、数字、`_` `-` `.` `@`，不能有空格
- 想用邮箱当用户名也行（`someone@example.com` 也是合法用户名）
- 老版本用邮箱注册的账号**不受影响** —— 登录时把邮箱当用户名填进去即可

### 管理员与挂机账号是分开的

| 角色 | 能看到 | 说明 |
| --- | --- | --- |
| **管理员** | 后台管理（概览 / 用户 / 邀请码 / 设置 / 系统 / 更新记录）、设置 | 纯管理角色，**不挂游戏** |
| **普通用户** | 总览 / 账号 / 代理 / 推送 / 运行日志 / 更新记录 / 设置 | 挂机控制台 |

两者不共用页面：管理员登录后落在 `/admin`，普通用户落在 `/dashboard`。

### 在线可改的设置

「后台管理 → 设置」里的项**存数据库、改完立即生效**（不用重启、不断挂机）：

| 设置 | 作用 |
| --- | --- |
| 允许自助注册 | 关掉后只有管理员能建号，注册页会提示已关闭 |
| 注册需要邀请码 | 关掉后任何人都能直接注册（公开站点建议保持打开） |
| 每个用户可挂账号数 | 单用户能添加几个游戏账号 |
| 全局同时运行上限 | 所有用户加起来最多同时挂机多少个账号 |
| 日志保留天数 | 超过该天数的运行日志自动清理 |
| 登录态有效期 | 多久不操作需要重新登录 |

环境变量只提供**初始值**：界面上会标出哪些项被改过，并能一键恢复初始值。

Windows PowerShell 生成主密钥：

```powershell
node -e "console.log('MASTER_KEY=' + require('crypto').randomBytes(32).toString('hex'))" | Add-Content .env
```

---

## 二、在线更新

有两种做法，任选：

**A. 界面一键更新（推荐）**

`.env` 里补两行（私有仓库必须给 token，public 仓库可省）：

```env
GITHUB_TOKEN=ghp_xxx                 # 可读私有仓库的 commit 信息 + 供 updater 拉代码
REELAX_UPDATER_URL=http://updater:9000
```

然后带着 updater 起服务：

```bash
docker compose --profile update up -d --build
```

之后在「管理 → 系统 → 在线更新」里点「检查更新」→「立即更新」。更新过程中会显示
**步骤清单 + 进度条 + 已等待秒数**，构建期间的输出也能展开看；服务重启回来后页面会
提示「**请刷新页面**」并给出刷新按钮（刷新是为了加载新版前端资源）。

它会：拉取最新代码 → 重建镜像（并把提交号烧进镜像）→ 重启 app 容器。
**更新前会自动备份数据库**，账号会自动恢复挂机。

**B. 宿主机脚本**

```powershell
.\scripts\update.ps1            # Windows
```
```bash
./scripts/update.sh             # Linux / macOS
```

> Docker 部署下应用代码在镜像里，**容器无法替换自己** —— 所以「一键更新」由
> updater 这个旁路容器执行（它挂了 docker.sock）。这是刻意设计：
> 只有它需要 docker.sock，app 本身权限收得很紧。

---

## 三、消息推送

「推送」页支持两种通道，日报会同时推给所有**已启用且可用**的通道：

| 通道 | 怎么配 | 能力 |
| --- | --- | --- |
| **Server酱** | 在 [sct.ftqq.com](https://sct.ftqq.com) 扫码拿到 SendKey，填进来（会先发一条测试消息验证） | 单向推送 |
| **微信机器人** | 点添加后扫码登录，再用微信给机器人发一条消息完成绑定 | 双向：可直接在微信里发命令 |

微信里可用的命令：`日报` `状态` `经验` `资源` `地图` `保底` `比赛` `围猎` `鱼获` `日志` `帮助`

> ⚠️ 收益日报依赖推送通道：**没有任何可用通道时，日报会被标记为不可用**
> （服务端也会拒绝启用，不只是前端拦）。它只会写一条日志，不会到你手机上，
> 那样很容易误以为坏了。
>
> ⚠️ 同一个微信号同时只能有一个机器人在轮询，不要和别处的机器人共用同一个微信。

---

## 四、本地开发

要求 **Node.js ≥ 24**（服务端用 Node 内置的 `node:sqlite` 与原生 TS 类型剥离，
所以不需要编译步骤，也不需要安装 SQLite）。

```bash
npm install
cp .env.example .env        # 填上 MASTER_KEY
npm run dev                 # 后端 8580 + 前端 Vite 5173
```

- 前端 `http://localhost:5173`（已配好到 8580 的 `/api` 与 `/ws` 代理）
- 后端 `http://localhost:8580`

常用命令：

```bash
npm run typecheck    # 两个工作区一起类型检查
npm test             # 服务端单测 + 集成测试（含越权矩阵、迁移守卫）
npm run lint
npm run build        # 构建前端产物到 web/dist（由后端直接托管）
```

本地跑（非 Docker）时如需在界面里更新，把 `ALLOW_LOCAL_UPDATE=1`，
它会自己 `git pull` + 装依赖 + 重建前端，然后提示你重启进程。

---

## 五、配置项

全部通过环境变量配置（`.env` 或 compose 的 `environment`）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MASTER_KEY` | **必填** | 凭证加密主密钥，64 位十六进制。**丢失后所有游戏凭证与推送密钥无法解密** |
| `PORT` | `8580` | 监听端口。Docker 内固定 8580，对外用 compose 的 `ports` 映射 |
| `HOST` | `127.0.0.1` | 监听地址。Docker 内为 `0.0.0.0`；本地裸跑建议保持 127.0.0.1 |
| `DATA_DIR` | `./data` | 数据库、日志与备份目录 |
| `REELAX_BASE_URL` | `https://reelax.cn` | 游戏地址（测试服 `https://test.reelax.cn`） |
| `REELAX_GLOBAL_PROXY` | 空 | 未绑定代理的账号使用的兜底出口 |
| `PROXY_ECHO_URL` | `https://api.ipify.org?format=json` | 代理测试时探测出口 IP 的地址 |
| `TRUST_PROXY` | 非生产 `0` / 生产 `1` | 反代后设为 1，用于限流取真实 IP |
| `COOKIE_SECURE` | 空（自动） | `1` 强制 Secure、`0` 强制不加、**留空=按请求协议自动判断（推荐）** |
| `ALLOW_REGISTRATION` | `1` | 关闭后只能由管理员建号 |
| `ADMIN_USERNAME` | `admin` | 启动时自动确保存在的管理员登录名。留空 = 不自动创建（改为首个注册者成管理员） |
| `ADMIN_PASSWORD` | 空 | 管理员口令。留空 = 首次创建时随机生成并打印；填了则每次启动重置成它 |
| `MAX_ACCOUNTS_PER_USER` | `5` | 单用户游戏账号上限 |
| `MAX_RUNNING_ACCOUNTS` | `50` | 全局同时运行账号上限 |
| `REELAX_REPO` | `Creator2K/reelax-server` | 检查更新时查询的仓库 |
| `GITHUB_TOKEN` | 空 | 私有仓库读 commit 信息 / updater 拉代码需要 |
| `REELAX_UPDATER_URL` | 空 | 旁路更新器地址（如 `http://updater:9000`） |
| `ALLOW_LOCAL_UPDATE` | `0` | 是否允许本进程直接 git pull（Docker 下保持 0） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_RETENTION_DAYS` | `14` | 数据库日志保留天数 |
| `SESSION_TTL_DAYS` | `30` | 登录态有效期（滑动续期） |

### 关于 `COOKIE_SECURE`（踩过的坑）

早期实现是「生产模式就强制给 cookie 加 `Secure`」。这在**只做 80 端口反代**或
**直接用局域网 IP 访问**的部署里会导致：登录接口返回 200，但下一个请求又是未登录
（浏览器不会在 `http://` 下回传 `Secure` cookie），而且本地开发完全正常，极难排查。

现在默认**按每次请求的实际协议自动判断**，并在 `TRUST_PROXY=1` 时识别
`X-Forwarded-Proto`。除非你明确知道自己在做什么，否则**不要设置这个变量**。

---

## 六、反向代理与 HTTPS

生产部署建议加一层 HTTPS。Caddy 最省事（自动申请证书）：

```caddyfile
reelax.example.com {
    reverse_proxy 127.0.0.1:8580
}
```

Nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name reelax.example.com;

    ssl_certificate     /etc/letsencrypt/live/reelax.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/reelax.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8580;
        proxy_http_version 1.1;

        # WebSocket（实时状态推送）必须转发 upgrade
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 实时推送是长连接，超时要放宽
        proxy_read_timeout 3600s;
    }
}

server {
    listen 80;
    server_name reelax.example.com;
    return 301 https://$host$request_uri;
}
```

配套设置（`.env`）：

```env
TRUST_PROXY=1
```

**安全清单**：

- 务必设置 `MASTER_KEY`（不设置会直接拒绝启动，这是有意的）
- 不要把 8580 直接暴露公网，走反代 + HTTPS
- `ALLOW_REGISTRATION` 按需关闭，用邀请码控制入口
- `data/` 含加密后的游戏凭证与推送密钥，注意备份策略与磁盘权限

### 项目结构

```
reelax-server/
├── server/src/
│   ├── index.ts               # 装配 + 优雅关闭
│   ├── env.ts                 # 环境变量校验（启动即校验，配置错了直接拒启）
│   ├── db/                    # node:sqlite 客户端 + 迁移 + 10 个仓储
│   ├── security/              # AES-256-GCM 加密、凭证保管箱、scrypt 口令哈希
│   ├── auth/                  # 注册/登录/会话/RBAC/限流/cookie 策略
│   ├── game/                  # 签名客户端、代理层、账号运行时、运行时注册表
│   ├── modules/               # 12 个内置功能（含保底切图、经验八分区面板）
│   ├── services/              # 账号/代理/推送/更新 业务服务
│   └── api/                   # Express 路由 + WebSocket 网关
├── web/src/                   # React 控制台（Vite + Tailwind v4 + shadcn/ui）
├── updater/                   # 旁路更新器（可选，挂 docker.sock）
├── scripts/                   # 宿主机一键更新脚本
├── docs/ARCHITECTURE.md       # 架构 + 怎么加新功能
├── docs/DEPLOY.md             # 运维细则 + 故障排查
├── docs/DESIGN-TOKENS.md      # 视觉规范（改样式前先看）
└── docs/PROTOCOL.md           # 游戏协议备忘（排查「游戏更新后失效」）
```

---

## 七、常见问题

**启动失败，提示 MASTER_KEY 未设置？**
这是有意设计：没有主密钥就无法安全存取凭证。执行 `openssl rand -hex 32` 填进 `.env`。

**登录成功但立刻又变回未登录？**
你很可能把 `COOKIE_SECURE` 设成了 `1`，但访问的不是 HTTPS。清空该变量即可。

**账号状态是「凭证失效」？**
Cookie 过期且没有可用的账号密码。到账号详情里重新填写密码或 Cookie。

**提示「凭证无法解密」？**
当前 `MASTER_KEY` 与写入数据时用的不是同一把。换回正确的密钥，或重新填写凭证。

**收益日报的开关是灰的？**
日报依赖推送通道。先去「推送」配 Server酱 或微信机器人 —— 没有通道时它只会写日志，
不会到你手机上。

**点了「立即更新」但报容器名冲突？**
`.env` 里把 `REELAX_PROJECT_DIR` 指到仓库绝对路径，并确保 compose 项目名一致
（`docker-compose.yml` 顶部已用 `name: reelax-server` 固定，updater 也用了同名）。

**游戏更新后功能失效？**
对照 `docs/PROTOCOL.md` 检查端点或签名是否变化，通常只需要改 `server/src/game/client.ts`。


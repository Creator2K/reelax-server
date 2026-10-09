# Reelax 服务器版

《奥术摸鱼大师（Arcane Reelax）》的**多用户挂机平台**：在浏览器之外按游戏协议直连服务端，
自动维持**在线钓鱼**，并为每个游戏账号提供独立的出口代理。

- **多用户**：邀请码注册 + 管理员审批，每个用户只能看到、操作自己的账号
- **内置功能**（11 项，非插件）：保持在线 · 每日签到 · 自动加点 · 自动专精献祭 · 自动切图 ·
  自动换饵 · 自动报名赛事 · 渊潮围猎参战 · 自动卖装备 · 自动 Buff · 收益日报
- **每账号独立代理**：HTTP / HTTPS / SOCKS5，UI 内一键测连通性（出口 IP + 延迟 + 失败分类）
- **Docker 一键部署**：单容器 + 单数据卷，零原生依赖（不需要编译工具链）

> 仅供个人学习与自动化研究。请遵守游戏用户协议、控制操作频率，风险自担。

---

## 一、快速开始（Docker，推荐）

```bash
git clone <你的仓库地址> && cd reelax-server

# 1) 生成凭证加密主密钥（★ 必须长期保存）
cp .env.example .env
echo "MASTER_KEY=$(openssl rand -hex 32)" >> .env   # Windows: 见下方说明

# 2) 起服务
docker compose up -d --build

# 3) 看日志确认启动成功
docker compose logs -f app
```

打开 `http://<服务器IP>:8580`：

1. **第一个注册的账号自动成为管理员**（页面会明确提示）
2. 在「管理 → 邀请码」生成邀请码发给要用的人
3. 对方注册后出现在「管理 → 用户」，点「批准」
4. 各自在「账号」页添加游戏账号 → 建议先建一个「代理」并测试连通性 → 绑定给账号
5. 打开账号详情，确认「保持在线」已启用

Windows PowerShell 生成密钥：

```powershell
node -e "console.log('MASTER_KEY=' + require('crypto').randomBytes(32).toString('hex'))" | Add-Content .env
```

---

## 二、本地开发

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
npm test             # 服务端单测 + 集成测试（含越权矩阵）
npm run build        # 构建前端产物到 web/dist（由后端直接托管）
npm start            # 只起后端（需先 build，或访问会提示未构建）
```

---

## 三、配置项

全部通过环境变量配置（`.env` 或 compose 的 `environment`）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MASTER_KEY` | **必填** | 凭证加密主密钥，64 位十六进制。**丢失后所有游戏凭证无法解密** |
| `PORT` | `8580` | 监听端口。Docker 内固定 8580，对外用 compose 的 `ports` 映射 |
| `HOST` | `127.0.0.1` | 监听地址。Docker 内为 `0.0.0.0`；本地裸跑建议保持 127.0.0.1 |
| `DATA_DIR` | `./data` | 数据库与备份目录 |
| `REELAX_BASE_URL` | `https://reelax.cn` | 游戏地址（测试服 `https://test.reelax.cn`） |
| `REELAX_GLOBAL_PROXY` | 空 | 未绑定代理的账号使用的兜底出口 |
| `PROXY_ECHO_URL` | `https://api.ipify.org?format=json` | 代理测试时探测出口 IP 的地址 |
| `TRUST_PROXY` | 非生产 `0` / 生产 `1` | 反代后设为 1，用于限流取真实 IP |
| `COOKIE_SECURE` | 空（自动） | `1` 强制 Secure、`0` 强制不加、**留空=按请求协议自动判断（推荐）** |
| `ALLOW_REGISTRATION` | `1` | 关闭后只能由管理员建号 |
| `MAX_ACCOUNTS_PER_USER` | `5` | 单用户游戏账号上限 |
| `MAX_RUNNING_ACCOUNTS` | `50` | 全局同时运行的账号上限 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_RETENTION_DAYS` | `14` | 数据库日志保留天数 |
| `SESSION_TTL_DAYS` | `30` | 登录态有效期（滑动续期） |

### 关于 `COOKIE_SECURE`（踩过的坑）

早期实现是「生产模式就强制给 cookie 加 `Secure`」。这在**只做 80 端口反代**或
**直接用局域网 IP 访问**的部署里会导致：登录接口返回 200，但下一个请求又是未登录
（浏览器不会在 `http://` 下回传 `Secure` cookie），而且本地开发完全正常，极难排查。

现在默认**按每次请求的实际协议自动判断**，并在 `TRUST_PROXY=1` 时识别
`X-Forwarded-Proto`，所以 HTTPS 与 HTTP 都能正常工作。除非你明确知道自己在做什么，
否则**不要设置这个变量**。

---

## 四、反向代理与 HTTPS

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

        # 长连接不要被超时切断（实时推送是长连）
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
# 或明确指定 COOKIE_SECURE=1（既然整站 HTTPS，这样更严格）
```

**安全清单**：

- 务必设置 `MASTER_KEY`（不设置会直接拒绝启动，这是有意的）
- 不要把 8580 直接暴露公网，走反代 + HTTPS
- `ALLOW_REGISTRATION` 按需关闭，用邀请码 + 审批控制入口
- `data/` 目录含加密后的游戏凭证，纳入备份并注意磁盘权限

---

## 五、备份与恢复

需要备份的只有**一个目录**：`DATA_DIR`（默认 `./data`，Docker 里是 `reelax-data` 卷）。
里面有 `reelax.db`（含用户、账号、加密凭证、日志、统计）与自动生成的 `reelax.db.bak-*`。

**迁移前的迁移逻辑**：服务每次启动会对 `reelax.db` 做一次 `VACUUM INTO` 快照，
保留最近 3 份（`reelax.db.bak-<时间戳>`），所以升级/回滚都有一层保底。

```bash
# ---- 备份（Docker）----
docker compose exec app node -e "
  const {DatabaseSync}=require('node:sqlite');
  const d=new DatabaseSync('/app/data/reelax.db');
  d.prepare('VACUUM INTO ?').run('/app/data/manual-backup.db');
"
docker compose cp app:/app/data/manual-backup.db ./reelax-backup.db

# ---- 恢复 ----
docker compose down
docker run --rm -v reelax-server_reelax-data:/data -v "$PWD":/backup alpine \
  cp /backup/reelax-backup.db /data/reelax.db
docker compose up -d
```

> 恢复后必须使用**同一个 `MASTER_KEY`**，否则游戏凭证无法解密（界面会明确提示
> 「凭证无法解密」，并让你重新填写密码或 Cookie）。

---

## 六、项目结构

```
reelax-server/
├── server/src/
│   ├── index.ts               # 装配 + 优雅关闭
│   ├── env.ts                 # 环境变量校验（启动即校验，配置错了直接拒启）
│   ├── db/                    # node:sqlite 客户端 + 表结构 + 9 个仓储
│   ├── security/              # AES-256-GCM 加密、凭证保管箱、scrypt 口令哈希
│   ├── auth/                  # 注册/登录/会话/RBAC/限流/cookie 策略
│   ├── game/                  # 签名客户端、代理层、账号运行时、运行时注册表
│   ├── modules/               # 11 个内置功能（含 keep-online 的经验八分区面板）
│   ├── services/              # 账号/代理 业务服务（视图拼装与归属校验）
│   └── api/                   # Express 路由 + WebSocket 网关
├── web/src/                   # React 控制台（Vite + Tailwind v4 + shadcn/ui）
├── docs/PROTOCOL.md           # 游戏协议备忘（排查「游戏更新后失效」用）
├── docs/DEPLOY.md             # 部署细则、运维、故障排查
└── docs/DESIGN-TOKENS.md      # 视觉规范（改样式前先看）
```

---

## 七、常见问题

**启动失败，提示 MASTER_KEY 未设置？**
这是有意设计：没有主密钥就无法安全地存取凭证。执行 `openssl rand -hex 32` 填进 `.env`。

**登录成功但立刻又变回未登录？**
你很可能把 `COOKIE_SECURE` 设成了 `1`，但访问的不是 HTTPS。
清空该变量（默认按协议自动判断）即可。

**账号状态是「凭证失效」？**
说明 Cookie 过期且没有可用的账号密码（Cookie 导入方式无法自动重登）。
到账号详情里重新填写密码或 Cookie。

**提示「凭证无法解密」？**
当前 `MASTER_KEY` 与写入数据时用的不是同一把。换回正确的密钥，或重新填写凭证。

**状态一直「重连中」？**
看「运行日志」页：网络错误 → 检查到 `reelax.cn` 的连通性；绑了代理的话先在「代理」页
点一下「测试连通性」，失败分类会告诉你到底是代理不通还是认证失败。

**游戏更新后功能失效？**
对照 `docs/PROTOCOL.md` 检查端点或签名是否变化，通常只需要改 `server/src/game/client.ts`。

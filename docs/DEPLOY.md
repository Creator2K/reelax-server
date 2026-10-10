# 部署与运维

本文覆盖：架构与数据流、容量规划、日常运维、备份恢复、故障排查。

---

## 1. 运行时架构

```
                     ┌─────────────────────────────────────────┐
   浏览器 ──REST────▶│  Express 5                              │
     │     ──WS────▶│   /api/*        （cookie 会话 + RBAC）   │
     │              │   /ws           （按用户分组的实时推送） │
     │              └──────────────┬──────────────────────────┘
     │                             │
     │              ┌──────────────▼──────────────────────────┐
     │              │  RunnerRegistry（运行时注册表）          │
     │              │   每个游戏账号一个 AccountRuntime         │
     │              │    ├─ GameClient（HMAC 签名 / proof 续期）│
     │              │    ├─ ProxyDispatcherHolder（独立出口）   │
     │              │    └─ 11 个内置模块实例                   │
     │              └──────────────┬──────────────────────────┘
     │                             │
     │              ┌──────────────▼──────────────────────────┐
     └─────────────▶│  SQLite（WAL）                          │
                    │   用户 / 账号(凭证加密) / 代理 /         │
                    │   模块配置 / 日志 / 日统计 / 审计         │
                    └─────────────────────────────────────────┘
```

关键设计取舍：

| 决定 | 原因 |
| --- | --- |
| `node:sqlite`（Node 24 内置）而非 better-sqlite3 | 零原生依赖，Alpine 镜像不需要 python3/make/g++ |
| scrypt 而非 argon2 | 同上；scrypt 是 Node 内置且在 OWASP 推荐之列 |
| 不做 TS 编译，直接跑 `.ts` | Node 24 原生类型剥离；容器内代码与仓库一致，排障更直接 |
| 每账号常驻 `AccountRuntime`（即使已停止） | 停止后 UI 仍要展示地图/等级/统计 |
| WebSocket 按 `userId` 分组 | 多用户隔离；越权在这层就要挡住 |

---

## 2. 容量规划

**挂机本身极轻**。真正的开销在两处：并发登录的瞬时请求，以及每个账号一个的
HTTP 连接池。

| 资源 | 建议 |
| --- | --- |
| 内存 | 实测 2 个运行中账号约 58 MB；每个账号再多几 MB。`MAX_RUNNING_ACCOUNTS=50` 时预留 1 GB（compose 默认上限就是 1G） |
| CPU | 基本空闲（每账号 6 秒一次同步）。登录/口令哈希是唯一的 CPU 尖峰（scrypt 单次瞬时约 32 MB） |
| 磁盘 | 日志已落库，按**每用户 2 万条**封顶（约几 MB/用户），与保留天数取先到者 |

**并发上限怎么调**：

```env
MAX_RUNNING_ACCOUNTS=50    # 全局；超了会明确拒绝启动并说明原因
MAX_ACCOUNTS_PER_USER=5    # 单用户；防止一个用户占满配额
```

启动时会**错峰**恢复自动启动的账号（每个间隔 2.5 秒），避免同时登录触发游戏侧风控。
50 个账号全部恢复需要约 2 分钟 —— 这期间服务已可用，只是账号陆续上线。

---

## 3. 日常运维

```bash
# 状态与日志
docker compose ps
docker compose logs -f --tail=100 app

# 健康检查（容器内自带 HEALTHCHECK，这里手动看一眼）
curl -s http://127.0.0.1:8580/api/health

# 重启（账号会按 autoStart 自动恢复）
docker compose restart app

# 进容器排查
docker compose exec app sh
docker compose exec app node -e "
  const {DatabaseSync}=require('node:sqlite');
  const d=new DatabaseSync('/app/data/reelax.db');
  console.log('users', d.prepare('SELECT count(*) c FROM users').get().c);
  console.log('accounts', d.prepare('SELECT count(*) c FROM game_accounts').get().c);
  console.log('logs', d.prepare('SELECT count(*) c FROM logs').get().c);
"
```

### 在线更新

三种方式，按「省事」到「省资源」排：

**A. 面板一键更新（需要 updater）**

```bash
# 1) .env 里配好
#    REELAX_UPDATER_URL=http://updater:9000
#    REELAX_PROJECT_DIR=/绝对路径/到/reelax-server
#    UPDATER_MODE=pull                 # 可选：auto（默认）/ git / pull，见下
#    GITHUB_TOKEN=ghp_xxx              # 只有 git 模式 + 私有仓库才需要
#    UPDATER_TOKEN=随便一串            # 可选：开启后 app 会带令牌，两边用同一个变量

# 2) 带 profile 起服务
docker compose --profile update up -d --build
```

之后在「管理 → 系统 → 在线更新」点按钮。updater 的行为取决于模式（`UPDATER_MODE`）：

| 模式 | 它做什么 | 适合 |
| --- | --- | --- |
| `pull` | `docker compose pull app` → `up -d` | **最省资源**：镜像由 GitHub Actions 预构建推到 GHCR，主机只下载变化的层，几秒钟、几乎不吃 CPU。tar 解压部署也只有这条路 |
| `git` | `git pull --ff-only` → `up -d --build`（在本机构建） | 想改代码后直接生效、或有自己的构建需求。需要挂载的仓库里有 `.git`，构建期间占 1~2 核 + 几百 MB + 1~2 GB 磁盘 |
| `auto`（默认） | 有 `.git` 走 `git`，否则走 `pull` | 不想操心的默认值 |

**B. 宿主机脚本**：`./scripts/update.sh` 或 `.\scripts\update.ps1`（git 工作区里用；会自动带 APP_COMMIT）

**C. 直接拉预构建镜像**（不需要 git、不需要构建、不需要 updater）：

```bash
cd /绝对路径/到/reelax-server
docker compose pull app && docker compose up -d
```

预构建镜像：`.github/workflows/ci.yml` 的 `publish` 任务会在每次 `main` 提交通过校验后，
构建 `linux/amd64` + `linux/arm64` 两种架构并推到 `ghcr.io/creator2k/reelax-server`（同时打 `sha-<短提交>` 标签便于回滚）。
镜像里烧了提交号，所以面板的「当前版本」永远读得到。

> ★ **只有拉取报 401 时才需要动可见性**：GHCR 的包一般继承仓库可见性（本仓库是公开的，
> 实测推完即可匿名 `docker compose pull`）。万一你的包是私有的，去
> `https://github.com/users/Creator2K/packages/container/reelax-server/settings`
> → Danger Zone → Change visibility → Public；或者干脆在主机上 `docker login ghcr.io`。

**实现要点（排障时会用到）**：

- updater 是唯一挂了 `docker.sock` 的容器；app 本身不具备改代码的能力
- **compose 项目名必须一致**：`docker-compose.yml` 顶部用 `name: reelax-server` 固定，
  updater 也注入同名 `COMPOSE_PROJECT_NAME`。否则 updater 会从 `/project` 推导出
  项目名 `project`，去新建一套容器/网络/卷，并在 `container_name` 上撞车
  （症状：`Container name "/reelax-server" is already in use`）
- 私有仓库的 `git pull` 靠 `GITHUB_TOKEN`，通过一次性 `http.extraheader` 注入
  （**不写进 remote URL**，否则 token 会留在挂载进容器的 `.git/config` 里）
- 版本显示靠构建参数：镜像里没有 `.git`，所以把提交号用
  `ARG APP_COMMIT` 烧进镜像。CI 用 `GITHUB_SHA`、updater 在 pull 之后把确切提交传给构建
- Linux 上 updater 以 root 操作挂载进来的仓库，git ≥ 2.35 会因属主不同拒绝
  （`detected dubious ownership`）——updater 里已经用 `GIT_CONFIG_*` 传了 `safe.directory`；
  若你自己写脚本调 git，也要注意这点

### 推送通道

- **Server酱**：填 SendKey 即可（添加时会先发一条测试消息验证，填错会拒绝保存）
- **微信机器人**：添加后扫码登录 → 用微信给机器人发一条消息完成绑定
- 微信凭证存放在 `DATA_DIR/wechat-creds/<通道id>/`，**跟着数据卷一起备份**
- 同一个微信号同时只能有一个机器人在轮询（否则消息游标互相覆盖、两边都丢消息）

**服务自动做的维护**（不需要你配 cron）：

- 每 5 分钟 `wal_checkpoint(TRUNCATE)`，防 WAL 无界增长
- 每小时清理过期登录会话、超过 `LOG_RETENTION_DAYS` 的日志、180 天前的审计事件
- 每用户日志上限 2 万条（超出删最旧）
- 每天一份数据库快照（`VACUUM INTO`，保留最近 3 份；**迁移前也会额外备份一次**）
  ⚠ 快照与数据库在同一个卷里，卷损坏会一起丢 —— 重要数据请按上面第 3 节做异地备份

**日志为什么只留得下十几个小时**：日志按「每用户 2 万条」封顶，而引擎每个模块每轮
都会记一条「本轮没做什么」的说明 —— 这些已降为 `debug`（不落库）。
若把 `LOG_LEVEL` 改成 `debug`，它们会重新进入内存与实时页面，但**不会**落库。

**优雅关闭**：容器用 `tini` 作 PID 1 转发信号，收到 `SIGTERM` 后会
先停全部引擎（**并发停**，把状态与统计写回数据库），再关推送、落最后一批日志、
关 WS 与数据库。compose 里配了 `stop_grace_period: 30s`（Docker 默认只给 10 秒，
账号多时会被 SIGKILL 掉，从而丢状态与日志）。

---

## 4. 备份与恢复

### 需要备份什么

只有 `DATA_DIR`（Docker 里是 `reelax-data` 卷）。核心是 `reelax.db`。
**`MASTER_KEY` 必须单独保存**（密码管理器/密钥库），它不在数据卷里。

### 一致性备份

不要直接 `cp reelax.db` —— WAL 模式下可能拷到不一致的快照。用 `VACUUM INTO`：

```bash
# 容器内生成一致快照，再拷出来
docker compose exec app node -e "
  const {DatabaseSync}=require('node:sqlite');
  new DatabaseSync('/app/data/reelax.db').prepare('VACUUM INTO ?').run('/app/data/backup.db');
"
docker compose cp app:/app/data/backup.db "./reelax-$(date +%F).db"
```

**crontab 每日备份示例**：

```cron
17 4 * * * cd /opt/reelax-server && docker compose exec -T app node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/app/data/reelax.db').prepare('VACUUM INTO ?').run('/app/data/auto-backup.db')" && docker compose cp app:/app/data/auto-backup.db "/opt/backups/reelax-$(date +\%F).db" && find /opt/backups -name 'reelax-*.db' -mtime +30 -delete
```

### 恢复

```bash
docker compose down
docker run --rm -v reelax-server_reelax-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -f /data/reelax.db* && cp /backup/reelax-2026-10-09.db /data/reelax.db"
docker compose up -d
```

恢复后确认：

```bash
curl -s http://127.0.0.1:8580/api/health
docker compose logs --tail=30 app    # 应看到「已为 N 个账号建立运行时」
```

> ⚠️ 恢复后**必须使用与原数据相同的 `MASTER_KEY`**。用错密钥时账号详情页会明确
> 显示「凭证无法解密」，而不是静默失败 —— 这时换回正确密钥，或重新填写凭证。

---

## 5. 故障排查

### 服务起不来

| 现象 | 原因与处理 |
| --- | --- |
| `MASTER_KEY 未设置` 后退出 | 有意设计。`openssl rand -hex 32` 填进 `.env` |
| `MASTER_KEY 必须是 64 个十六进制字符` | 长度或字符不对，重新生成 |
| `端口 8580 已被占用` | 改 compose 的 `ports` 映射（如 `9000:8580`） |
| `迁移 xxx 失败，数据库未改动` | 数据文件损坏或版本不兼容；按提示用自动备份恢复 |
| `EACCES` 写 `/app/data` | 卷权限问题；`chown -R 1000:1000 <卷目录>` |

### 登录相关

| 现象 | 原因与处理 |
| --- | --- |
| 登录成功但立刻又是未登录 | `COOKIE_SECURE=1` 但访问的是 HTTP。清空该变量 |
| `网络不可达：请确认服务是否在运行` | 前端连不上后端；检查反代是否把 `/api` 也转发了 |
| 一直停在「等待审批」 | 管理员还没批准；到「管理 → 用户」点批准 |
| 提示「登录失败次数过多」 | 触发限流（5 次/15 分钟）。等待或重启容器清空计数 |

### 挂机相关

| 现象 | 原因与处理 |
| --- | --- |
| 账号状态「凭证失效」 | Cookie 过期且无账密。重新填写密码或 Cookie |
| 状态「重连中」刷屏 | 先在「代理」页测试连通性；失败分类会区分代理问题与游戏侧问题 |
| 「凭证无法解密」 | `MASTER_KEY` 与数据不匹配。换回正确密钥或重填凭证 |
| 结算模式不是 online | 同步不及时（宿主机休眠/断网）。云端部署最稳定，恢复后会自动回到在线 |
| 提示与官方航线助手冲突 | 到游戏内关掉航线助手的「自动换图」，或关掉本服务的「自动切图」 |
| 无法启动，提示并发上限 | 已达 `MAX_RUNNING_ACCOUNTS`；停掉其他账号或调大上限 |

### 看真实错误

```bash
# 容器日志（含启动期错误）
docker compose logs -f app

# 改 debug 级别看请求细节（会明显变啰嗦，排查完记得改回）
# .env: LOG_LEVEL=debug && docker compose up -d
```

界面「运行日志」页可实时看，并支持按账号 / 级别 / 关键字过滤。

日志同时会**落库**（`info` 及以上，按用户隔离，每用户上限 2 万条）：
- 微信命令「日志」会读它，回复最近的日志
- 重启后仍可回溯（实时页是内存缓冲，重启即清空）
- 保留天数在「后台 → 设置 → 日志保留天数」里改，改完立即生效

---

## 6. 安全说明

**凭证是如何保护的**

- 游戏密码 / Cookie / 代理口令一律 **AES-256-GCM** 加密后入库
- 主密钥不直接用，而是按用途（凭证 / Cookie / 代理）用 **HKDF 派生**不同子密钥
- 加密时把 `userId + 字段名` 作为 **AAD** 绑定，密文无法在行间搬运复用
- 每次写入使用**全新随机 nonce**
- 接口**永不回传明文**：列表只返回 `hasPassword` 之类的布尔值
- 数据库里只存会话 token 的 **SHA-256**，明文只在用户的 HttpOnly cookie 里
- 口令用 **scrypt**（N=2^15, r=8, p=1，约 32 MB 内存）哈希

**建议**

- 整站 HTTPS（见 README 的反代示例），并把 `COOKIE_SECURE=1`
- 关闭 `ALLOW_REGISTRATION`，仅用邀请码 + 审批发放账号
- 不要把 8580 直接暴露公网
- 限制 `data/` 目录的文件权限（含加密凭证与日志）
- **把 `MASTER_KEY` 和 `data/` 一起妥善备份**（两者缺一不可：只备份数据库、丢了密钥，
  里面的游戏口令 / Cookie / 推送 SendKey 就永久解不开了）

> ⚠ **不要轮换 `MASTER_KEY`。** 早期文档在这里写过「密钥环支持多版本、可定期轮换」，
> 但代码只从 `MASTER_KEY` 构造单版本密钥环、也没有轮换命令：换掉这个值之后，
> 所有已存凭证立刻无法解密（表现为「账号突然登不上、推送发送失败」，且无法回滚）。

**关于游戏侧风险**

多账号并发登录、自动化操作客观上属于多数游戏用户协议禁止的行为。
服务本身已做了错峰启动、同步抖动、退避重试来降低特征，但**风险由使用者自担**。

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
| 内存 | 每 10 个运行中账号约 30~60 MB。`MAX_RUNNING_ACCOUNTS=50` 时 256~512 MB 足够 |
| CPU | 基本空闲（每账号 6 秒一次同步）。登录/口令哈希是唯一的 CPU 尖峰 |
| 磁盘 | 每账号每天约 0.5~2 MB 日志。`LOG_RETENTION_DAYS=14` 下 50 账号约 0.5~1.5 GB |

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

# 升级
git pull
docker compose up -d --build

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

**服务自动做的维护**（不需要你配 cron）：

- 每 5 分钟 `wal_checkpoint(TRUNCATE)`，防 WAL 无界增长
- 每小时清理过期登录会话、超过 `LOG_RETENTION_DAYS` 的日志、180 天前的审计事件
- 每用户日志上限 2 万条（超出删最旧）
- 启动时对数据库做一次 `VACUUM INTO` 快照，保留最近 3 份

**优雅关闭**：容器用 `tini` 作 PID 1 转发信号，收到 `SIGTERM` 后会
先停全部引擎（把状态与统计写回数据库），再关 HTTP 与数据库。
`docker stop` 默认给 10 秒，超时会强杀 —— 本服务的关闭流程远快于此。

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
历史日志在「运行日志 → 历史」里查（数据来自数据库，可翻页）。

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
- 定期轮换 `MASTER_KEY`（密钥环已支持多版本共存，`v1`/`v2` 可同时解密）

**关于游戏侧风险**

多账号并发登录、自动化操作客观上属于多数游戏用户协议禁止的行为。
服务本身已做了错峰启动、同步抖动、退避重试来降低特征，但**风险由使用者自担**。

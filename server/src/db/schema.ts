// 表结构定义（DDL）
//
// 约定：
//  - 所有时间为 INTEGER 毫秒（与 Date.now() 一致，前端无需做时区换算）
//  - * 加密字段为 TEXT，格式 v1.<nonce>.<tag>.<ciphertext>（见 security/crypto.ts）
//  - 外键一律 ON DELETE CASCADE：删用户即清其账号、代理、模块配置、日志
//  - 用 node:sqlite（Node 24 内置），无原生依赖 —— Alpine 镜像不需要编译工具链

export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "0001_init",
    sql: `
-- ---------- 用户 ----------
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
  status         TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'banned'
  approved_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at    INTEGER,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
-- 邮箱大小写不敏感唯一
CREATE UNIQUE INDEX idx_users_email ON users (lower(email));
CREATE INDEX idx_users_status ON users (status);

-- ---------- 登录会话 ----------
CREATE TABLE auth_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,   -- 只存 SHA-256，明文 token 只在 cookie 里
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions (expires_at);

-- ---------- 邀请码 ----------
CREATE TABLE invite_codes (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  max_uses    INTEGER,                 -- NULL = 不限次
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,                 -- NULL = 不过期
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL
);

-- ---------- 代理 ----------
CREATE TABLE proxies (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  protocol       TEXT NOT NULL,        -- 'http' | 'https' | 'socks5'
  host           TEXT NOT NULL,
  port           INTEGER NOT NULL,
  username       TEXT,
  password_enc   TEXT,
  last_check_at  INTEGER,
  last_check_ok  INTEGER,              -- 0/1
  last_check_ms  INTEGER,
  last_exit_ip   TEXT,
  last_error     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_proxies_user ON proxies (user_id);

-- ---------- 游戏账号 ----------
CREATE TABLE game_accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  auth_type     TEXT NOT NULL DEFAULT 'credentials',  -- 'credentials' | 'cookie'
  email         TEXT NOT NULL DEFAULT '',
  password_enc  TEXT,
  cookie_enc    TEXT,
  base_url      TEXT NOT NULL,
  proxy_id      TEXT REFERENCES proxies(id) ON DELETE SET NULL,
  auto_start    INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'stopped',
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_accounts_user ON game_accounts (user_id);
CREATE INDEX idx_accounts_proxy ON game_accounts (proxy_id);

-- ---------- 账号 × 模块配置 ----------
CREATE TABLE account_modules (
  account_id  TEXT NOT NULL REFERENCES game_accounts(id) ON DELETE CASCADE,
  module_id   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, module_id)
);

-- ---------- 日志 ----------
CREATE TABLE logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  account_id  TEXT,
  level       TEXT NOT NULL,
  module_id   TEXT,
  tag         TEXT NOT NULL,
  msg         TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_logs_created ON logs (created_at);
CREATE INDEX idx_logs_user_created ON logs (user_id, created_at DESC);
CREATE INDEX idx_logs_account ON logs (account_id, created_at DESC);

-- ---------- 每日统计 ----------
CREATE TABLE account_stats_daily (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL REFERENCES game_accounts(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  day           TEXT NOT NULL,          -- YYYY-MM-DD（本地日）
  casts         INTEGER NOT NULL DEFAULT 0,
  fish          INTEGER NOT NULL DEFAULT 0,
  gold          INTEGER NOT NULL DEFAULT 0,
  experience    INTEGER NOT NULL DEFAULT 0,
  income        INTEGER NOT NULL DEFAULT 0,
  bait_cost     INTEGER NOT NULL DEFAULT 0,
  net_gold      INTEGER NOT NULL DEFAULT 0,
  gear          INTEGER NOT NULL DEFAULT 0,
  chests        INTEGER NOT NULL DEFAULT 0,
  relics        INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  UNIQUE (account_id, day)
);
CREATE INDEX idx_stats_user_day ON account_stats_daily (user_id, day DESC);

-- ---------- 审计 ----------
CREATE TABLE audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail_json TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_events (created_at DESC);
CREATE INDEX idx_audit_user ON audit_events (user_id, created_at DESC);
`,
  },

  // ★ 迁移一旦发布就**绝不能再改**：已应用过它的数据库不会重跑。
  //   新增表/字段一律追加新的迁移项（下面这个就是教训的产物 ——
  //   最初把 notify_channels 写进了 0001_init，结果已有数据库启动时报
  //   "no such table: notify_channels"）。
  {
    id: "0002_notify_channels",
    sql: `
-- ---------- 推送通道 ----------
-- 每个用户可配多个通道（Server酱 / 微信机器人），日报等消息会推给全部已启用通道。
-- config_enc 是密文：Server酱存 SendKey，微信存凭证目录与绑定目标。
CREATE TABLE notify_channels (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,          -- 'serverchan' | 'wechat'
  label         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  config_enc    TEXT,                   -- AES-256-GCM，AAD 绑定 userId
  status        TEXT NOT NULL DEFAULT 'idle',   -- idle|starting|qrcode|scanned|online|bound|error
  status_detail TEXT,
  target_id     TEXT,                   -- 微信：绑定的接收人 userId
  target_label  TEXT,
  qr_text       TEXT,                   -- 微信：当前二维码内容（前端自行渲染）
  sent_count    INTEGER NOT NULL DEFAULT 0,
  last_sent_at  INTEGER,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_notify_user ON notify_channels (user_id, created_at);
CREATE INDEX idx_notify_kind ON notify_channels (kind);
`,
  },

  // ---------- 可在线修改的运行时设置 ----------
  // 为什么放进数据库而不是只读环境变量：这些值运维时经常要临时调（开一段注册、
  // 给某个人多开几个账号额度），要求改 .env + 重启容器太重。
  // 规则：环境变量提供**初始值**（首次启动写入），之后以数据库为准。
  {
    id: "0003_app_settings",
    sql: `
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
`,
  },

  // ---------- 微信绑定的验证码 ----------
  // 为什么需要：任何给机器人发消息的人都会「首次绑定成为接收人」，
  // 陌生人误发一条消息就能把别人的推送收走。改成两步：
  //   1) 收到消息 → 生成 6 位验证码并回复
  //   2) 用户把验证码发回来 → 才算绑定成功
  {
    id: "0004_notify_verify_code",
    sql: `
ALTER TABLE notify_channels ADD COLUMN verify_code TEXT;
ALTER TABLE notify_channels ADD COLUMN verify_expires_at INTEGER;
ALTER TABLE notify_channels ADD COLUMN verify_attempts INTEGER NOT NULL DEFAULT 0;
-- 等待验证码的临时接收人（验证通过后才落到 target_id）
ALTER TABLE notify_channels ADD COLUMN pending_target_id TEXT;
`,
  },
];

/** 供 migrate.ts 记录已应用版本 */
export const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  id         TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

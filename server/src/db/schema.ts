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

  // ---------- 单用户的账号额度覆盖 ----------
  // 为什么需要：全局默认额度（设置页里那个）是给所有人的，但经常要给某个人放宽/收紧。
  // NULL = 跟随全局默认；有值则只对这个人生效。
  {
    id: "0005_user_quota_override",
    sql: `
ALTER TABLE users ADD COLUMN quota_override INTEGER;
`,
  },

  // ---------- 模块运行状态（跨重启保留） ----------
  // 为什么需要：`ctx.state` 原本只在内存里，进程一重启就没了。收益日报因此丢掉
  // 「刚结束那一天」的暂存数据，重启后再发就只能显示「今日截至现在」或「无基线」，
  // 而本项目每次在线更新都会重启容器。
  // 与 config_json 分开存：config 是用户可编辑的配置，state 是引擎自己的进度，
  // 混在一起会让状态出现在配置界面上、也会被「恢复默认」清掉。
  {
    id: "0006_module_state",
    sql: `
ALTER TABLE account_modules ADD COLUMN state_json TEXT NOT NULL DEFAULT '{}';
`,
  },

  // ---------- CDK 公共库 ----------
  // 为什么需要独立一张表：CDK 是"跨用户共享的资源池"——任何人提交、任何人兑换，
  // 不属于某个账号的配置，所以不能塞进 account_modules。
  //
  // normalized 上的唯一约束是重复提交的唯一防线：`moyu666` / `MOYU-666` / `moyu 666`
  // 归一化后同一个值，插入时直接撞唯一键（不靠先查后插的竞态判断）。
  {
    id: "0007_cdk_codes",
    sql: `
CREATE TABLE cdk_codes (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL,                    -- 展示用（提交者的原始写法，大写）
  normalized       TEXT NOT NULL UNIQUE,             -- 归一化：去空格/连字符 + 大写
  status           TEXT NOT NULL DEFAULT 'available',-- available | not_started | exhausted
  reward_json      TEXT,                             -- 兑换成功后实际到账的奖励摘要
  submitted_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submitted_at     INTEGER NOT NULL,
  account_id       TEXT,                             -- 提交时用于验证的账号
  last_error       TEXT,                             -- 最近一次失败原因（未开始 / 已领取过 / 失效）
  success_count    INTEGER NOT NULL DEFAULT 0,       -- 成功兑换次数（每账号一次可重复领）
  last_redeemed_by TEXT,
  last_redeemed_at INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_cdk_status ON cdk_codes (status, submitted_at DESC);
CREATE INDEX idx_cdk_submitter ON cdk_codes (submitted_by, submitted_at DESC);
`,
  },

  // ---------- 以物易物交换任务（多轮交换的队列） ----------
  // 为什么需要独立一张表，而不是塞进 account_modules.state_json：
  //  · 任务要在**账号没启动、模块没开**的时候也能在面板里增删查看（state_json 只在
  //    「用户配置过该模块」时才写得进去）；
  //  · 队列是有生命周期与状态的事物（等待 / 进行中 / 完成 / 缺鱼 / 取消），
  //    和「模块私有进度」不是一类东西，混在一起会让两边都难读。
  // 状态取值：waiting（等路径）| running（正在换）| done（已换够）| blocked（起点鱼不够）
  //          | cancelled（用户取消）
  {
    id: "0008_barter_tasks",
    sql: `
CREATE TABLE barter_tasks (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES game_accounts(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_fish_id     TEXT NOT NULL,                    -- 拿出去的鱼（起点）
  from_fish_name   TEXT NOT NULL DEFAULT '',         -- 展示用快照：鱼名不会变
  from_biome_id    TEXT,                             -- 起点鱼所属地图
  rarity           TEXT NOT NULL DEFAULT '',         -- 起点鱼的稀有度（整条链都必须是它）
  quantity         INTEGER NOT NULL DEFAULT 1,       -- 想换到几条目标鱼
  done_quantity    INTEGER NOT NULL DEFAULT 0,       -- 已经换到几条
  target_biome_id  TEXT NOT NULL,                    -- 目标地图
  target_fish_id   TEXT,                             -- NULL = 该地图上任意同稀有度鱼
  target_fish_name TEXT NOT NULL DEFAULT '',          -- 展示用快照（为空 = 该地图任意鱼）
  status           TEXT NOT NULL DEFAULT 'waiting',
  last_note        TEXT,                             -- 最近一次进度的中文说明（面板直接展示）
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_barter_tasks_account ON barter_tasks (account_id, created_at);
CREATE INDEX idx_barter_tasks_open ON barter_tasks (account_id, status);
`,
  },

  // ---------- 交换任务支持「多起点 × 多目标」 ----------
  // 为什么需要：一条任务常常是「B2 / B3 / B4 上的鱼都能拿去换，换到 B1 / B5 / B6 上任意一种都算达成」——
  // 与官方挂单的结构一致（每边多种鱼，任意组合都算成交）。
  // 老任务不受影响：这两列是空的就按原来的单起点 / 单目标解读（见 barter-tasks 仓储）。
  // 每项形如 { biomeId, rarity, fishId }：fishId 非空 = 指名鱼种（老数据），否则 = 该地图上的任意同稀有度鱼。
  {
    id: "0009_barter_task_specs",
    sql: `
ALTER TABLE barter_tasks ADD COLUMN from_specs_json TEXT NOT NULL DEFAULT '';
ALTER TABLE barter_tasks ADD COLUMN target_specs_json TEXT NOT NULL DEFAULT '';
`,
  },

  // ---------- 撤掉「交换任务」队列 ----------
  // 需求变了：自动以物易物（模块 + 交换任务面板 + 队列）整体下线，
  // 改成手动工具「交换助手」（扫全市场找链、自己点执行，见 services/swap-service.ts），
  // 那条队列就没有任何使用者了 —— 按「已发布的迁移只增不改」的规矩，这里补一条把它删掉。
  {
    id: "0010_drop_barter_tasks",
    sql: `
DROP TABLE barter_tasks;
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

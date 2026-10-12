// 日志脱敏（管理员后台查看**别人的**运行日志时使用）
//
// 原则：**只遮机密，不遮上下文**。
//
// 为什么不做"整段打码"：管理员点进日志页的目的是排查问题（"为什么这个号的代理连不上"），
// 把内容整段遮掉等于什么也没给。所以只对**明确的机密形状**动手：
//   · Authorization: Bearer / Basic 后面的值
//   · key=value / key: value 里的密码、token、secret、cookie、签名、幂等键
//   · 常见会话 cookie 键值对（reelax_session=… / arcane_session=…）
//   · 各家长 token（Server酱 SCT…、GitHub ghp_…、OpenAI sk-…、Slack xox…）
//   · 邮箱只留首字母与域名（a***@example.com）
//   · 又长又随即的串（≥32 位 hex / base64url：裸 token、幂等键、去掉横线的 uuid）
//
// 故意**不**脱敏的东西（排查要用）：出口 IP、`host:port`、地图/鱼饵/模块 id、
// 账号标签、错误码与错误原文、HTTP 路径。
//
// 上下文：普通用户看自己的日志不脱敏（本来就是他自己产生的）；只有管理员跨用户查看时套这层。

/** 一条规则 = 一个明确的机密形状；顺序有意义（先处理带前缀的，再处理长串兜底） */
const RULES: Array<{ why: string; re: RegExp; repl: string | ((m: string, ...g: string[]) => string) }> = [
  {
    why: "Authorization 头（Bearer / Basic）",
    re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    repl: "$1 ***",
  },
  {
    why: "key=value / key: value 形式的机密字段",
    re: /\b(pass(?:word|wd)?|passwd|token|secret|sendkey|send_key|cookie|authorization|api[_-]?key|proof|signature|idempotency[-_]?key)\b(\s*[:=]\s*)("?)([^\s,;"']{4,})\3/gi,
    repl: (_m, key: string, sep: string) => `${key}${sep}***`,
  },
  {
    why: "会话 cookie 键值对（reelax_session=… / arcane_session=…）",
    re: /\b([a-z0-9_]*(?:session|sess|sid|csrf)[a-z0-9_]*)=([^\s;,"']{4,})/gi,
    repl: "$1=***",
  },
  {
    why: "带前缀的第三方 token（Server酱 SCT… 无分隔符，GitHub/OpenAI/Slack 带前缀）",
    re: /\b(?:SCT[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
    repl: "***",
  },
  {
    why: "邮箱（保留首字母与域名，便于分辨是谁）",
    re: /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g,
    repl: "$1***$2",
  },
  {
    why: "长随机串（≥32 位的 hex / base64url：裸 token、幂等键、无横线 uuid）",
    re: /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g,
    repl: (m: string) => `${m.slice(0, 4)}***(${m.length} 位已脱敏)`,
  },
];

/** 把一段日志文本里明确的机密遮掉（纯函数） */
export function redactLogText(input: unknown): string {
  let s = String(input ?? "");
  if (!s) return s;
  for (const rule of RULES) {
    s = typeof rule.repl === "string" ? s.replace(rule.re, rule.repl) : s.replace(rule.re, rule.repl as never);
  }
  return s;
}

/** 脱敏后的日志条目（管理员日志页的形状） */
export type RedactedLogEntry = {
  t: number;
  level: string;
  userId: string | null;
  accountId: string | null;
  moduleId: string | null;
  tag: string;
  msg: string;
};

/** 供路由复用：把仓储行转成脱敏后的条目 */
export function redactLogRow(row: {
  created_at: number | string;
  level: string;
  user_id: string | null;
  account_id: string | null;
  module_id: string | null;
  tag: string;
  msg: string;
}): RedactedLogEntry {
  return {
    t: Number(row.created_at),
    level: row.level,
    userId: row.user_id,
    accountId: row.account_id,
    moduleId: row.module_id,
    tag: redactLogText(row.tag),
    msg: redactLogText(row.msg),
  };
}

// 环境变量解析与校验
//
// 原则：**启动时就校验，不要等到用到才发现配错**。MASTER_KEY 缺失直接退出，
// 不做「自动生成后写进 data」的降级 —— 那种降级会让备份恢复到新机器后凭证永久不可解。
import { z } from "zod";

const boolish = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : /^(1|true|yes|on)$/i.test(v)))
  .pipe(z.boolean().optional());

const intish = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int());

const schema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: intish(8580),
  HOST: z.string().optional().default("127.0.0.1"),
  DATA_DIR: z.string().optional().default("./data"),

  MASTER_KEY: z.string().optional().default(""),

  REELAX_BASE_URL: z.string().optional().default("https://reelax.cn"),
  REELAX_GLOBAL_PROXY: z.string().optional().default(""),
  PROXY_ECHO_URL: z.string().optional().default("https://api.ipify.org?format=json"),

  TRUST_PROXY: boolish,
  COOKIE_SECURE: boolish,

  ALLOW_REGISTRATION: boolish,
  MAX_ACCOUNTS_PER_USER: intish(5),
  MAX_RUNNING_ACCOUNTS: intish(50),

  // ---- 在线更新 ----
  /** GitHub owner/repo，用于查询远端最新提交 */
  REELAX_REPO: z.string().optional().default("Creator2K/reelax-server"),
  /** 旁路 updater 地址（如 http://updater:9000）；未配置则没有"一键更新" */
  REELAX_UPDATER_URL: z.string().optional().default(""),
  /**
   * 是否允许本进程直接 git pull + 重建。
   * Docker 部署下必须为 0（代码在镜像里，改不了自己）；本地 node 运行时可开。
   */
  ALLOW_LOCAL_UPDATE: boolish,

  // ---- 部署时的默认管理员 ----
  /**
   * 启动时自动创建/修正的管理员登录名。
   * 留空 = 不自动创建（此时「第一个注册的用户」成为管理员，适合本地自用）。
   */
  ADMIN_USERNAME: z.string().optional().default("admin"),
  /**
   * 管理员口令。留空 = 每次全新创建时**随机生成**并在启动日志里打印一次。
   * 一旦设置，每次启动都会把该账号口令重置成这个值（便于找回）。
   */
  ADMIN_PASSWORD: z.string().optional().default(""),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  LOG_RETENTION_DAYS: intish(14),

  SESSION_TTL_DAYS: intish(30),
});

export type Env = {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  dataDir: string;
  masterKey: Buffer;
  baseUrl: string;
  globalProxy: string;
  proxyEchoUrl: string;
  trustProxy: boolean;
  /**
   * 会话 cookie 的 Secure 策略：
   *  - undefined：按每次请求的实际协议自动判断（推荐，默认）
   *  - true/false：用 COOKIE_SECURE 显式强制
   *
   * ★ 不再「production 就强制 true」：那样在「反代只做 80 端口」或
   *   「局域网 IP 直连」的部署里会出现「登录成功但立刻又未登录」，
   *   因为浏览器不会在 http:// 下回传 Secure cookie。
   */
  cookieSecure: boolean | undefined;
  allowRegistration: boolean;
  maxAccountsPerUser: number;
  maxRunningAccounts: number;
  logLevel: "debug" | "info" | "warn" | "error";
  logRetentionDays: number;
  sessionTtlDays: number;
  /** 在线更新相关 */
  repoSlug: string;
  updaterUrl: string | null;
  allowLocalUpdate: boolean;
  /** 部署时的默认管理员（username 为空表示不自动创建） */
  adminUsername: string;
  /** 管理员指定口令（空表示随机生成） */
  adminPassword: string;
};

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

/** 把人类可读的错误一次性列全，而不是抛第一个就停 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  · ${i.path.join(".") || "(根)"}：${i.message}`);
    throw new EnvError(`环境变量校验失败：\n${lines.join("\n")}`);
  }
  const e = parsed.data;

  const problems: string[] = [];

  let masterKey = Buffer.alloc(0);
  const raw = e.MASTER_KEY.trim();
  if (!raw) {
    problems.push(
      "  · MASTER_KEY 未设置。它是凭证加密主密钥，必须显式提供（不提供就无法在换机/恢复后解密）。\n" +
        "    生成一个：openssl rand -hex 32",
    );
  } else if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    problems.push(
      `  · MASTER_KEY 必须是 64 个十六进制字符（32 字节），当前长度 ${raw.length}。\n` +
        "    生成一个：openssl rand -hex 32",
    );
  } else {
    masterKey = Buffer.from(raw, "hex");
  }

  if (e.MASTER_KEY && raw && masterKey.length === 0) {
    // 理论上不可达，保留兜底
    problems.push("  · MASTER_KEY 解析失败");
  }

  let baseUrl = e.REELAX_BASE_URL.trim();
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      problems.push(`  · REELAX_BASE_URL 协议必须是 http/https，当前 ${u.protocol}`);
    }
    baseUrl = baseUrl.replace(/\/+$/, "");
  } catch {
    problems.push(`  · REELAX_BASE_URL 不是合法 URL：${baseUrl}`);
  }

  if (e.PROXY_ECHO_URL) {
    try {
      new URL(e.PROXY_ECHO_URL);
    } catch {
      problems.push(`  · PROXY_ECHO_URL 不是合法 URL：${e.PROXY_ECHO_URL}`);
    }
  }

  if (e.PORT < 0 || e.PORT > 65535) problems.push(`  · PORT 超出范围：${e.PORT}`);
  if (e.MAX_ACCOUNTS_PER_USER < 1) problems.push(`  · MAX_ACCOUNTS_PER_USER 至少为 1`);
  if (e.MAX_RUNNING_ACCOUNTS < 1) problems.push(`  · MAX_RUNNING_ACCOUNTS 至少为 1`);
  if (e.LOG_RETENTION_DAYS < 1) problems.push(`  · LOG_RETENTION_DAYS 至少为 1`);
  if (e.SESSION_TTL_DAYS < 1) problems.push(`  · SESSION_TTL_DAYS 至少为 1`);

  if (problems.length) {
    throw new EnvError(`配置有问题，已阻止启动：\n${problems.join("\n")}`);
  }

  const isProduction = e.NODE_ENV === "production";

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    dataDir: e.DATA_DIR,
    masterKey,
    baseUrl,
    globalProxy: e.REELAX_GLOBAL_PROXY.trim(),
    proxyEchoUrl: e.PROXY_ECHO_URL,
    // 默认：生产环境下 trust proxy 默认开（反代后要取真实 IP 用于限流）；
    // cookie 的 Secure 不按环境猜，交给请求协议判断（见 Env.cookieSecure 注释）。
    trustProxy: e.TRUST_PROXY ?? isProduction,
    cookieSecure: e.COOKIE_SECURE,
    allowRegistration: e.ALLOW_REGISTRATION ?? true,
    maxAccountsPerUser: e.MAX_ACCOUNTS_PER_USER,
    maxRunningAccounts: e.MAX_RUNNING_ACCOUNTS,
    logLevel: e.LOG_LEVEL,
    logRetentionDays: e.LOG_RETENTION_DAYS,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    repoSlug: e.REELAX_REPO.trim(),
    updaterUrl: e.REELAX_UPDATER_URL.trim() || null,
    // Docker 里代码在镜像内，本地 git pull 没有意义（而且容器里通常没有 git）
    allowLocalUpdate: e.ALLOW_LOCAL_UPDATE ?? false,
    adminUsername: e.ADMIN_USERNAME.trim(),
    adminPassword: e.ADMIN_PASSWORD,
  };
}

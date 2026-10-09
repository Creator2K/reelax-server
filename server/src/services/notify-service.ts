// 推送服务：Server酱 + 微信机器人
//
// 设计要点：
//  1) 每个用户可配多个通道，日报等消息**广播**给全部已启用且可用的通道
//  2) 通道配置加密存储（Server酱的 SendKey 泄漏即可被人冒名推送）
//  3) 「日报」配置项在 UI 上受此约束：没有任何可用通道时不给配（见 routes）
//  4) 微信通道跑一个常驻 bot：既能主动推送，也能接收命令并回复
//
// 两个适配器都实现同一个 NotifyAdapter 接口，新增通道只需再写一个适配器。
import fs from "node:fs";
import path from "node:path";
import type { Repos } from "../db/repositories/index.ts";
import type { NotifyKind, NotifyRow, NotifyStatus } from "../db/repositories/notify.ts";
import type { CredentialVault } from "../security/vault.ts";
import type { Logger } from "../lib/logger.ts";
import { HttpError } from "../api/server.ts";

export type NotifyMessage = {
  title: string;
  /** 正文（支持 Markdown，Server酱与微信都按纯文本/Markdown 处理） */
  body: string;
  /** 便于微信里一眼看出是哪个账号 */
  accountLabel?: string | null;
};

export type SendResult = { ok: boolean; error?: string };

export type NotifyChannelView = {
  id: string;
  kind: NotifyKind;
  label: string;
  enabled: boolean;
  /** 是否配置完整（Server酱：有 SendKey；微信：已登录且已绑定接收人） */
  usable: boolean;
  status: NotifyStatus;
  statusDetail: string | null;
  target: { id: string; label: string | null } | null;
  qrText: string | null;
  sentCount: number;
  lastSentAt: number | null;
  lastError: string | null;
  createdAt: number;
  /** 配置摘要（不含密钥），给 UI 显示用 */
  configHint: string | null;
};

export type NotifyServiceDeps = {
  repos: Repos;
  vault: CredentialVault;
  logger: Logger;
  /** 微信凭证目录的根（每个通道一个子目录） */
  dataDir: string;
  /** 收到微信命令时的处理回调（返回要回复的文本） */
  onCommand?: (userId: string, text: string) => Promise<string | null>;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  botFactory?: (opts: { storageDir: string; loginCallbacks: any; log: (m: string) => void }) => Promise<any>;
};

/* ---------------- Server酱 ---------------- */

/** Server酱的标准端点：SendKey 放在路径里 */
function serverChanUrl(sendkey: string): string {
  const key = sendkey.trim();
  // SC3 的 key 以 sctp 开头，走不同的域名
  if (key.startsWith("sctp")) return `https://${key}.push.ft07.com/send`;
  return `https://sctapi.ftqq.com/${key}.send`;
}

export type ServerChanResult = { ok: boolean; code: number | null; message: string };

/**
 * 发送 Server酱 消息。
 * 返回 code === 0 表示成功；非 0 时 message 是可读原因（如 "发送消息失败"）。
 */
export async function sendServerChan(
  sendkey: string,
  title: string,
  desp: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ServerChanResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const key = String(sendkey ?? "").trim();
  if (!key) return { ok: false, code: null, message: "SendKey 为空" };

  let resp: Response;
  try {
    resp = await doFetch(serverChanUrl(key), {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify({ title, desp }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: null, message: `请求 Server酱 失败：${msg}` };
  }

  const text = await resp.text().catch(() => "");
  let parsed: { code?: number; message?: string } | null = null;
  try {
    parsed = text ? (JSON.parse(text) as { code?: number; message?: string }) : null;
  } catch {
    parsed = null;
  }

  if (!resp.ok && !parsed) {
    return { ok: false, code: null, message: `Server酱 返回 HTTP ${resp.status}` };
  }

  const code = typeof parsed?.code === "number" ? parsed.code : null;
  const message = parsed?.message ?? text.slice(0, 200) ?? "";
  if (code === 0) return { ok: true, code: 0, message: "OK" };
  return { ok: false, code, message: message || `Server酱 返回异常（HTTP ${resp.status}）` };
}

/* ---------------- 适配器接口 ---------------- */

interface NotifyAdapter {
  readonly kind: NotifyKind;
  init(channel: NotifyRow): Promise<void>;
  send(channel: NotifyRow, msg: NotifyMessage): Promise<SendResult>;
  /** 停止该通道（停轮询、释放资源） */
  dispose(channelId: string): Promise<void>;
  /** 通道配置是否完整可用 */
  isUsable(channel: NotifyRow): boolean;
  configHint(channel: NotifyRow): string | null;
  /** 通道特有的动作（微信的扫码/解绑等） */
  action?(channel: NotifyRow, name: string): Promise<void>;
}

export class NotifyService {
  private deps: NotifyServiceDeps;
  private adapters = new Map<NotifyKind, NotifyAdapter>();
  private sendServerChanImpl: typeof sendServerChan;

  constructor(deps: NotifyServiceDeps) {
    this.deps = deps;
    this.sendServerChanImpl = sendServerChan;

    this.adapters.set("serverchan", this.createServerChanAdapter());
    this.adapters.set("wechat", this.createWeChatAdapter());
  }

  /* ---------------- Server酱适配器 ---------------- */

  private createServerChanAdapter(): NotifyAdapter {
    const vault = this.deps.vault;
    // 捕获为局部量：对象字面量里的方法 this 指向适配器本身（而不是服务），
    // 用 this.xxx 会编译不过也不安全。
    const sendImpl = this.sendServerChanImpl;
    const deps = this.deps;
    const readKey = (channel: NotifyRow): string | null => {
      if (!channel.config_enc) return null;
      const r = vault.open(channel.config_enc, channel.user_id, "notify_secret");
      return r.ok ? r.value : null;
    };

    return {
      kind: "serverchan",
      async init() {
        /* 无需常驻 */
      },
      isUsable: (channel) => Boolean(channel.config_enc) && readKey(channel) !== null,
      configHint: (channel) => {
        const key = readKey(channel);
        if (!key) return null;
        // 只显示前后几位，避免整串出现在列表里
        return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "已配置";
      },
      async send(channel, msg) {
        const key = readKey(channel);
        if (!key) return { ok: false, error: "SendKey 无法解密，请重新填写" };
        const title = msg.accountLabel ? `【${msg.accountLabel}】${msg.title}` : msg.title;
        const result = await sendImpl(key, title, msg.body, {
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        if (result.ok) return { ok: true };
        // 常见原因：SendKey 错误、超出发送限额
        return { ok: false, error: result.message };
      },
      async dispose() {
        /* 无需清理 */
      },
    };
  }

  /* ---------------- 微信适配器 ---------------- */

  private createWeChatAdapter(): NotifyAdapter {
    const repos = this.deps.repos;
    const log = this.deps.logger;
    const deps = this.deps; // 同上：对象字面量里不能用 this 访问服务成员
    /** channelId → 运行中的 bot */
    const bots = new Map<string, any>();
    const starting = new Set<string>();

    const credsDir = (id: string) => path.join(this.deps.dataDir, "wechat-creds", id);

    /** 停掉并移除某通道的 bot */
    const disposeBot = (channelId: string): void => {
      const bot = bots.get(channelId);
      bots.delete(channelId);
      if (!bot) return;
      try {
        bot.stop();
      } catch {
        /* 忽略 */
      }
    };

    const defaultBotFactory = async (opts: { storageDir: string; loginCallbacks: any; log: (m: string) => void }) => {
      const mod = (await import("@wechatbot/wechatbot")) as { WeChatBot: new (o: any) => any };
      return new mod.WeChatBot({
        storage: "file",
        storageDir: opts.storageDir,
        logLevel: "warn",
        loginCallbacks: opts.loginCallbacks,
      });
    };

    const setRuntime = (id: string, patch: Parameters<Repos["notify"]["setRuntime"]>[1]) => {
      try {
        repos.notify.setRuntime(id, patch);
      } catch {
        /* 状态回写失败不影响推送 */
      }
    };

    /** 启动（或复用）一个通道的 bot */
    const startBot = async (channel: NotifyRow): Promise<void> => {
      if (bots.has(channel.id) || starting.has(channel.id)) return;
      starting.add(channel.id);
      setRuntime(channel.id, { status: "starting", statusDetail: "正在登录微信…", lastError: null });

      const factory = deps.botFactory ?? defaultBotFactory;
      const loginCallbacks = {
        onQrUrl: (url: string) => {
          // 只存原始内容，前端自己渲染二维码（登录串不离开本机）
          setRuntime(channel.id, { status: "qrcode", qrText: String(url), statusDetail: "请用微信扫码" });
          log.info("推送", `[${channel.label}] 二维码已生成，请用微信扫码`, { userId: channel.user_id });
        },
        onScanned: () => {
          setRuntime(channel.id, { status: "scanned", qrText: null, statusDetail: "已扫码，请在手机上确认" });
        },
        onExpired: () => {
          setRuntime(channel.id, { statusDetail: "二维码已过期，正在重新获取" });
        },
      };

      try {
        const bot = await factory({
          storageDir: credsDir(channel.id),
          loginCallbacks,
          log: (m: string) => log.info("推送", `[${channel.label}] ${m}`),
        });

        bot.onMessage(async (msg: any) => {
          const userId = String(msg?.userId ?? "");
          if (!userId) return;
          const text = String(msg?.text ?? "").trim();
          const live = repos.notify.findById(channel.id);
          if (!live) return;

          // 第一次收到消息的人成为绑定目标（与桌面端行为一致）
          if (!live.target_id || live.target_id !== userId) {
            repos.notify.setRuntime(channel.id, {
              targetId: userId,
              targetLabel: text.slice(0, 40) || null,
              status: "bound",
              statusDetail: null,
              lastError: null,
            });
            log.info("推送", `[${live.label}] 已绑定接收人 ${userId}`, { userId: live.user_id });
            try {
              await bot.reply(msg, `已绑定「${live.label}」，之后收益日报会推送到这里。\n发「帮助」查看可用命令。`);
            } catch {
              /* 回复失败不影响绑定 */
            }
            return;
          }

          // 已绑定的接收人：交给命令处理器
          try {
            const answer = this.deps.onCommand
              ? await this.deps.onCommand(live.user_id, text)
              : null;
            await bot.reply(msg, answer ?? "收到。发「帮助」看看我能做什么。");
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            log.warn("推送", `[${live.label}] 命令处理失败：${m}`);
            try {
              await bot.reply(msg, `命令执行失败：${m}`);
            } catch {
              /* 忽略 */
            }
          }
        });

        // run() 会自动复用已保存的凭证；没有凭证时走扫码
        await bot.run({ callbacks: loginCallbacks });

        const live = repos.notify.findById(channel.id);
        if (!live) {
          try {
            bot.stop();
          } catch {
            /* 忽略 */
          }
          return;
        }
        bots.set(channel.id, bot);
        setRuntime(channel.id, {
          status: live.target_id ? "bound" : "online",
          qrText: null,
          statusDetail: live.target_id ? null : "已登录，请用微信给机器人发一条消息完成绑定",
          lastError: null,
        });
        log.info(
          "推送",
          `[${live.label}] 微信已登录${live.target_id ? `，接收人 ${live.target_id}` : "，等待绑定接收人"}`,
          { userId: live.user_id },
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        bots.delete(channel.id);
        setRuntime(channel.id, { status: "error", lastError: m, qrText: null });
        log.warn("推送", `[${channel.label}] 微信登录失败：${m}`, { userId: channel.user_id });
      } finally {
        starting.delete(channel.id);
      }
    };

    return {
      kind: "wechat",
      async init(channel) {
        if (!channel.enabled) return;
        await startBot(channel);
      },
      isUsable: (channel) => {
        // 已登录 + 已绑定接收人 才算可用
        const hasBot = bots.has(channel.id);
        const hasCreds = fs.existsSync(path.join(credsDir(channel.id), "credentials.json"));
        return Boolean(channel.target_id) && (hasBot || hasCreds);
      },
      configHint: (channel) => {
        if (!fs.existsSync(credsDir(channel.id))) return null;
        return channel.target_id ? `已绑定 ${channel.target_id}` : "已登录，未绑定";
      },
      async send(channel, msg) {
        const bot = bots.get(channel.id);
        if (!bot) return { ok: false, error: "微信未登录（请先在推送设置里扫码登录）" };
        if (!channel.target_id) return { ok: false, error: "还没绑定接收人：请用微信给机器人发一条消息" };
        try {
          await bot.send(channel.target_id, { text: msg.body });
          return { ok: true };
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          return { ok: false, error: m };
        }
      },
      async action(channel, name) {
        if (name === "login") {
          // 强制重新登录：先停旧的再起新的
          disposeBot(channel.id);
          repos.notify.setRuntime(channel.id, { status: "idle", qrText: null, lastError: null, statusDetail: null });
          await startBot(channel);
          return;
        }
        if (name === "unbind") {
          repos.notify.setRuntime(channel.id, { targetId: null, targetLabel: null, statusDetail: "已解绑，请重新给机器人发一条消息" });
          return;
        }
        if (name === "retry") {
          disposeBot(channel.id);
          await startBot({ ...channel, status: "idle" });
          return;
        }
        throw new HttpError(400, "UNKNOWN_ACTION", `不支持的微信操作：${name}`);
      },
      async dispose(channelId) {
        disposeBot(channelId);
      },
    };
  }

  /** 内部：停掉并移除某通道的 bot */
  private async disposeChannel(bots: Map<string, any>, channelId: string): Promise<void> {
    const bot = bots.get(channelId);
    bots.delete(channelId);
    if (!bot) return;
    try {
      bot.stop();
    } catch {
      /* 忽略 */
    }
  }

  /* ---------------- 对外 API ---------------- */

  /** 服务启动时恢复所有已启用的通道 */
  async restoreAll(): Promise<void> {
    for (const kind of this.adapters.keys()) {
      for (const channel of this.deps.repos.notify.listEnabledByKind(kind)) {
        const adapter = this.adapters.get(kind);
        if (!adapter?.isUsable(channel)) continue;
        try {
          await adapter.init(channel);
        } catch (err) {
          this.deps.logger.warn(
            "推送",
            `恢复通道「${channel.label}」失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  private adapterOf(kind: NotifyKind): NotifyAdapter {
    const a = this.adapters.get(kind);
    if (!a) throw new HttpError(400, "UNKNOWN_KIND", `不支持的推送类型：${kind}`);
    return a;
  }

  toView(channel: NotifyRow): NotifyChannelView {
    const adapter = this.adapters.get(channel.kind);
    const usable = adapter ? adapter.isUsable(channel) : false;
    return {
      id: channel.id,
      kind: channel.kind,
      label: channel.label,
      enabled: Number(channel.enabled) === 1,
      usable,
      status: channel.status,
      statusDetail: channel.status_detail,
      target: channel.target_id ? { id: channel.target_id, label: channel.target_label } : null,
      qrText: channel.qr_text,
      sentCount: Number(channel.sent_count),
      lastSentAt: channel.last_sent_at == null ? null : Number(channel.last_sent_at),
      lastError: channel.last_error,
      createdAt: Number(channel.created_at),
      configHint: adapter?.configHint(channel) ?? null,
    };
  }

  listForUser(userId: string): NotifyChannelView[] {
    return this.deps.repos.notify.listForUser(userId).map((c) => this.toView(c));
  }

  getForUser(id: string, userId: string): NotifyChannelView {
    const row = this.deps.repos.notify.findOwned(id, userId);
    if (!row) throw new HttpError(404, "CHANNEL_NOT_FOUND", "推送通道不存在");
    return this.toView(row);
  }

  /** 该用户是否有可用通道（日报据此决定可不可配） */
  hasUsableChannel(userId: string): boolean {
    for (const row of this.deps.repos.notify.listForUser(userId)) {
      if (Number(row.enabled) !== 1) continue;
      const adapter = this.adapters.get(row.kind);
      if (adapter?.isUsable(row)) return true;
    }
    return false;
  }

  /** 创建通道。Server酱需要 sendkey；微信只需要 label */
  async create(
    userId: string,
    input: { kind: NotifyKind; label?: string; sendkey?: string },
  ): Promise<NotifyChannelView> {
    const kind = input.kind;
    if (kind !== "serverchan" && kind !== "wechat") {
      throw new HttpError(400, "UNKNOWN_KIND", "推送类型只支持 serverchan / wechat");
    }
    if (this.deps.repos.notify.countByUser(userId) >= 10) {
      throw new HttpError(400, "TOO_MANY_CHANNELS", "推送通路上限为 10 个");
    }

    let configEnc: string | null = null;
    if (kind === "serverchan") {
      const key = String(input.sendkey ?? "").trim();
      if (!key) throw new HttpError(400, "SENDKEY_REQUIRED", "请填写 Server酱 的 SendKey");
      // 存之前先验一次，避免存一个永远发不出去的 key
      const probe = await this.sendServerChanImpl(key, "Reelax 推送连通性测试", "如果你收到这条消息，说明配置正确。", {
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
      if (!probe.ok) {
        throw new HttpError(400, "SENDKEY_INVALID", `SendKey 校验失败：${probe.message}`);
      }
      configEnc = this.deps.vault.seal(key, userId, "notify_secret");
    }

    const row = this.deps.repos.notify.create({
      userId,
      kind,
      label: input.label?.trim() || (kind === "serverchan" ? "Server酱" : "微信机器人"),
      configEnc,
    });

    if (kind === "wechat") {
      // 微信需要异步扫码登录，交给适配器启动
      void this.adapterOf("wechat").init(row).catch(() => {});
    }

    return this.toView(row);
  }

  update(
    id: string,
    userId: string,
    patch: { label?: string; enabled?: boolean },
  ): NotifyChannelView {
    const row = this.deps.repos.notify.update(id, userId, {
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    if (!row) throw new HttpError(404, "CHANNEL_NOT_FOUND", "推送通道不存在");

    // 启用时尝试拉起、停用时释放
    const adapter = this.adapterOf(row.kind);
    if (patch.enabled === true) {
      void adapter.init(row).catch(() => {});
    } else if (patch.enabled === false) {
      void adapter.dispose(row.id).catch(() => {});
    }
    return this.toView(row);
  }

  async remove(id: string, userId: string): Promise<void> {
    const row = this.deps.repos.notify.findOwned(id, userId);
    if (!row) throw new HttpError(404, "CHANNEL_NOT_FOUND", "推送通道不存在");
    await this.adapterOf(row.kind).dispose(id).catch(() => {});
    this.deps.repos.notify.delete(id, userId);
  }

  /** 通道特有动作（微信：login / unbind / retry） */
  async action(id: string, userId: string, name: string): Promise<NotifyChannelView> {
    const row = this.deps.repos.notify.findOwned(id, userId);
    if (!row) throw new HttpError(404, "CHANNEL_NOT_FOUND", "推送通道不存在");
    const adapter = this.adapterOf(row.kind);
    if (!adapter.action) throw new HttpError(400, "NO_ACTIONS", "该通道没有可执行的操作");
    await adapter.action(row, name);
    return this.getForUser(id, userId);
  }

  /** 发一条测试消息 */
  async test(id: string, userId: string): Promise<{ ok: boolean; error?: string }> {
    const row = this.deps.repos.notify.findOwned(id, userId);
    if (!row) throw new HttpError(404, "CHANNEL_NOT_FOUND", "推送通道不存在");
    const result = await this.sendToChannel(row, {
      title: "推送测试",
      body: `这是一条测试消息（${new Date().toLocaleString("zh-CN")}）。\n收到即说明「${row.label}」配置正确。`,
    });
    return result;
  }

  /** 发送到一个具体通道并记录结果 */
  private async sendToChannel(channel: NotifyRow, msg: NotifyMessage): Promise<SendResult> {
    const adapter = this.adapterOf(channel.kind);
    try {
      const result = await adapter.send(channel, msg);
      if (result.ok) {
        this.deps.repos.notify.recordSent(channel.id);
        this.deps.repos.notify.setRuntime(channel.id, { lastError: null });
      } else {
        this.deps.repos.notify.setRuntime(channel.id, { lastError: result.error ?? "发送失败" });
      }
      return result;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.deps.repos.notify.setRuntime(channel.id, { lastError: m });
      return { ok: false, error: m };
    }
  }

  /**
   * 广播给某用户的全部可用通道。
   * 返回成功数；没有任何通道时返回 0（调用方自己决定要不要提示）。
   */
  async sendToUser(userId: string, msg: NotifyMessage): Promise<{ sent: number; failed: number; errors: string[] }> {
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const row of this.deps.repos.notify.listForUser(userId)) {
      if (Number(row.enabled) !== 1) continue;
      const adapter = this.adapters.get(row.kind);
      if (!adapter?.isUsable(row)) continue;

      const result = await this.sendToChannel(row, msg);
      if (result.ok) sent++;
      else {
        failed++;
        errors.push(`[${row.label}] ${result.error ?? "发送失败"}`);
      }
    }
    return { sent, failed, errors };
  }

  /** 关闭全部通道（服务优雅关闭时调用） */
  async disposeAll(): Promise<void> {
    for (const row of this.deps.repos.notify.listAll()) {
      await this.adapters.get(row.kind)?.dispose(row.id).catch(() => {});
    }
  }
}

export type { NotifyRow };

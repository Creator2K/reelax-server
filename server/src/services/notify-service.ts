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
import { randomInt } from "node:crypto";
import type { Repos } from "../db/repositories/index.ts";
import type { NotifyKind, NotifyRow, NotifyStatus } from "../db/repositories/notify.ts";
import type { CredentialVault } from "../security/vault.ts";
import type { Logger } from "../lib/logger.ts";
import { HttpError } from "../api/server.ts";

/** 简单等待（重连退避用） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 给一个 Promise 套超时。
 *
 * ★ 为什么必须要有：微信 SDK 内部的 HTTP 请求**没有超时**。实测出现过
 *   bot.run() 一直不返回，通道就永远卡在「正在连接…」——
 *   界面转圈、用户干等，而且 our 的重试逻辑根本没机会执行。
 *   宁可超时失败再重试，也不要无限等待。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒未响应）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 登录/连接阶段的超时（扫码等待不算在内，那是 onQrUrl 回调） */
const CONNECT_TIMEOUT_MS = 60_000;

/**
 * 进程内每个通道自动恢复的尝试次数上限。
 *
 * 为什么需要：状态是 error 时不该无限重连（会刷日志），但也不能"一次失败就
 * 永久等用户手动点"—— 那样一次网络抖动之后，重启也不会再试，用户以为坏了。
 * 折中：每次进程启动最多自动试这么多次，用尽后等用户点「重新连接」。
 */
const MAX_AUTO_RECOVER = 3;

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
  /** 微信：正在等用户回发验证码 */
  awaitingVerify: boolean;
  /** 微信：验证码还有多久过期（毫秒） */
  verifyExpiresInMs: number | null;
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
    /** 自动恢复尝试计数（见 shouldInit） */
    const autoRecoverCount = new Map<string, number>();

    const credsDir = (id: string) => path.join(this.deps.dataDir, "wechat-creds", id);

    /** 停掉并移除某通道的 bot（重连/重新扫码/解绑都走这里） */
    const disposeBot2 = (channelId: string): void => {
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

    const factory = deps.botFactory ?? defaultBotFactory;

    /** 已保存凭证的文件（决定能否"自己连回来"） */
    const hasCredentials = (id: string) => fs.existsSync(path.join(credsDir(id), "credentials.json"));

    /** 生成一次性的登录回调集合（每个通道绑自己的 id） */
    const callbacksFor = (id: string, label: string, userId: string) => ({
      onQrUrl: (url: string) => {
        // 只存原始内容，前端自己渲染二维码（登录串不离开本机）
        setRuntime(id, { status: "qrcode", qrText: String(url), statusDetail: "请用微信扫码" });
        log.info("推送", `[${label}] 二维码已生成，请用微信扫码`, { userId });
      },
      onScanned: () => {
        setRuntime(id, { status: "scanned", qrText: null, statusDetail: "已扫码，请在手机上确认" });
      },
      onExpired: () => {
        setRuntime(id, { statusDetail: "二维码已过期，正在重新获取" });
      },
    });

    /** 处理一条来自微信的消息：命令、验证码、或新会话 */
    const handleMessage = async (bot: any, ch: NotifyRow, msg: any) => {
      const userId = String(msg?.userId ?? "");
      if (!userId) return;
      const text = String(msg?.text ?? "").trim();
      const live = repos.notify.findById(ch.id);
      if (!live) return;

      /* ---------- 已绑定的接收人：当命令处理 ---------- */
      if (live.target_id && live.target_id === userId) {
        try {
          const answer = this.deps.onCommand ? await this.deps.onCommand(live.user_id, text) : null;
          await bot.reply(msg, answer ?? "收到。发「帮助」看看我能做什么。");
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          log.warn("推送", `[${live.label}] 命令处理失败：${m}`);
          await bot.reply(msg, `命令执行失败：${m}`).catch(() => {});
        }
        return;
      }

      /* ---------- 正在等验证码 ---------- */
      const waiting = live.verify_code;
      const valid = waiting && (live.verify_expires_at ?? 0) > Date.now();
      if (waiting && valid) {
        // 只认发起验证的那个会话，避免别人碰巧发对数字
        if (live.pending_target_id && live.pending_target_id !== userId) {
          await bot.reply(msg, "这个验证码不是发给你的。").catch(() => {});
          return;
        }
        if (live.verify_attempts >= 5) {
          repos.notify.clearVerification(ch.id, "验证码尝试次数过多，请重新发一条消息获取新验证码");
          await bot.reply(msg, "尝试次数过多，请重新发送任意消息获取新的验证码。").catch(() => {});
          return;
        }
        if (text.replace(/\s+/g, "") === waiting) {
          repos.notify.completeVerification(ch.id, userId, String(msg?.senderName ?? "").slice(0, 40) || null);
          log.info("推送", `[${live.label}] 验证码正确，已绑定接收人 ${userId}`, { userId: live.user_id });
          await bot
            .reply(msg, `验证成功，已绑定「${live.label}」。\n之后收益日报会推送到这里。\n发「帮助」查看可用命令。`)
            .catch(() => {});
          return;
        }
        repos.notify.bumpVerifyAttempts(ch.id);
        const left = Math.max(0, 4 - live.verify_attempts);
        await bot.reply(msg, `验证码不对，还可以再试 ${left} 次。`).catch(() => {});
        return;
      }

      /* ---------- 新会话（或验证码过期）：生成新验证码 ---------- */
      const code = randomInt(100000, 1000000).toString();
      repos.notify.startVerification(ch.id, {
        code,
        pendingTargetId: userId,
        expiresAt: Date.now() + 10 * 60_000,
        hint: "请把收到的验证码发回给机器人以完成绑定",
      });
      log.info("推送", `[${live.label}] 收到新会话消息，已下发绑定验证码（10 分钟内有效）`, {
        userId: live.user_id,
      });
      await bot
        .reply(
          msg,
          `你的绑定验证码是：${code}\n\n` +
            `请在 10 分钟内把这 6 位数字发回来完成绑定。\n` +
            `（这一步用于确认这个微信是你本人的，避免别人误绑定）`,
        )
        .catch(() => {});
    };

    /**
     * 启动 bot 并在必要时重试。
     *
     * ★ 为什么要重试、为什么失败必须写状态：
     *   早期实现只试一次，一次网络抖动（实测出现过 "The operation was aborted
     *   due to timeout"）就让实例没建起来，而数据库里仍是"已绑定" ——
     *   界面于是自相矛盾：显示「可用」，一发消息却报「微信未登录」。
     *   有已保存凭证的通道必须能自己缓过来，且失败要如实反映到状态上。
     */
    const startBot = async (ch: NotifyRow, opts: { attempts?: number; force?: boolean } = {}): Promise<boolean> => {
      if (starting.has(ch.id)) return false;
      if (bots.has(ch.id) && !opts.force) return true;
      starting.add(ch.id);

      const maxAttempts = opts.attempts ?? 3;
      const credsExist = hasCredentials(ch.id);
      setRuntime(ch.id, {
        status: "starting",
        statusDetail: credsExist ? "正在用已保存的登录状态连接…" : "正在登录微信…",
        lastError: null,
      });

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let bot: any = null;
        try {
          bot = await withTimeout(
            factory({
              storageDir: credsDir(ch.id),
              loginCallbacks: callbacksFor(ch.id, ch.label, ch.user_id),
              log: (m: string) => log.info("推送", `[${ch.label}] ${m}`),
            }),
            15_000,
            "创建微信客户端",
          );

          bot.onMessage((msg: any) => void handleMessage(bot, ch, msg));

          /*
           * ★ 分两步调用，且**不能 await start()**。
           *
           * 看 SDK 实现：start() 内部是
           *     this.runPromise = this.poller.start(...); await this.runPromise;
           * 它要一直 await 到 stop() 才返回 —— 也就是说 start() **就是那个长轮询循环本身**，
           * 正常情况下永远不会 resolve。
           *
           * 之前把 start() 包进 withTimeout 是错的：15 秒后必然报"启动超时"，
           * 于是通道永远连不上（实测 3 次重试全是这个错）。
           *
           * 正确做法：login() 是"连接并校验凭证"（要等，且有超时）；
           *          start() 只是把轮询跑起来，所以不 await，改为轮询后用
           *          isRunning 确认它真的起来了。
           */
          await withTimeout(bot.login({ callbacks: callbacksFor(ch.id, ch.label, ch.user_id) }), CONNECT_TIMEOUT_MS, "连接微信");

          // 不 await：start() 会一直跑到 stop()。错误在这里单独捕获，避免变成未处理的 rejection。
          void Promise.resolve(bot.start()).catch((err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            log.warn("推送", `[${ch.label}] 微信轮询中断：${m}`, { userId: ch.user_id });
            // 轮询中断说明实例已不可用：清掉它，下次发送或重连会重建
            if (bots.get(ch.id) === bot) bots.delete(ch.id);
            setRuntime(ch.id, { status: "error", statusDetail: "与微信的连接中断，可点「重新连接」", lastError: `轮询中断：${m}` });
          });

          // 给轮询一点启动时间，然后确认它真的在跑
          await sleep(1500);
          if (bot.isRunning === false) {
            throw new Error("微信轮询未能启动（isRunning=false）");
          }

          const live = repos.notify.findById(ch.id);
          if (!live) {
            // 启动期间通道被删了
            try {
              bot.stop();
            } catch {
              /* 忽略 */
            }
            starting.delete(ch.id);
            return false;
          }

          bots.set(ch.id, bot);
          setRuntime(ch.id, {
            status: live.target_id ? "bound" : "online",
            qrText: null,
            statusDetail: live.target_id ? null : "已登录。请用微信给机器人发一条消息，按提示完成绑定",
            lastError: null,
          });
          log.info(
            "推送",
            `[${ch.label}] 微信已连接${live.target_id ? "，接收人已绑定" : "（等待绑定接收人）"}` +
              (attempt > 1 ? `（第 ${attempt} 次尝试成功）` : ""),
            { userId: live.user_id },
          );
          starting.delete(ch.id);
          return true;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          const isLast = attempt === maxAttempts;

          // 失败要把半成品客户端关掉，否则它的轮询可能还在后台跑
          if (bot) {
            try {
              bot.stop();
            } catch {
              /* 忽略 */
            }
          }

          // ★ 失败必须落到状态里，不能出现「显示可用但发不出去」
          setRuntime(ch.id, {
            status: isLast ? "error" : "starting",
            statusDetail: isLast
              ? credsExist
                ? "连接微信失败，可点「重新连接」重试"
                : "登录失败，请点「重新扫码登录」"
              : `连接失败，正在重试（${attempt}/${maxAttempts}）…`,
            lastError: `微信连接失败：${m}`,
            qrText: null,
          });
          log.warn("推送", `[${ch.label}] 微信连接失败（第 ${attempt}/${maxAttempts} 次）：${m}`, {
            userId: ch.user_id,
          });

          if (!isLast) await sleep(1500 * attempt);
        }
      }

      starting.delete(ch.id);
      return false;
    };

    /**
     * 该通道是否需要/能够被拉起。
     *
     * ★ 注意这里**不能**用 isUsable 判断：isUsable 要求「已登录 + 已绑定」，
     *   而「还没绑定的微信通道」正是最需要拉起来（才可能收到用户消息去绑定）的状态。
     *   早期实现用 isUsable 过滤 restoreAll，导致重启后未绑定的微信通道
     *   永远不再尝试登录，界面卡在「未登录」。
     *
     * 规则：
     *  · 有已保存登录凭证 → 应该拉起（能自己连回来）
     *  · 没有凭证但状态是"等待扫码"（qrcode/starting/scanned/idle）→ 也该拉起（继续扫码流程）
     *  · 已经明确失败（error）→ 不自动拉起，等用户点「重新连接」，避免无限重试
     */
    const shouldInit = (channel: NotifyRow): boolean => {
      if (!channel.enabled) return false;
      if (channel.status === "error") {
        // 失败过的通道：本次进程内最多再自动试几次；用尽后交给用户手动重连
        const tried = autoRecoverCount.get(channel.id) ?? 0;
        if (tried >= MAX_AUTO_RECOVER) return false;
        autoRecoverCount.set(channel.id, tried + 1);
      }
      return true;
    };

    return {
      kind: "wechat",
      async init(channel) {
        if (!shouldInit(channel)) return;
        await startBot(channel);
      },
      isUsable: (channel) => {
        // 已登录（实例还在，或凭证还在、随时能自己连回来）+ 已绑定接收人 才算可用
        const hasBot = bots.has(channel.id);
        const hasCreds = hasCredentials(channel.id);
        return Boolean(channel.target_id) && (hasBot || hasCreds);
      },
      configHint: (channel) => {
        if (!fs.existsSync(credsDir(channel.id))) return null;
        if (channel.target_id) return `已绑定 ${channel.target_id}`;
        if (channel.verify_code != null) return "等待验证码";
        return "已登录，未绑定";
      },
      async send(channel, msg) {
        if (!channel.target_id) {
          return {
            ok: false,
            error:
              channel.verify_code != null
                ? "还没完成绑定：请把机器人回复的 6 位验证码发回给它"
                : "还没绑定接收人：请用微信给机器人发一条消息，按提示完成绑定",
          };
        }

        // 实例不在（进程重启过、或上次连接失败）→ 用已保存凭证现场拉一次，
        // 而不是直接报「未登录」把问题丢给用户
        let bot = bots.get(channel.id);
        if (!bot) {
          if (!hasCredentials(channel.id)) {
            return { ok: false, error: "微信登录状态已失效，请在推送设置里点「重新扫码登录」" };
          }
          const ok = await startBot(channel, { attempts: 2 });
          bot = bots.get(channel.id);
          if (!ok || !bot) {
            const live = repos.notify.findById(channel.id);
            return { ok: false, error: live?.last_error ?? "微信连接失败，请稍后重试或点「重新连接」" };
          }
        }

        try {
          await bot.send(channel.target_id, { text: msg.body });
          return { ok: true };
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          // 发送失败可能是实例已经掉了：停掉它，下次会自动重建
          if (/not\s*login|未登录|unauthor|401|token/i.test(m)) {
            disposeBot2(channel.id);
          }
          return { ok: false, error: `发送失败：${m}` };
        }
      },
      async action(channel, name) {
        if (name === "login") {
          // 强制重新扫码：清掉旧 bot 与验证状态
          disposeBot2(channel.id);
          repos.notify.clearVerification(channel.id, null);
          repos.notify.setRuntime(channel.id, {
            status: "idle",
            qrText: null,
            lastError: null,
            statusDetail: null,
          });
          await startBot(channel, { force: true, attempts: 1 });
          return;
        }
        if (name === "reconnect" || name === "retry") {
          // 用已保存凭证重连（不重新扫码）
          disposeBot2(channel.id);
          await startBot(channel, { force: true });
          return;
        }
        if (name === "unbind") {
          // 解绑同时清掉验证码，避免残留的验证码把旧会话再绑回来
          repos.notify.clearVerification(channel.id, "已解绑。请用微信给机器人发一条消息，按提示重新绑定");
          repos.notify.setRuntime(channel.id, { targetId: null, targetLabel: null });
          return;
        }
        throw new HttpError(400, "UNKNOWN_ACTION", `不支持的微信操作：${name}`);
      },
      async dispose(channelId) {
        disposeBot2(channelId);
      },
    };
  }

  /* ---------------- 对外 API ---------------- */

  /** 服务启动时恢复所有已启用的通道 */
  async restoreAll(): Promise<void> {
    for (const kind of this.adapters.keys()) {
      for (const channel of this.deps.repos.notify.listEnabledByKind(kind)) {
        const adapter = this.adapters.get(kind);
        if (!adapter) continue;
        // 交给适配器自己判断「该不该拉起」——
        // 不要在这里用 isUsable 过滤：未绑定的微信通道正是需要拉起的
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
      // 验证码状态：前端要显示「等待验证码」并给出倒计时
      awaitingVerify: channel.verify_code != null && (channel.verify_expires_at ?? 0) > Date.now(),
      verifyExpiresInMs:
        channel.verify_code != null && channel.verify_expires_at != null
          ? Math.max(0, Number(channel.verify_expires_at) - Date.now())
          : null,
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

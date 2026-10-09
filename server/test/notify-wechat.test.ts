// 微信通道：连接失败处理 + 验证码绑定
//
// 这组测试盯的是两个真实出过问题的点：
//  1) 启动 bot 时一次网络抖动就把通道留在失败态，而数据库里仍写"已绑定" ——
//     界面显示「可用」，一发消息却报「微信未登录」。现在要求：重试、且失败必须写状态。
//  2) 任何人给机器人发消息就会成为接收人 —— 陌生人误发一条就能把推送收走。
//     现在要求：先下发 6 位验证码，用户把码发回来才算绑定。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db/client.ts";
import { createRepos, type Repos } from "../src/db/repositories/index.ts";
import { CredentialVault } from "../src/security/vault.ts";
import { Logger } from "../src/lib/logger.ts";
import { NotifyService } from "../src/services/notify-service.ts";

const logger = new Logger({ limit: 200, minLevel: "error" });

type FakeBot = {
  sent: { to: string; text: string }[];
  replied: { text: string }[];
  handlers: ((msg: unknown) => void)[];
  send: (to: string, content: unknown) => Promise<void>;
  reply: (msg: unknown, content: unknown) => Promise<void>;
  onMessage: (fn: (msg: unknown) => void) => void;
  /** 服务现在是分两步调用 login() + start()（而不是 run()），好给连接阶段单独加超时 */
  login: (opts?: unknown) => Promise<void>;
  /** start() 是长轮询循环：会一直跑到 stop()，所以服务不 await 它 */
  start: () => Promise<void>;
  isRunning: boolean;
  run: (opts?: unknown) => Promise<void>;
  stop: () => void;
};

function makeHarness(opts: { failRuns?: number; failMode?: "login" | "start" } = {}) {
  const db = openDb(":memory:");
  db.migrate();
  const repos: Repos = createRepos(db);
  const vault = new CredentialVault(Buffer.alloc(32, 7), logger);
  const dataDir = mkdtempSync(path.join(tmpdir(), "reelax-notify-"));

  const bots: FakeBot[] = [];
  let runAttempts = 0;
  /** start() 挂起的 resolver：stop() 时放行，模拟真实 SDK 的长轮询 */
  const stopResolvers: (() => void)[] = [];

  const botFactory = async () => {
    const bot: FakeBot = {
      sent: [],
      replied: [],
      handlers: [],
      async send(to, content) {
        bot.sent.push({ to, text: String((content as { text?: string })?.text ?? content) });
      },
      async reply(_msg, content) {
        bot.replied.push({ text: String((content as { text?: string })?.text ?? content) });
      },
      onMessage(fn) {
        bot.handlers.push(fn);
      },
      // 服务把 run() 拆成了 login() + start()，好给连接阶段单独加超时
      async login() {
        runAttempts++;
        const shouldFail = opts.failRuns && runAttempts <= opts.failRuns;
        if (shouldFail && (opts.failMode ?? "login") === "login") {
          throw new Error("The operation was aborted due to timeout");
        }
      },
      // 真实 SDK 里 start() 是长轮询：一直 await 到 stop()，所以这里也返回一个不 resolve 的 Promise
      start() {
        // 立刻置为在跑（真实 SDK 的 isRunning 也是 poller 启动后即为 true）
        bot.isRunning = true;
        return new Promise<void>((resolve) => {
          stopResolvers.push(resolve);
        });
      },
      async run() {
        await bot.login();
        void bot.start();
      },
      stop() {
        bot.isRunning = false;
        // 让挂起的 start() 结束，模拟真实 SDK 的 stop() 行为
        for (const r of stopResolvers.splice(0)) r();
      },
      isRunning: false,
    };
    bots.push(bot);
    return bot;
  };

  const notify = new NotifyService({
    repos,
    vault,
    logger,
    dataDir,
    botFactory: botFactory as never,
  });

  return { db, repos, notify, bots, dataDir, runAttemptsOf: () => runAttempts };
}

/** 造一个微信通道（模拟已扫码登录：写入一个假凭证文件） */
function seedWechat(repos: Repos, dataDir: string) {
  // notify_channels.user_id 有外键约束，必须先建用户
  const user =
    repos.users.findByEmail("owner@example.com") ??
    repos.users.create({
      email: "owner@example.com",
      passwordHash: "scrypt$N=1,r=1,p=1$AA$AA", // 测试不登录，占位即可
      displayName: "机主",
      role: "user",
      status: "approved",
      approvedBy: null,
    });

  const row = repos.notify.create({ userId: user.id, kind: "wechat", label: "微信机器人" });
  const dir = path.join(dataDir, "wechat-creds", row.id);
  // 凭证文件存在 => 服务认为「有已保存登录状态，能自己连回来」
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ token: "t", baseUrl: "https://x", accountId: "a", userId: "b", savedAt: new Date().toISOString() }),
  );
  const created = repos.notify.findById(row.id)!;
  return { channel: created, userId: user.id };
}

describe("微信通道 · 连接失败与重试", () => {
  it("★ start() 是长轮询（永不 resolve）时也必须连接成功", async () => {
    // 这是踩过的坑：start() 内部 await poller.start()，要一直跑到 stop() 才返回。
    // 早期把它包进超时并 await —— 15 秒后必然报"启动超时"，通道永远连不上。
    // 这条测试用一个永不 resolve 的 start() 守住它。
    const h = makeHarness();
    const { channel: ch } = seedWechat(h.repos, h.dataDir);

    const done = h.notify.restoreAll();
    // start() 永不返回，所以不能 await restoreAll 本身等到"全部结束"——
    // 给足够时间让它走完 login + 启动确认即可。
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);

    const after = h.repos.notify.findById(ch.id)!;
    expect(after.status).not.toBe("error");
    expect(after.status).toBe("online");
    expect(h.bots[0]!.isRunning).toBe(true);
  });

  it("★ 启动失败会重试，成功后状态是「已登录」（不再是自相矛盾的 bound）", async () => {
    const h = makeHarness({ failRuns: 1 });
    const { channel: ch } = seedWechat(h.repos, h.dataDir);

    // 第一次 run 会抛超时，第二次成功
    await h.notify.restoreAll();

    const after = h.repos.notify.findById(ch.id)!;
    expect(after.status).not.toBe("error");
    expect(after.last_error).toBeNull();
    // 没绑定接收人，所以是 online（已登录待绑定）
    expect(after.status).toBe("online");
  });

  it("★ 连续失败时必须把真实原因写进状态（不能显示可用却发不出去）", async () => {
    const h = makeHarness({ failRuns: 99 });
    const { channel: ch } = seedWechat(h.repos, h.dataDir);

    await h.notify.restoreAll();

    const after = h.repos.notify.findById(ch.id)!;
    expect(after.status).toBe("error");
    expect(after.last_error).toContain("timeout");
    expect(after.status_detail).toBeTruthy();
  });

  it("失败后 send 会现场重连，而不是直接报「微信未登录」", async () => {    const h = makeHarness({ failRuns: 1 });
    const { channel: ch, userId } = seedWechat(h.repos, h.dataDir);
    // 先绑定一个接收人（模拟历史数据）
    h.repos.notify.setRuntime(ch.id, { targetId: "user-1", status: "bound" });

    const result = await h.notify.test(ch.id, userId);
    expect(result.ok).toBe(true);
  });

  it("没有任何凭证时，send 明确要求重新扫码（而不是含糊地报未登录）", async () => {
    const h = makeHarness();
    const user = h.repos.users.create({
      email: "solo@example.com",
      // 测试不登录，口令哈希给个占位值即可
      passwordHash: "scrypt$N=1,r=1,p=1$AA$AA",
      displayName: "机主",
      role: "user",
      status: "approved",
      approvedBy: null,
    });
    const row = h.repos.notify.create({ userId: user.id, kind: "wechat", label: "微信机器人" });
    h.repos.notify.setRuntime(row.id, { targetId: "user-1", status: "bound" });

    const result = await h.notify.test(row.id, user.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("重新扫码");
  });
});

describe("微信通道 · 验证码绑定", () => {
  it("★ 陌生人发消息不会直接绑定，而是下发 6 位验证码", async () => {
    const h = makeHarness();
    const { channel: ch } = seedWechat(h.repos, h.dataDir);
    await h.notify.restoreAll();

    const bot = h.bots[h.bots.length - 1]!;
    expect(bot.handlers).toHaveLength(1);

    // 模拟一条来自陌生人的消息
    const msg = { userId: "stranger-1", text: "你好" };
    bot.handlers[0]!(msg);
    await new Promise((r) => setTimeout(r, 60));

    const after = h.repos.notify.findById(ch.id)!;
    // 没有直接绑定
    expect(after.target_id).toBeNull();
    // 但生成了 6 位验证码
    expect(after.verify_code).toMatch(/^\d{6}$/);
    expect(after.verify_expires_at).toBeGreaterThan(Date.now());
    // 回复里含验证码
    expect(bot.replied.at(-1)?.text).toContain(after.verify_code!);
  });

  it("★ 把验证码发回来才算绑定成功", async () => {
    const h = makeHarness();
    const { channel: ch } = seedWechat(h.repos, h.dataDir);
    await h.notify.restoreAll();
    const bot = h.bots[h.bots.length - 1]!;

    bot.handlers[0]!({ userId: "owner-1", text: "绑定" });
    await new Promise((r) => setTimeout(r, 60));
    const code = h.repos.notify.findById(ch.id)!.verify_code!;

    bot.handlers[0]!({ userId: "owner-1", text: code });
    await new Promise((r) => setTimeout(r, 60));

    const after = h.repos.notify.findById(ch.id)!;
    expect(after.target_id).toBe("owner-1");
    expect(after.status).toBe("bound");
    expect(after.verify_code).toBeNull();
    expect(bot.replied.at(-1)?.text).toContain("验证成功");
  });

  it("验证码错误会提示还能试几次，且不会绑定", async () => {
    const h = makeHarness();
    const { channel: ch } = seedWechat(h.repos, h.dataDir);
    await h.notify.restoreAll();
    const bot = h.bots[h.bots.length - 1]!;

    bot.handlers[0]!({ userId: "owner-2", text: "hi" });
    await new Promise((r) => setTimeout(r, 60));

    bot.handlers[0]!({ userId: "owner-2", text: "000000" });
    await new Promise((r) => setTimeout(r, 60));

    const after = h.repos.notify.findById(ch.id)!;
    expect(after.target_id).toBeNull();
    expect(after.verify_attempts).toBe(1);
    expect(bot.replied.at(-1)?.text).toContain("验证码不对");
  });

  it("★ 别人拿到验证码也用不了（只认发起验证的会话）", async () => {
    const h = makeHarness();
    const { channel: ch } = seedWechat(h.repos, h.dataDir);
    await h.notify.restoreAll();
    const bot = h.bots[h.bots.length - 1]!;

    bot.handlers[0]!({ userId: "owner-3", text: "绑定" });
    await new Promise((r) => setTimeout(r, 60));
    const code = h.repos.notify.findById(ch.id)!.verify_code!;

    // 另一个会话把正确的验证码发过来
    bot.handlers[0]!({ userId: "attacker-1", text: code });
    await new Promise((r) => setTimeout(r, 60));

    const after = h.repos.notify.findById(ch.id)!;
    expect(after.target_id).toBeNull();
    expect(bot.replied.at(-1)?.text).toContain("不是发给你的");
  });

  it("尝试次数用尽后要求重新获取验证码", async () => {
    const h = makeHarness();
    const { channel: ch } = seedWechat(h.repos, h.dataDir);
    await h.notify.restoreAll();
    const bot = h.bots[h.bots.length - 1]!;

    bot.handlers[0]!({ userId: "owner-4", text: "绑定" });
    await new Promise((r) => setTimeout(r, 60));

    for (let i = 0; i < 5; i++) {
      bot.handlers[0]!({ userId: "owner-4", text: "111111" });
      await new Promise((r) => setTimeout(r, 30));
    }
    bot.handlers[0]!({ userId: "owner-4", text: "222222" });
    await new Promise((r) => setTimeout(r, 60));

    const after = h.repos.notify.findById(ch.id)!;
    expect(after.target_id).toBeNull();
    expect(bot.replied.at(-1)?.text).toContain("尝试次数过多");
  });

  it("已绑定的接收人发消息走命令处理，不再要求验证码", async () => {
    const h = makeHarness();
    const { channel: ch } = seedWechat(h.repos, h.dataDir);
    await h.notify.restoreAll();
    const bot = h.bots[h.bots.length - 1]!;

    h.repos.notify.completeVerification(ch.id, "owner-5", "我");
    bot.handlers[0]!({ userId: "owner-5", text: "日报" });
    await new Promise((r) => setTimeout(r, 60));

    // 没配 onCommand 时给默认回复，且不会再生成验证码
    const after = h.repos.notify.findById(ch.id)!;
    expect(after.verify_code).toBeNull();
    expect(bot.replied.at(-1)?.text).toBeTruthy();
  });

  it("解绑会同时清掉验证码（避免残留验证码把旧会话绑回来）", async () => {
    const h = makeHarness();
    const { channel: ch, userId } = seedWechat(h.repos, h.dataDir);
    await h.notify.restoreAll();
    const bot = h.bots[h.bots.length - 1]!;

    bot.handlers[0]!({ userId: "owner-6", text: "绑定" });
    await new Promise((r) => setTimeout(r, 60));
    expect(h.repos.notify.findById(ch.id)!.verify_code).not.toBeNull();

    h.repos.notify.completeVerification(ch.id, "owner-6", null);
    await h.notify.action(ch.id, userId, "unbind");

    const after = h.repos.notify.findById(ch.id)!;
    expect(after.target_id).toBeNull();
    expect(after.verify_code).toBeNull();
  });
});

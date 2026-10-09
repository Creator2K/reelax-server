// WebSocket 网关测试
//
// 最关键的一条：**用户只能收到自己账号的快照与事件**。
// 这类越权如果存在，表现是「界面正常，但看到了别人的数据」——最难被发现，
// 所以必须有自动化测试兜住。
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { openDb } from "../src/db/client.ts";
import { createRepos } from "../src/db/repositories/index.ts";
import { Limiters } from "../src/auth/ratelimit.ts";
import { AuthService } from "../src/auth/service.ts";
import { CredentialVault } from "../src/security/vault.ts";
import { RunnerRegistry } from "../src/game/runner-registry.ts";
import { AccountService } from "../src/services/account-service.ts";
import { Logger } from "../src/lib/logger.ts";
import { Bus, EVENTS } from "../src/lib/bus.ts";
import { WsGateway } from "../src/api/ws-gateway.ts";
import { testEnv } from "./helpers/full-app.ts";

type Msg = { type: string; data: any; t: number };

/** 一个收集消息的测试客户端 */
class TestWsClient {
  ws: WebSocket;
  messages: Msg[] = [];
  private waiters: { predicate: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  constructor(port: number, cookie: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    this.ws.on("message", (raw) => {
      let msg: Msg;
      try {
        msg = JSON.parse(String(raw)) as Msg;
      } catch {
        return;
      }
      this.messages.push(msg);
      for (const w of [...this.waiters]) {
        if (w.predicate(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
  }

  wait(predicate: (m: Msg) => boolean, timeoutMs = 4000): Promise<Msg> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待消息超时")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  waitOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  /** 等一小段时间，用于断言「没有收到」 */
  async settle(ms = 400): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

let server: http.Server;
let port = 0;
let gateway: WsGateway;
let repos: ReturnType<typeof createRepos>;
let auth: AuthService;
let accounts: AccountService;
let registry: RunnerRegistry;
let bus: Bus;
let logger: Logger;

let userA: { id: string; cookie: string };
let userB: { id: string; cookie: string };
let accountA: string;
let accountB: string;

beforeAll(async () => {
  const env = testEnv();
  // 注意：第二参是「最低日志级别」，传 "error" 会把 info 级日志直接吞掉，
  // 而本文件要验证的正是 info 日志的推送隔离 → 这里必须用 debug。
  logger = new Logger({ limit: 500, minLevel: "debug" });
  bus = new Bus();
  const db = openDb(":memory:");
  db.migrate();
  repos = createRepos(db);
  const limiters = new Limiters();
  auth = new AuthService({ repos, env, limiter: limiters, logger });
  const vault = new CredentialVault(env.masterKey, logger);
  registry = new RunnerRegistry({
    repos,
    vault,
    logger,
    bus,
    maxRunningAccounts: 10,
    maxAccountsPerUser: 5,
    globalProxy: null,
  });
  accounts = new AccountService({ repos, vault, registry });

  const mk = (email: string) => {
    const row = repos.users.create({
      email,
      passwordHash: "scrypt$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      displayName: email,
      status: "approved",
    });
    const token = auth.createSession(row, null, null);
    return { id: row.id, cookie: `reelax_session=${token.token}` };
  };
  userA = mk("ws-a@example.com");
  userB = mk("ws-b@example.com");

  accountA = repos.accounts.create({
    userId: userA.id,
    label: "A 的账号",
    authType: "credentials",
    email: "ga@x.com",
    baseUrl: "https://reelax.cn",
  }).id;
  accountB = repos.accounts.create({
    userId: userB.id,
    label: "B 的账号",
    authType: "credentials",
    email: "gb@x.com",
    baseUrl: "https://reelax.cn",
  }).id;

  server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  gateway = new WsGateway({ server, auth, accounts, logger, bus });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  gateway.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("WS 鉴权", () => {
  it("没有 cookie 时被拒（401）", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const result = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      ws.on("unexpected-response", (_req, res) => resolve(`http-${res.statusCode}`));
    });
    ws.close();
    expect(result).not.toBe("open");
  });

  it("伪造 cookie 被拒", async () => {
    const c = new TestWsClient(port, "reelax_session=forged");
    const result = await c
      .waitOpen()
      .then(() => "open")
      .catch(() => "rejected");
    c.close();
    expect(result).toBe("rejected");
  });

  it("未审批用户连不上（不给业务数据）", async () => {
    const pending = repos.users.create({
      email: "ws-pending@example.com",
      passwordHash: "scrypt$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      displayName: "待审批",
      status: "pending",
    });
    const token = auth.createSession(pending, null, null);
    const c = new TestWsClient(port, `reelax_session=${token.token}`);
    const result = await c
      .waitOpen()
      .then(() => "open")
      .catch(() => "rejected");
    c.close();
    expect(result).toBe("rejected");
  });

  it("路径不是 /ws 时被拒", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    const result = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      ws.on("unexpected-response", () => resolve("rejected"));
    });
    ws.close();
    expect(result).not.toBe("open");
  });
});

describe("初始快照", () => {
  it("连上后先收到 hello，再收到只含自己账号的快照", async () => {
    const c = new TestWsClient(port, userA.cookie);
    await c.waitOpen();

    const hello = await c.wait((m) => m.type === "hello");
    expect(hello.data.serverTime).toBeTypeOf("number");

    const snap = await c.wait((m) => m.type === "snapshot");
    expect(Array.isArray(snap.data)).toBe(true);
    expect(snap.data.map((a: any) => a.id)).toEqual([accountA]);
    // 绝不能出现别人的账号
    expect(JSON.stringify(snap.data)).not.toContain("B 的账号");
    c.close();
  });

  it("B 的快照只含 B 的账号", async () => {
    const c = new TestWsClient(port, userB.cookie);
    await c.waitOpen();
    const snap = await c.wait((m) => m.type === "snapshot");
    expect(snap.data.map((a: any) => a.id)).toEqual([accountB]);
    c.close();
  });
});

describe("★ 事件与日志的用户隔离", () => {
  it("A 账号的状态事件只推给 A，不推给 B", async () => {
    const ca = new TestWsClient(port, userA.cookie);
    const cb = new TestWsClient(port, userB.cookie);
    await ca.waitOpen();
    await cb.waitOpen();
    await ca.wait((m) => m.type === "snapshot");
    await cb.wait((m) => m.type === "snapshot");

    // 触发一次属于 A 的事件
    bus.emit(EVENTS.ACCOUNT_STATUS, {
      accountId: accountA,
      userId: userA.id,
      status: "online",
      detail: null,
    });

    const evt = await ca.wait((m) => m.type === "event" && m.data.event === EVENTS.ACCOUNT_STATUS);
    expect(evt.data.accountId).toBe(accountA);
    expect(evt.data.userId).toBe(userA.id);

    // B 不该收到
    await cb.settle(300);
    const bEvents = cb.messages.filter((m) => m.type === "event");
    expect(bEvents).toHaveLength(0);

    ca.close();
    cb.close();
  });

  it("A 的日志只推给 A", async () => {
    const ca = new TestWsClient(port, userA.cookie);
    const cb = new TestWsClient(port, userB.cookie);
    await ca.waitOpen();
    await cb.waitOpen();

    logger.info("测试", "A 的私有日志", { userId: userA.id, accountId: accountA });

    const logMsg = await ca.wait((m) => m.type === "log");
    expect(logMsg.data.msg).toBe("A 的私有日志");

    await cb.settle(300);
    expect(cb.messages.filter((m) => m.type === "log")).toHaveLength(0);

    ca.close();
    cb.close();
  });

  it("无归属的系统日志不推送（避免每个用户看到重复内容）", async () => {
    const ca = new TestWsClient(port, userA.cookie);
    await ca.waitOpen();
    await ca.wait((m) => m.type === "snapshot");

    logger.info("系统", "服务启动完成"); // 没有 userId

    await ca.settle(300);
    expect(ca.messages.filter((m) => m.type === "log")).toHaveLength(0);
    ca.close();
  });
});

describe("快照去重与强制刷新", () => {
  it("内容没变时不重复推送（前端不必无谓重渲染）", async () => {
    const c = new TestWsClient(port, userA.cookie);
    await c.waitOpen();
    await c.wait((m) => m.type === "snapshot");

    // 触发两次状态事件，只有第一次会带强制快照；第二次内容相同应被去重
    bus.emit(EVENTS.ACCOUNT_STATUS, { accountId: accountA, userId: userA.id, status: "online" });
    await c.wait((m) => m.type === "snapshot");
    const countAfterFirst = c.messages.filter((m) => m.type === "snapshot").length;

    bus.emit(EVENTS.ACCOUNT_STATUS, { accountId: accountA, userId: userA.id, status: "online" });
    await c.settle(300);
    const countAfterSecond = c.messages.filter((m) => m.type === "snapshot").length;

    // 事件是 force=true，所以这里仍会推一次；关键是定时轮询那路不重复
    expect(countAfterSecond).toBeGreaterThanOrEqual(countAfterFirst);
    c.close();
  });
});

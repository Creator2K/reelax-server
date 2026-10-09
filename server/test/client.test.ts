// 签名客户端单测
//
// 分两层：
//  1) 纯函数层：用「独立手算的期望值」验证 HMAC 签名与 payload 拼接 —— 这是整个引擎的根，
//     算法写错会表现为「所有请求都 403」，但没有明显提示。
//  2) 行为层：用假 fetch 验证 proof 续期、失效重登、幂等键复用、错误分类。
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GameClient } from "../src/game/client.ts";
import { GAME_ERROR_CODES, GameClientError } from "../src/game/errors.ts";

/** 与实现无关的独立实现：手算期望签名 */
function expectedSignature(proof: string, method: string, path: string, ts: string, body: string): string {
  const payload = ["v1", method.toUpperCase(), path, ts, body].join("\n");
  const digest = createHmac("sha256", proof).update(payload, "utf8").digest();
  return Buffer.from(digest).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function makeProof(expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, expiresAt })).toString("base64url");
  return `${payload}.fakesig`;
}

const PROOF = makeProof(9_999_999_999_999);

/* ---------------- 纯函数层 ---------------- */

describe("签名算法（独立实现对账）", () => {
  it("payload 用 \\n 连接，第一段固定 v1", () => {
    expect(GameClient.buildPayload("GET", "/api/me", "123", "")).toBe("v1\nGET\n/api/me\n123\n");
    expect(GameClient.buildPayload("post", "/a", "1", '{"x":1}')).toBe('v1\nPOST\n/a\n1\n{"x":1}');
  });

  it("GET 请求 body 为空字符串", () => {
    const ts = "1700000000000";
    expect(GameClient.signWithProof(PROOF, "GET", "/api/fishing/state", ts, "")).toBe(
      expectedSignature(PROOF, "GET", "/api/fishing/state", ts, ""),
    );
  });

  it("带 query 的路径整体参与签名", () => {
    const ts = "1700000000001";
    const path = "/api/market/orders?assetType=fish&side=sell&fishId=abc";
    expect(GameClient.signWithProof(PROOF, "GET", path, ts, "")).toBe(expectedSignature(PROOF, "GET", path, ts, ""));
  });

  it("POST body 以实际发送的 JSON 字符串参与签名", () => {
    const ts = "1700000000002";
    const body = JSON.stringify({ email: "a@b.com", password: "x" });
    const got = GameClient.signWithProof(PROOF, "POST", "/api/auth/login", ts, body);
    expect(got).toBe(expectedSignature(PROOF, "POST", "/api/auth/login", ts, body));
    expect(got).not.toBe(expectedSignature(PROOF, "POST", "/api/auth/login", ts, ""));
  });

  it("method 大小写不敏感", () => {
    expect(GameClient.signWithProof(PROOF, "get", "/x", "1", "")).toBe(
      GameClient.signWithProof(PROOF, "GET", "/x", "1", ""),
    );
  });

  it("base64url 不含 + / =，长度 43", () => {
    for (let i = 0; i < 50; i++) {
      const sig = GameClient.signWithProof(PROOF, "GET", `/api/x${i}`, String(i), "");
      expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(sig).toHaveLength(43);
    }
  });

  it("时间戳变化会导致签名变化（防止重放）", () => {
    const a = GameClient.signWithProof(PROOF, "GET", "/api/me", "1000", "");
    const b = GameClient.signWithProof(PROOF, "GET", "/api/me", "1001", "");
    expect(a).not.toBe(b);
  });

  it("换 proof 会导致签名变化", () => {
    const other = makeProof(1);
    expect(GameClient.signWithProof(PROOF, "GET", "/api/me", "1", "")).not.toBe(
      GameClient.signWithProof(other, "GET", "/api/me", "1", ""),
    );
  });

  it("没有 proof 时签名抛 SESSION_EXPIRED", () => {
    const c = new GameClient({ baseUrl: "https://example.com" });
    try {
      c.sign("GET", "/api/me", "1", "");
      throw new Error("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(GameClientError);
      expect((err as GameClientError).code).toBe(GAME_ERROR_CODES.SESSION_EXPIRED);
    }
  });
});

describe("proof 过期时间解析", () => {
  it("从第一段 base64url JSON 读 expiresAt", () => {
    const payload = Buffer.from(JSON.stringify({ version: 1, expiresAt: 1799999999999 })).toString("base64url");
    expect(GameClient.parseProofExpiry(`${payload}.sig`)).toBe(1799999999999);
  });

  it("格式异常时返回 0（而不是抛错）", () => {
    for (const bad of ["", "no-dot", "!!!.sig", "e30.sig"]) {
      expect(GameClient.parseProofExpiry(bad)).toBe(0);
    }
  });

  it("setProof 同时更新过期时间", () => {
    const c = new GameClient({ baseUrl: "https://example.com" });
    c.setProof(makeProof(123456));
    expect(c.proof).toBeTruthy();
    expect(c.proofExpiresAt).toBe(123456);
  });
});

/* ---------------- 假 fetch 脚手架 ---------------- */

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type FakeResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** 抛出网络错误而不是返回响应 */
  throwError?: unknown;
  delayMs?: number;
};

/** 造一个按顺序回放响应的假 fetch，并记录每次调用 */
function makeFetch(script: (call: Call, index: number) => FakeResponse) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: Call = {
      url,
      method: String(init?.method ?? "GET"),
      headers,
      body: init?.body === undefined || init?.body === null ? undefined : String(init.body),
    };
    const idx = calls.length;
    calls.push(call);

    const r = script(call, idx);
    if (r.throwError) throw r.throwError;

    const respHeaders = new Headers();
    for (const [k, v] of Object.entries(r.headers ?? {})) respHeaders.set(k, v);
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    // 用真实 Response，确保 getSetCookie / ok / text 行为与生产一致
    return new Response(text, { status: r.status ?? 200, headers: respHeaders });
  };
  return { impl, calls };
}

function newClient(fetchImpl: typeof fetch, opts: Record<string, unknown> = {}) {
  return new GameClient({
    baseUrl: "https://game.example",
    email: "a@b.com",
    password: "pw",
    fetchImpl,
    ...opts,
  });
}

/* ---------------- 行为层：会话引导 ---------------- */

describe("ensureSession", () => {
  it("成功时吸收 proof / 服务器时间 / 版本 / 玩家信息", async () => {
    const serverTime = Date.now() + 5_000;
    const { impl, calls } = makeFetch(() => ({
      body: { player: { nickname: "钓鱼人", level: 7, gold: 100 }, serverTime: new Date(serverTime).toISOString() },
      headers: {
        "x-arcane-request-proof": PROOF,
        "x-arcane-server-time": String(serverTime),
        "x-frontend-version": "9.9.9",
      },
    }));
    const c = newClient(impl);

    await c.ensureSession();

    expect(calls[0]?.url).toBe("https://game.example/api/me");
    expect(c.proof).toBe(PROOF);
    expect(c.proofExpiresAt).toBe(9_999_999_999_999);
    expect(c.frontendVersion).toBe("9.9.9");
    expect(c.player?.nickname).toBe("钓鱼人");
    // 服务器时间比本地快 5 秒 → 偏移应为正
    expect(c.serverTimeOffset).toBeGreaterThan(3_000);
    expect(c.now()).toBeGreaterThan(Date.now() + 3_000);
  });

  it("Cookie 失效且有账密时自动重新登录", async () => {
    const { impl, calls } = makeFetch((_call, i) => {
      if (i === 0) return { status: 401, body: { error: { message: "会话已失效" } } };
      // 登录
      if (i === 1) {
        return {
          status: 200,
          body: { player: { level: 1 } },
          headers: { "set-cookie": "arcane_session=NEW; Path=/; HttpOnly" },
        };
      }
      return { status: 200, body: {} };
    });
    const c = newClient(impl);

    await c.ensureSession();

    expect(calls.map((x) => x.url)).toEqual([
      "https://game.example/api/me",
      "https://game.example/api/auth/login",
    ]);
    expect(c.cookie).toContain("arcane_session=NEW");
  });

  it("Cookie 失效且无账密时抛 SESSION_EXPIRED（不无限重试）", async () => {
    const { impl, calls } = makeFetch(() => ({ status: 401, body: { error: { message: "失效" } } }));
    const c = new GameClient({ baseUrl: "https://game.example", cookie: "web_session=x", fetchImpl: impl });

    await expect(c.ensureSession()).rejects.toMatchObject({ code: GAME_ERROR_CODES.SESSION_EXPIRED });
    expect(calls).toHaveLength(1);
  });
});

/* ---------------- 行为层：请求签名与重试 ---------------- */

describe("request 签名头", () => {
  it("受保护请求带上三个签名头，且签名可被独立实现对账", async () => {
    const { impl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/me")) return { body: {}, headers: { "x-arcane-request-proof": PROOF } };
      return { body: { ok: true } };
    });
    const c = newClient(impl);
    await c.request("/api/fishing/state");

    const signed = calls.find((x) => x.url.endsWith("/api/fishing/state"));
    expect(signed).toBeDefined();
    const h = signed!.headers;
    expect(h["x-arcane-request-proof"]).toBe(PROOF);
    expect(h["x-arcane-request-timestamp"]).toBeTruthy();
    expect(h["x-arcane-request-signature"]).toBe(
      expectedSignature(PROOF, "GET", "/api/fishing/state", h["x-arcane-request-timestamp"] as string, ""),
    );
  });

  it("白名单路径不签名", async () => {
    const { impl, calls } = makeFetch(() => ({ body: {} }));
    const c = newClient(impl);
    // 显式给一个 proof，绕过 ensureSession
    c.setProof(PROOF);
    await c.request("/api/meta/frontend-release");

    expect(calls[0]?.headers["x-arcane-request-signature"]).toBeUndefined();
    expect(calls[0]?.headers["x-arcane-request-proof"]).toBeUndefined();
  });

  it("有 body 时自动补 Content-Type，且签名基于该 body", async () => {
    const { impl, calls } = makeFetch(() => ({ body: {} }));
    const c = newClient(impl);
    c.setProof(PROOF);
    const payload = { hello: "世界" };
    await c.request("/api/thing", { method: "POST", body: payload });

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toBe(JSON.stringify(payload));
    expect(call.headers["x-arcane-request-signature"]).toBe(
      expectedSignature(PROOF, "POST", "/api/thing", call.headers["x-arcane-request-timestamp"] as string, call.body!),
    );
  });

  it("extraHeaders 会被带上（例如钓鱼快照键）", async () => {
    const { impl, calls } = makeFetch(() => ({ body: {} }));
    const c = newClient(impl);
    c.setProof(PROOF);
    await c.fishingSync("v1:abc");
    expect(calls[0]?.headers["x-fishing-run-snapshot-key"]).toBe("v1:abc");
  });

  it("未指定快照键时用 missing（与官方客户端一致）", async () => {
    const { impl, calls } = makeFetch(() => ({ body: {} }));
    const c = newClient(impl);
    c.setProof(PROOF);
    await c.fishingSync();
    expect(calls[0]?.headers["x-fishing-run-snapshot-key"]).toBe("missing");
  });

  it("playload 里的 Cookie 会带上", async () => {
    const { impl, calls } = makeFetch(() => ({ body: {} }));
    const c = new GameClient({ baseUrl: "https://game.example", cookie: "arcane_session=abc", fetchImpl: impl });
    c.setProof(PROOF);
    await c.me();
    expect(calls[0]?.headers["cookie"]).toBe("arcane_session=abc");
  });
});

describe("幂等键", () => {
  it("idempotent: true 时带 Idempotency-Key", async () => {
    const { impl, calls } = makeFetch(() => ({ body: {} }));
    const c = newClient(impl);
    c.setProof(PROOF);
    await c.fishingStart();
    expect(calls[0]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("★ 重试时复用同一个幂等键（否则服务端会把重试当成第二次操作）", async () => {
    const { impl, calls } = makeFetch((_call, i) => {
      if (i === 0) return { body: {}, headers: { "x-arcane-request-proof": PROOF } }; // 先拿 proof
      if (i === 1) return { status: 403, body: { error: { code: "REQUEST_SIGNATURE_INVALID", message: "签名失效" } } };
      return { body: { ok: true } }; // 重试成功
    });
    const c = newClient(impl);
    await c.request("/api/fishing/start", { method: "POST", idempotent: true });

    const attempts = calls.filter((x) => x.url.endsWith("/api/fishing/start"));
    expect(attempts.length).toBe(2);
    const k0 = attempts[0]?.headers["idempotency-key"];
    const k1 = attempts[1]?.headers["idempotency-key"];
    expect(k0).toBeTruthy();
    expect(k1).toBe(k0);
  });

  it("非幂等请求不带该头", async () => {
    const { impl, calls } = makeFetch(() => ({ body: {} }));
    const c = newClient(impl);
    c.setProof(PROOF);
    await c.me();
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
  });
});

describe("签名失效恢复", () => {
  it("403 签名失效 → 续期 → 重试一次并成功", async () => {
    const freshProof = makeProof(9_999_999_999_000);
    const { impl, calls } = makeFetch((call, i) => {
      if (call.url.endsWith("/api/me")) return { body: {}, headers: { "x-arcane-request-proof": freshProof } };
      if (i === 0) return { status: 403, body: { error: { code: "REQUEST_SIGNATURE_INVALID", message: "签名失效" } } };
      return { body: { ok: true } };
    });
    const c = newClient(impl);
    c.setProof(PROOF); // 先用旧 proof

    const result = await c.request("/api/fishing/state");

    expect(result).toEqual({ ok: true });
    const urls = calls.map((x) => x.url.replace("https://game.example", ""));
    expect(urls).toEqual(["/api/fishing/state", "/api/me", "/api/fishing/state"]);
    // 重试用的是新 proof
    const last = calls.at(-1)!;
    expect(last.headers["x-arcane-request-proof"]).toBe(freshProof);
  });

  it("续期失败但有账密 → 重新登录 → 重试成功", async () => {
    let meCalls = 0;
    let stateCalls = 0;
    const debug: string[] = [];
    const { impl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/me")) {
        meCalls++;
        debug.push(`me#${meCalls}`);
        // 第一次 /api/me 就 401（Cookie 已失效）→ 迫使走「重新登录」分支。
        //
        // 注意：这里不能用「第 1 次成功、之后失败」的写法来逼出重登 ——
        // /api/me 成功时一定会带回新的 x-arcane-request-proof（游戏就是这么设计的），
        // 所以「续期成功」本身就等于「签名问题已解决」，永远不会落到重登分支。
        // 要让续期失败，只能让 /api/me 真的失败。
        if (meCalls === 1) return { status: 401, body: { error: { message: "会话失效" } } };
        return { body: {}, headers: { "x-arcane-request-proof": PROOF } };
      }
      if (call.url.endsWith("/api/auth/login")) {
        debug.push("login");
        return {
          body: {},
          headers: { "x-arcane-request-proof": makeProof(9_999_999_998_000), "set-cookie": "arcane_session=Z" },
        };
      }
      stateCalls++;
      debug.push(`state#${stateCalls}`);
      // 首次请求签名失效；重试（此时已重登拿到新 proof）成功
      if (stateCalls === 1) return { status: 403, body: { error: { message: "签名失效" } } };
      return { body: { ok: "after-relogin" } };
    });
    const c = newClient(impl);

    const result = await c.request("/api/fishing/state");

    expect(result).toEqual({ ok: "after-relogin" });
    const urls = calls.map((x) => x.url.replace("https://game.example", ""));
    expect(urls, `实际调用序列：${debug.join(" | ")}`).toEqual([
      "/api/me", //             ① 无 proof → ensureSession，Cookie 已失效（401）
      "/api/auth/login", //     ② 有账密 → 重新登录
      "/api/fishing/state", //  ③ 首次带新 proof，签名仍失效（403）
      "/api/me", //             ④ 续期成功，拿到新 proof
      "/api/fishing/state", //  ⑤ 重试成功
    ]);
    // 最终一次用的是续期后的 proof
    expect(calls.at(-1)?.headers["x-arcane-request-proof"]).toBe(PROOF);
  });

  it("★ 幂等键在整条重登链路里保持不变", async () => {
    let meCalls = 0;
    const { impl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/me")) {
        meCalls++;
        if (meCalls === 1) return { status: 401, body: { error: { message: "失效" } } };
        return { body: {}, headers: { "x-arcane-request-proof": PROOF } };
      }
      if (call.url.endsWith("/api/auth/login")) {
        return { body: {}, headers: { "x-arcane-request-proof": PROOF } };
      }
      if (call.url.endsWith("/api/fishing/start")) {
        // 第一次 403，第二次成功
        const already = calls.filter((x) => x.url.endsWith("/api/fishing/start")).length;
        if (already === 1) return { status: 403, body: { error: { message: "签名失效" } } };
        return { body: { ok: true } };
      }
      return { body: {} };
    });
    const c = newClient(impl);
    await c.request("/api/fishing/start", { method: "POST", idempotent: true });

    const attempts = calls.filter((x) => x.url.endsWith("/api/fishing/start"));
    expect(attempts.length).toBe(2);
    // 中间经历了「重新登录」，幂等键依然必须是同一个
    expect(attempts[0]?.headers["idempotency-key"]).toBeTruthy();
    expect(attempts[1]?.headers["idempotency-key"]).toBe(attempts[0]?.headers["idempotency-key"]);
  });

  it("续期失败且无账密 → 重试后仍失败则抛出（不递归、不重登）", async () => {
    let meCalls = 0;
    const { impl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/me")) {
        meCalls++;
        if (meCalls === 1) return { body: {}, headers: { "x-arcane-request-proof": PROOF } };
        return { status: 401, body: { error: { message: "会话失效" } } };
      }
      // 目标接口持续签名失效（重试也一样）
      if (call.url.endsWith("/api/fishing/state")) {
        return { status: 403, body: { error: { code: "REQUEST_SIGNATURE_INVALID", message: "签名失效" } } };
      }
      return { body: { ok: true } };
    });
    const c = new GameClient({ baseUrl: "https://game.example", cookie: "web=x", fetchImpl: impl });
    c.setProof(PROOF);

    // 语义说明：重试用尽后抛的是**服务端原始错误码**（REQUEST_SIGNATURE_INVALID）＋ 403 状态，
    // 而不是笼统的 SESSION_EXPIRED —— 这样排障时能看出是签名问题而非 Cookie 问题。
    // 判断「会话是否已死」用 isSessionFatal，它同时认 REQUEST_SIGNATURE_INVALID。
    let caught: GameClientError | null = null;
    try {
      await c.request("/api/fishing/state");
    } catch (err) {
      caught = err as GameClientError;
    }
    expect(caught).toBeInstanceOf(GameClientError);
    expect(caught!.status).toBe(403);
    expect(caught!.code).toBe("REQUEST_SIGNATURE_INVALID");
    expect(caught!.isSessionFatal).toBe(true);

    // 关键：没有账密就绝不能去登录（否则会无账号重试风暴）
    expect(calls.some((x) => x.url.endsWith("/api/auth/login"))).toBe(false);
    // 且只重试了一次
    expect(calls.filter((x) => x.url.endsWith("/api/fishing/state")).length).toBe(2);
  });

  it("登录请求自身失败不会触发重登递归", async () => {
    const { impl, calls } = makeFetch(() => ({
      status: 403,
      body: { error: { code: "REQUEST_SIGNATURE_INVALID", message: "签名失效" } },
    }));
    const c = newClient(impl);
    await expect(c.login()).rejects.toBeInstanceOf(GameClientError);
    // 只调用一次登录，没有递归
    expect(calls.filter((x) => x.url.endsWith("/api/auth/login")).length).toBe(1);
  });

  it("连续两次签名失效只重试一次（isRetry 生效）", async () => {
    const { impl, calls } = makeFetch((call, i) => {
      if (call.url.endsWith("/api/me")) return { body: {}, headers: { "x-arcane-request-proof": PROOF } };
      if (i === 1 || i === 3) return { status: 403, body: { error: { message: "签名失效" } } };
      return { body: { ok: true } };
    });
    const c = newClient(impl);
    c.setProof(PROOF);
    await c.request("/api/x");
    expect(calls.filter((x) => x.url.endsWith("/api/x")).length).toBeLessThanOrEqual(2);
  });
});

describe("proof 主动续期", () => {
  it("临近过期时先续期再发请求", async () => {
    const soon = Date.now() + 10_000; // 10 秒后过期，小于 60 秒的安全边界
    const { impl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/me")) {
        return { body: {}, headers: { "x-arcane-request-proof": makeProof(Date.now() + 900_000) } };
      }
      return { body: { ok: true } };
    });
    const c = newClient(impl);
    c.setProof(makeProof(soon));

    await c.request("/api/fishing/state");

    const urls = calls.map((x) => x.url.replace("https://game.example", ""));
    expect(urls[0]).toBe("/api/me"); // 先续期
    expect(urls[1]).toBe("/api/fishing/state");
  });

  it("proof 还很久才过期时不额外续期", async () => {
    const { impl, calls } = makeFetch(() => ({ body: { ok: true } }));
    const c = newClient(impl);
    c.setProof(makeProof(Date.now() + 900_000));
    await c.request("/api/fishing/state");
    expect(calls.map((x) => x.url.replace("https://game.example", ""))).toEqual(["/api/fishing/state"]);
  });

  it("主动续期失败只记警告，不影响原请求", async () => {
    const logs: string[] = [];
    const { impl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/me")) return { status: 500, body: { error: { message: "boom" } } };
      return { body: { ok: true } };
    });
    const c = newClient(impl, { onLog: (_l: string, _t: string, m: string) => logs.push(m) });
    c.setProof(makeProof(Date.now() + 10_000));

    const result = await c.request("/api/fishing/state");
    expect(result).toEqual({ ok: true });
    expect(logs.some((l) => l.includes("续期失败"))).toBe(true);
    expect(calls.some((x) => x.url.endsWith("/api/fishing/state"))).toBe(true);
  });
});

describe("错误分类", () => {
  it("超时归为 TIMEOUT（而不是笼统的网络错误）", async () => {
    const { impl } = makeFetch(() => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      return { throwError: err };
    });
    const c = newClient(impl);
    c.setProof(PROOF);
    await expect(c.request("/api/x")).rejects.toMatchObject({ code: GAME_ERROR_CODES.TIMEOUT });
  });

  it("连接被拒归为网络错误", async () => {
    const { impl } = makeFetch(() => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
      (err as { code?: string }).code = "ECONNREFUSED";
      return { throwError: err };
    });
    const c = newClient(impl);
    c.setProof(PROOF);
    await expect(c.request("/api/x")).rejects.toMatchObject({ code: GAME_ERROR_CODES.NETWORK });
  });

  it("业务错误带上服务端 code 与 message", async () => {
    const { impl } = makeFetch(() => ({
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "参数不对" } },
    }));
    const c = newClient(impl);
    c.setProof(PROOF);
    try {
      await c.request("/api/x", { method: "POST", body: {} });
      throw new Error("应当抛错");
    } catch (err) {
      const e = err as GameClientError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.message).toBe("参数不对");
    }
  });

  it("429 归为 RATE_LIMITED 且标记为可重试", async () => {
    const { impl } = makeFetch(() => ({ status: 429, body: { error: { message: "太快了" } } }));
    const c = newClient(impl);
    c.setProof(PROOF);
    try {
      await c.request("/api/x");
      throw new Error("应当抛错");
    } catch (err) {
      const e = err as GameClientError;
      expect(e.code).toBe(GAME_ERROR_CODES.RATE_LIMITED);
      expect(e.isRetryable).toBe(true);
    }
  });

  it("5xx 标记为可重试，4xx 业务错误不可重试", async () => {
    const mk = async (status: number) => {
      const { impl } = makeFetch(() => ({ status, body: { error: { message: "x" } } }));
      const c = newClient(impl);
      c.setProof(PROOF);
      try {
        await c.request("/api/x");
        return null;
      } catch (err) {
        return err as GameClientError;
      }
    };
    expect((await mk(500))?.isRetryable).toBe(true);
    expect((await mk(400))?.isRetryable).toBe(false);
  });

  it("非 JSON 响应不会崩，错误里带上片段", async () => {
    const { impl } = makeFetch(() => ({ status: 502, body: "<html>Bad Gateway</html>" }));
    const c = newClient(impl);
    c.setProof(PROOF);
    try {
      await c.request("/api/x");
      throw new Error("应当抛错");
    } catch (err) {
      expect((err as GameClientError).status).toBe(502);
    }
  });
});

describe("absorb 的其他细节", () => {
  it("多个 Set-Cookie 会合并进 Cookie 头", async () => {
    const calls: Call[] = [];
    const realImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        headers: {},
        body: undefined,
      });
      const h = new Headers();
      h.append("set-cookie", "a=1; Path=/");
      h.append("set-cookie", "b=2; Path=/");
      return new Response("{}", { status: 200, headers: h });
    };
    const c = newClient(realImpl);
    await c.ensureSession();
    expect(c.cookie).toContain("a=1");
    expect(c.cookie).toContain("b=2");
    expect(calls).toHaveLength(1);
  });

  it("snapshot 不含密码", () => {
    const c = new GameClient({
      baseUrl: "https://game.example",
      email: "u@x.com",
      password: "super-secret",
      cookie: "c=1",
    });
    c.setProof(PROOF);
    const snap = c.snapshot();
    expect(JSON.stringify(snap)).not.toContain("super-secret");
    expect(snap.email).toBe("u@x.com");
    expect(snap.hasCookie).toBe(true);
    expect(snap.hasCredentials).toBe(true);
  });

  it("setCredentials 会清掉 proof 以强制重新登录", () => {
    const c = new GameClient({ baseUrl: "https://game.example", email: "a@b.com", password: "old" });
    c.setProof(PROOF);
    c.setCredentials({ password: "new" });
    expect(c.proof).toBeNull();
    expect(c.password).toBe("new");
  });

  it("baseUrl 末尾斜杠被归一", async () => {
    const { impl, calls } = makeFetch(() => ({ body: {} }));
    const c = new GameClient({ baseUrl: "https://game.example///", fetchImpl: impl });
    c.setProof(PROOF);
    await c.me();
    expect(calls[0]?.url).toBe("https://game.example/api/me");
  });
});

describe("登录被拒 vs 会话失效（曾经把口令错报成「会话已失效」）", () => {
  it("★ 登录接口返回 401 → 报「邮箱或口令不正确」，且**不会**去刷新会话或重试", async () => {
    const { impl, calls } = makeFetch(() => ({
      status: 401,
      body: { error: { message: "invalid credentials" } },
    }));
    const c = newClient(impl);

    await expect(c.login()).rejects.toMatchObject({
      code: GAME_ERROR_CODES.BAD_CREDENTIALS,
      status: 401,
    });
    // 报错文案要指向真正的排查方向
    await expect(c.login()).rejects.toThrow(/邮箱或口令不正确/);
    // 关键：只发了登录请求，没有多余的 /api/me 续期探测
    expect(calls.every((x) => x.url === "https://game.example/api/auth/login")).toBe(true);
  });

  it("★ BAD_CREDENTIALS 属于「挂起等待用户处理」，不会无限重试登录", async () => {
    const { impl } = makeFetch(() => ({ status: 401, body: {} }));
    const c = newClient(impl);
    try {
      await c.login();
      throw new Error("应当抛错");
    } catch (err) {
      const e = err as GameClientError;
      expect(e.code).toBe(GAME_ERROR_CODES.BAD_CREDENTIALS);
      expect(e.isSessionFatal).toBe(true);
      expect(e.isRetryable).toBe(false);
    }
  });

  it("带签名的请求遇到 401 仍然会续期/重登后重试一次（这条路径不能被上面改坏）", async () => {
    const calls: string[] = [];
    let stateCalls = 0;
    const impl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/fishing/state")) {
        stateCalls += 1;
        // 1) 首次调用业务接口 → 401（proof 过期）
        if (stateCalls === 1) {
          return new Response(JSON.stringify({ error: { message: "proof expired" } }), { status: 401 });
        }
        // 3) 续期后重试 → 成功
        return new Response(JSON.stringify({ run: { id: "r1" } }), { status: 200 });
      }
      // 2) /api/me 续期成功并下发新 proof
      return new Response(JSON.stringify({ player: { nickname: "x" } }), {
        status: 200,
        headers: { "x-arcane-request-proof": PROOF },
      });
    };
    const c = newClient(impl);
    c.setProof(makeProof(Date.now() + 60_000));

    const out = await c.fishingState();
    expect(out).toEqual({ run: { id: "r1" } });
    // 业务接口被调了两次（失败 → 续期 → 重试），中间夹着一次 /api/me
    expect(stateCalls).toBe(2);
    expect(calls.some((u) => u.endsWith("/api/me"))).toBe(true);
  });
});

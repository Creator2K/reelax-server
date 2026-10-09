// 会话 cookie 策略测试
//
// ★ 这是一条真实踩过的坑的回归测试：
//   早期实现是「NODE_ENV === production 就给 cookie 加 Secure」，结果在
//   「Nginx 只做 80 端口反代」或「局域网 IP 直连」的部署里，浏览器拿到
//   Secure cookie 后在 http:// 下**不会回传** —— 现象是
//   「登录接口返回 200，但下一个接口又是未登录」，极难排查（本地开发还完全正常）。
//
//   正确做法：按**每次请求的实际协议**决定是否加 Secure，并在 trust proxy
//   打开时识别 X-Forwarded-Proto。
import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  cookieOptionsFor,
  isHttpsRequest,
  makeCookieStrategy,
  parseCookie,
  serializeSessionCookie,
} from "../src/auth/middleware.ts";

/** 造一个最小的 Request 替身（只用到 secure / headers） */
const req = (opts: { secure?: boolean; proto?: string | string[] } = {}) =>
  ({
    secure: opts.secure ?? false,
    headers: opts.proto ? { "x-forwarded-proto": opts.proto } : {},
  }) as unknown as import("express").Request;

/** 造一个只记录 Set-Cookie 的 Response 替身 */
const res = () => {
  const headers: string[] = [];
  return {
    append(name: string, value: string) {
      if (name.toLowerCase() === "set-cookie") headers.push(value);
    },
    get cookies() {
      return headers;
    },
  } as unknown as import("express").Response & { cookies: string[] };
};

describe("isHttpsRequest", () => {
  it("req.secure 为真时是 HTTPS", () => {
    expect(isHttpsRequest(req({ secure: true }))).toBe(true);
  });

  it("识别 X-Forwarded-Proto（反代场景）", () => {
    expect(isHttpsRequest(req({ proto: "https" }))).toBe(true);
    expect(isHttpsRequest(req({ proto: "http" }))).toBe(false);
  });

  it("X-Forwarded-Proto 是多级代理的逗号串时取第一段", () => {
    expect(isHttpsRequest(req({ proto: "https, http" }))).toBe(true);
    expect(isHttpsRequest(req({ proto: "http, https" }))).toBe(false);
  });

  it("X-Forwarded-Proto 是数组时取第一个", () => {
    expect(isHttpsRequest(req({ proto: ["https", "http"] }))).toBe(true);
  });

  it("两者都没有时按 HTTP 处理", () => {
    expect(isHttpsRequest(req())).toBe(false);
  });
});

describe("cookieOptionsFor", () => {
  it("★ HTTP 请求不加 Secure（否则浏览器不回传，表现为登录后立刻掉线）", () => {
    expect(cookieOptionsFor(req(), { maxAgeMs: 1000 }).secure).toBe(false);
  });

  it("HTTPS 请求自动加 Secure", () => {
    expect(cookieOptionsFor(req({ secure: true }), { maxAgeMs: 1000 }).secure).toBe(true);
    expect(cookieOptionsFor(req({ proto: "https" }), { maxAgeMs: 1000 }).secure).toBe(true);
  });

  it("forceSecure 显式开启时，HTTP 也加 Secure（用户明确要求）", () => {
    expect(cookieOptionsFor(req(), { forceSecure: true, maxAgeMs: 1000 }).secure).toBe(true);
  });

  it("forceSecure 为 false 时，HTTPS 也不加（反向需求）", () => {
    expect(cookieOptionsFor(req({ secure: true }), { forceSecure: false, maxAgeMs: 1000 }).secure).toBe(false);
  });
});

describe("serializeSessionCookie", () => {
  it("HTTP 下不带 Secure，但该有的属性都在", () => {
    const c = serializeSessionCookie("tok123", { secure: false, maxAgeMs: 86_400_000 });
    expect(c).toContain(`${SESSION_COOKIE}=tok123`);
    expect(c).toContain("Path=/");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=86400");
    expect(c).not.toContain("Secure");
  });

  it("HTTPS 下带 Secure", () => {
    const c = serializeSessionCookie("tok", { secure: true, maxAgeMs: 1000 });
    expect(c).toContain("Secure");
  });

  it("token 做了 URL 编码（base64url 里可能有 - _ 之外的字符）", () => {
    const c = serializeSessionCookie("a b/c=", { secure: false, maxAgeMs: 1000 });
    expect(c).toContain(encodeURIComponent("a b/c="));
  });
});

describe("clearSessionCookie", () => {
  it("Max-Age=0，且不需要 Secure（浏览器总会覆盖同名 cookie）", () => {
    const c = clearSessionCookie();
    expect(c).toContain("Max-Age=0");
    expect(c).toContain(`${SESSION_COOKIE}=`);
    expect(c).not.toContain("Secure");
  });
});

describe("makeCookieStrategy", () => {
  it("HTTP 请求下发的 cookie 不含 Secure", () => {
    const strategy = makeCookieStrategy(undefined, 86_400_000);
    const r = res();
    strategy.set(r, req(), "token-abc");
    expect(r.cookies).toHaveLength(1);
    expect(r.cookies[0]).toContain("token-abc");
    expect(r.cookies[0]).not.toContain("Secure");
  });

  it("HTTPS 请求下发的 cookie 含 Secure", () => {
    const strategy = makeCookieStrategy(undefined, 86_400_000);
    const r = res();
    strategy.set(r, req({ secure: true }), "token-abc");
    expect(r.cookies[0]).toContain("Secure");
  });

  it("clear 会下发一条清空指令", () => {
    const strategy = makeCookieStrategy(undefined, 86_400_000);
    const r = res();
    strategy.clear(r);
    expect(r.cookies).toHaveLength(1);
    expect(r.cookies[0]).toContain("Max-Age=0");
  });

  it("COOKIE_SECURE=true 时强制 Secure（即使请求是 HTTP）", () => {
    const strategy = makeCookieStrategy(true, 1000);
    const r = res();
    strategy.set(r, req(), "t");
    expect(r.cookies[0]).toContain("Secure");
  });
});

describe("parseCookie", () => {
  it("取出指定键", () => {
    expect(parseCookie("a=1; reelax_session=xyz; b=2", SESSION_COOKIE)).toBe("xyz");
  });

  it("没有该键时返回 null", () => {
    expect(parseCookie("a=1; b=2", SESSION_COOKIE)).toBeNull();
    expect(parseCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(parseCookie("", SESSION_COOKIE)).toBeNull();
  });

  it("值是 URL 编码时会解码", () => {
    expect(parseCookie(`x=1; ${SESSION_COOKIE}=${encodeURIComponent("a b")}`, SESSION_COOKIE)).toBe("a b");
  });

  it("非法编码不会抛错（返回原始值）", () => {
    expect(() => parseCookie(`${SESSION_COOKIE}=%E0%A4%A`, SESSION_COOKIE)).not.toThrow();
  });

  it("不会误匹配前缀相同的键", () => {
    // reelax_session_other 与 reelax_session 前缀相同
    expect(parseCookie("reelax_session_other=evil", SESSION_COOKIE)).toBeNull();
  });
});

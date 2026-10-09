// 口令哈希单测
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  burnTimeLikeVerify,
  hashPassword,
  needsRehash,
  validatePasswordStrength,
  verifyPassword,
} from "../src/security/password.ts";

describe("validatePasswordStrength", () => {
  it("接受足够长的口令", () => {
    expect(validatePasswordStrength("correct horse battery").ok).toBe(true);
    expect(validatePasswordStrength("12345678").ok).toBe(true);
  });

  it("拒绝过短的口令", () => {
    const r = validatePasswordStrength("short");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it("拒绝超长口令", () => {
    const r = validatePasswordStrength("a".repeat(PASSWORD_MAX_LENGTH + 1));
    expect(r.ok).toBe(false);
  });

  it("拒绝全部字符相同的口令", () => {
    expect(validatePasswordStrength("aaaaaaaa").ok).toBe(false);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("哈希格式自带参数，便于将来调参升级", async () => {
    const hash = await hashPassword("my-password");
    expect(hash.startsWith("scrypt$N=32768,r=8,p=1$")).toBe(true);
    expect(hash.split("$")).toHaveLength(4);
  });

  it("哈希里不含明文口令", async () => {
    const hash = await hashPassword("plaintext-secret");
    expect(hash).not.toContain("plaintext-secret");
  });

  it("同一口令两次哈希结果不同（盐随机），但都能校验通过", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("错误口令校验失败", async () => {
    const hash = await hashPassword("right-password");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    expect(await verifyPassword("right-password ", hash)).toBe(false);
  });

  it("支持中文与 emoji 口令", async () => {
    const pw = "口令-🔐-测试";
    const hash = await hashPassword(pw);
    expect(await verifyPassword(pw, hash)).toBe(true);
  });

  it("损坏的哈希串不会抛错，只是校验失败", async () => {
    for (const bad of ["", "garbage", "scrypt$broken", "scrypt$N=0,r=0,p=0$aaa$bbb", "bcrypt$xxx$yyy$zzz"]) {
      await expect(verifyPassword("anything", bad)).resolves.toBe(false);
    }
  });

  it("needsRehash：参数一致时不需要重算，格式非法时需要", async () => {
    const hash = await hashPassword("pw", DEFAULT_PARAMS);
    expect(needsRehash(hash)).toBe(false);
    expect(needsRehash(hash, { N: 2 ** 16, r: 8, p: 1 })).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
  });

  it("旧参数哈希在调参后仍可校验通过（平滑升级）", async () => {
    const weak = { N: 2 ** 14, r: 8, p: 1 };
    const legacy = await hashPassword("legacy-pw", weak);
    // 用当前默认参数校验时应仍通过（参数从哈希串里读）
    expect(await verifyPassword("legacy-pw", legacy)).toBe(true);
    // 但会被标记为需要重算
    expect(needsRehash(legacy)).toBe(true);
  });
});

describe("burnTimeLikeVerify", () => {
  it("不抛错，且耗时与一次真实校验同量级（用于抹平用户存在性信道）", async () => {
    const t0 = Date.now();
    await burnTimeLikeVerify();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThan(5);
  });
});

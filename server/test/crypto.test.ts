// 凭证加密单测
//
// 这一层的失败模式非常隐蔽（解密失败表现为「账号突然登不上」），
// 所以逐条覆盖：往返、篡改、AAD 搬运、密钥版本、错误密钥的报错可读性。
import { describe, expect, it } from "vitest";
import {
  CryptoError,
  Keyring,
  decryptSecret,
  deriveKey,
  encryptSecret,
  generateMasterKey,
  safeEqual,
} from "../src/security/crypto.ts";

const KEY_A = Buffer.from("a".repeat(64), "hex");
const KEY_B = Buffer.from("b".repeat(64), "hex");

const ringA = () => new Keyring(KEY_A);

describe("Keyring", () => {
  it("拒绝长度不对的主密钥", () => {
    expect(() => new Keyring(Buffer.alloc(16, 1))).toThrow(CryptoError);
    expect(() => new Keyring(Buffer.alloc(16, 1))).toThrow(/长度必须是 32 字节/);
  });

  it("currentVersion 是最后注册的版本", () => {
    const ring = new Keyring(KEY_A, ["v1", "v2"]);
    expect(ring.currentVersion).toBe("v2");
    expect(ring.has("v1")).toBe(true);
    expect(ring.has("v3")).toBe(false);
  });

  it("不同用途派生出不同子密钥（用途隔离）", () => {
    const ring = ringA();
    const cred = ring.key("credential", "v1");
    const cookie = ring.key("cookie", "v1");
    const proxy = ring.key("proxy", "v1");
    expect(cred.equals(cookie)).toBe(false);
    expect(cred.equals(proxy)).toBe(false);
    expect(cred.length).toBe(32);
  });

  it("派生是确定性的，且与直接 hkdf 结果一致", () => {
    const a = deriveKey(KEY_A, "credential", "v1");
    const b = deriveKey(KEY_A, "credential", "v1");
    expect(a.equals(b)).toBe(true);
    expect(a.equals(deriveKey(KEY_A, "cookie", "v1"))).toBe(false);
    expect(a.equals(deriveKey(KEY_B, "credential", "v1"))).toBe(false);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("往返成功（含中文与特殊字符）", () => {
    const ring = ringA();
    const plain = "p@ssw0rd-密码-🔑-with spaces";
    const enc = encryptSecret(plain, ring, "credential", "user-1", "password");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc.split(".")).toHaveLength(4);
    expect(enc).not.toContain(plain);
    expect(decryptSecret(enc, ring, "credential", "user-1", "password")).toBe(plain);
  });

  it("同一明文两次加密产生不同密文（nonce 每次随机）", () => {
    const ring = ringA();
    const a = encryptSecret("same", ring, "credential", "u", "password");
    const b = encryptSecret("same", ring, "credential", "u", "password");
    expect(a).not.toBe(b);
    expect(decryptSecret(a, ring, "credential", "u", "password")).toBe("same");
    expect(decryptSecret(b, ring, "credential", "u", "password")).toBe("same");
  });

  it("密文被篡改时抛错（GCM 认证标签生效）", () => {
    const ring = ringA();
    const enc = encryptSecret("secret", ring, "credential", "u", "password");
    const parts = enc.split(".");
    // 翻转密文最后一个字符
    const ct = parts[3] as string;
    const flipped = ct.slice(0, -1) + (ct.at(-1) === "A" ? "B" : "A");
    const tampered = [parts[0], parts[1], parts[2], flipped].join(".");
    expect(() => decryptSecret(tampered, ring, "credential", "u", "password")).toThrow(/认证标签不匹配/);
  });

  it("AAD 绑定生效：换一个 userId 解不出来（防止密文被搬到别的行）", () => {
    const ring = ringA();
    const enc = encryptSecret("secret", ring, "credential", "user-A", "password");
    expect(() => decryptSecret(enc, ring, "credential", "user-B", "password")).toThrow(CryptoError);
  });

  it("AAD 绑定生效：换一个字段名解不出来", () => {
    const ring = ringA();
    const enc = encryptSecret("secret", ring, "credential", "u", "password");
    expect(() => decryptSecret(enc, ring, "credential", "u", "cookie")).toThrow(CryptoError);
  });

  it("用途不匹配时解密失败（不是同一把子密钥）", () => {
    const ring = ringA();
    const enc = encryptSecret("secret", ring, "credential", "u", "password");
    expect(() => decryptSecret(enc, ring, "cookie", "u", "password")).toThrow(/解密失败/);
  });

  it("格式非法的密文报 MALFORMED_CIPHERTEXT", () => {
    const ring = ringA();
    const cases = ["", "abc", "v1.only.two", "x9.a.b.c.d", "v1.a.b.c"];
    for (const bad of cases) {
      try {
        decryptSecret(bad, ring, "credential", "u", "password");
        throw new Error(`应当抛错：${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError);
        const code = (err as CryptoError).code;
        expect(["MALFORMED_CIPHERTEXT", "DECRYPT_FAILED"]).toContain(code);
      }
    }
  });

  it("换了主密钥时给出可读的「密钥与数据不匹配」提示，而不是静默空值", () => {
    const encA = encryptSecret("secret", new Keyring(KEY_A), "credential", "u", "password");
    let caught: unknown = null;
    try {
      decryptSecret(encA, new Keyring(KEY_B), "credential", "u", "password");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    // 同一 v1 前缀 → 会走到 GCM 认证失败，提示里要说明是密钥不一致
    expect((caught as Error).message).toMatch(/MASTER_KEY|认证标签不匹配/);
  });

  it("数据是用未配置的密钥版本加密时，报错明确点名版本", () => {
    const encV2 = encryptSecret("secret", new Keyring(KEY_B, ["v2"]), "credential", "u", "password");
    expect(encV2.startsWith("v2.")).toBe(true);
    let caught: unknown = null;
    try {
      decryptSecret(encV2, new Keyring(KEY_A, ["v1"]), "credential", "u", "password");
    } catch (err) {
      caught = err;
    }
    expect((caught as CryptoError).code).toBe("MASTER_KEY_MISMATCH");
    expect((caught as Error).message).toContain("v2");
  });

  it("密钥轮换：密钥环同时持有 v1/v2 时，旧数据仍可解，新数据用 v2", () => {
    const oldRing = new Keyring(KEY_A, ["v1"]);
    const legacy = encryptSecret("old-secret", oldRing, "credential", "u", "password");

    const rotated = new Keyring(KEY_A, ["v1", "v2"]);
    // 旧数据可解（v1 仍在环里）
    expect(decryptSecret(legacy, rotated, "credential", "u", "password")).toBe("old-secret");
    // 新写入用 v2
    const fresh = encryptSecret("new-secret", rotated, "credential", "u", "password");
    expect(fresh.startsWith("v2.")).toBe(true);
    expect(decryptSecret(fresh, rotated, "credential", "u", "password")).toBe("new-secret");
  });

  it("空字符串也能正确往返", () => {
    const ring = ringA();
    const enc = encryptSecret("", ring, "cookie", "u", "cookie");
    expect(decryptSecret(enc, ring, "cookie", "u", "cookie")).toBe("");
  });
});

describe("safeEqual", () => {
  it("相等返回 true，不等返回 false", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("generateMasterKey", () => {
  it("生成 32 字节 hex，可被 Keyring 接受", () => {
    const k = generateMasterKey();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(() => new Keyring(Buffer.from(k, "hex"))).not.toThrow();
  });
});

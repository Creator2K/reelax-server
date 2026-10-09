// 凭证加密：AES-256-GCM + HKDF 派生子密钥
//
// 设计要点：
//  1) 不直接用 MASTER_KEY 加密，而是按用途 HKDF 派生 —— 凭证、Cookie、代理口令各一把，
//     某一把泄漏不会连带影响其它用途
//  2) AAD 绑定 `userId|字段名`，防止密文在数据库行之间被搬运复用
//  3) 每次写入重新随机 nonce（绝不复用）
//  4) 版本前缀支持密钥轮换：v1 / v2 ... 解密时按前缀选密钥
//  5) 解密失败必须**明确报错并指出密钥不匹配**，绝不返回空值 ——
//     否则现象是「账号突然登不上」，极难排查
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_SALT = "reelax-server";

/** 用途隔离：不同用途派生不同子密钥 */
export type KeyPurpose = "credential" | "cookie" | "proxy";

export class CryptoError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

const PURPOSE_INFO: Record<KeyPurpose, string> = {
  credential: "reelax:credential:v1",
  cookie: "reelax:cookie:v1",
  proxy: "reelax:proxy:v1",
};

export function deriveKey(masterKey: Buffer, purpose: KeyPurpose, version = "v1"): Buffer {
  const info = `${PURPOSE_INFO[purpose]}:${version}`;
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.from(HKDF_SALT), Buffer.from(info), KEY_BYTES));
}

/** 密钥环：支持同时持有多代密钥（轮换时旧数据仍可解） */
export class Keyring {
  private keys = new Map<string, Buffer>();

  constructor(masterKey: Buffer, versions: string[] = ["v1"]) {
    if (masterKey.length !== KEY_BYTES) {
      throw new CryptoError(`MASTER_KEY 长度必须是 ${KEY_BYTES} 字节，当前 ${masterKey.length}`, "BAD_MASTER_KEY");
    }
    for (const v of versions) {
      this.keys.set(v, masterKey);
    }
  }

  /** 当前写入使用的版本 = 最后一个 */
  get currentVersion(): string {
    const all = [...this.keys.keys()];
    return all[all.length - 1] ?? "v1";
  }

  has(version: string): boolean {
    return this.keys.has(version);
  }

  key(purpose: KeyPurpose, version: string): Buffer {
    const master = this.keys.get(version);
    if (!master) {
      throw new CryptoError(
        `数据是用密钥版本「${version}」加密的，但当前进程只配置了 [${[...this.keys.keys()].join(", ")}]。` +
          `请提供与数据匹配的 MASTER_KEY（或把新密钥加入密钥环后再轮换）。`,
        "MASTER_KEY_MISMATCH",
      );
    }
    return deriveKey(master, purpose, version);
  }
}

/** AAD：绑定归属，防止密文被搬到另一行/另一字段 */
function buildAad(userId: string, field: string, version: string): Buffer {
  return Buffer.from(`${version}|${userId}|${field}`, "utf8");
}

/**
 * 加密。返回 `v1.<nonce>.<tag>.<ciphertext>`（各段 base64url 无填充）。
 * @param aadUserId 密文归属的用户 id
 * @param field     字段名（如 "password" / "cookie" / "proxy_password"）
 */
export function encryptSecret(
  plaintext: string,
  keyring: Keyring,
  purpose: KeyPurpose,
  aadUserId: string,
  field: string,
): string {
  const version = keyring.currentVersion;
  const key = keyring.key(purpose, version);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAad(aadUserId, field, version));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, nonce.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** 解密。密文格式/密钥/AAD 任一不匹配都抛明确错误。 */
export function decryptSecret(
  payload: string,
  keyring: Keyring,
  purpose: KeyPurpose,
  aadUserId: string,
  field: string,
): string {
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new CryptoError(`密文格式非法（期望 4 段，实际 ${parts.length} 段）`, "MALFORMED_CIPHERTEXT");
  }
  const [version, nonceB64, tagB64, ctB64] = parts as [string, string, string, string];
  if (!/^v\d+$/.test(version)) {
    throw new CryptoError(`密文版本前缀非法：${version}`, "MALFORMED_CIPHERTEXT");
  }
  const key = keyring.key(purpose, version); // 版本缺失时在此抛出 MASTER_KEY_MISMATCH
  const nonce = Buffer.from(nonceB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  if (nonce.length !== NONCE_BYTES) {
    throw new CryptoError(`nonce 长度异常：${nonce.length}`, "MALFORMED_CIPHERTEXT");
  }
  if (tag.length !== TAG_BYTES) {
    throw new CryptoError(`认证标签长度异常：${tag.length}`, "MALFORMED_CIPHERTEXT");
  }
  const decipher = createDecipheriv(ALGO, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(buildAad(aadUserId, field, version));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new CryptoError(
      "解密失败：认证标签不匹配（MASTER_KEY 与数据不一致，或密文被篡改/搬运）。" +
        "请确认 MASTER_KEY 与写入数据时使用的是同一个。",
      "DECRYPT_FAILED",
    );
  }
}

/** 常量时间字符串比较（token 比对用） */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 生成 32 字节 hex 主密钥（供 CLI / 文档提示复用同一实现） */
export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}

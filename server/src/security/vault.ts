// 凭证保管箱：所有明文凭证的唯一出入口
//
// 规则（重要）：
//  1) 只有这里能把密文解成明文，且必须显式传入 userId（AAD 绑定）
//  2) 明文只在构造 GameClient 的瞬间存在，不上日志、不进 API 响应
//  3) 解密失败要区分「密钥不匹配」与「密文损坏」，并给出可操作提示
import { CryptoError, Keyring, decryptSecret, encryptSecret, type KeyPurpose } from "./crypto.ts";
import type { Logger } from "../lib/logger.ts";

export type VaultField = "password" | "cookie" | "proxy_password" | "notify_secret";

const FIELD_PURPOSE: Record<VaultField, KeyPurpose> = {
  password: "credential",
  cookie: "cookie",
  proxy_password: "proxy",
  // 推送密钥（Server酱 SendKey 等）与游戏凭证同等敏感：泄漏即可被人冒名推送
  notify_secret: "proxy",
};

export type DecryptOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "key_mismatch" | "corrupt"; message: string };

export class CredentialVault {
  private keyring: Keyring;
  private log: Logger | null;

  constructor(masterKey: Buffer, log?: Logger) {
    this.keyring = new Keyring(masterKey);
    this.log = log ?? null;
  }

  get keyVersion(): string {
    return this.keyring.currentVersion;
  }

  /** 加密并返回可直接入库的字符串 */
  seal(plaintext: string, userId: string, field: VaultField): string {
    return encryptSecret(plaintext, this.keyring, FIELD_PURPOSE[field], userId, field);
  }

  /**
   * 解密。不抛异常 —— 返回结构化结果，让调用方决定怎么呈现给用户。
   * 这一点很关键：凭证解不开时，UI 要明确说「MASTER_KEY 与数据不匹配」，
   * 而不是表现为「账号突然登不上」。
   */
  open(payload: string | null | undefined, userId: string, field: VaultField): DecryptOutcome {
    if (!payload) return { ok: false, reason: "empty", message: "未设置" };
    try {
      const value = decryptSecret(payload, this.keyring, FIELD_PURPOSE[field], userId, field);
      return { ok: true, value };
    } catch (err) {
      if (err instanceof CryptoError) {
        if (err.code === "MASTER_KEY_MISMATCH") {
          return {
            ok: false,
            reason: "key_mismatch",
            message: "凭证是用另一把 MASTER_KEY 加密的，当前密钥无法解开。请使用与数据匹配的 MASTER_KEY。",
          };
        }
        if (err.code === "DECRYPT_FAILED") {
          return {
            ok: false,
            reason: "key_mismatch",
            message: "凭证解密失败（MASTER_KEY 与数据不一致，或密文被破坏）。请确认 MASTER_KEY 与写入时相同。",
          };
        }
        return { ok: false, reason: "corrupt", message: `凭证格式异常：${err.message}` };
      }
      this.log?.warn("凭证", `解密出现意外错误：${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: "corrupt", message: "凭证解密异常" };
    }
  }

  /** 需要「要么拿到明文、要么明确失败」时用这个（解不开就抛） */
  openOrThrow(payload: string, userId: string, field: VaultField): string {
    const r = this.open(payload, userId, field);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  }

  /** 校验一段密文是否属于该用户（用于诊断，不返回明文） */
  canOpen(payload: string | null | undefined, userId: string, field: VaultField): boolean {
    return this.open(payload, userId, field).ok;
  }

  /**
   * 密钥轮换：把一批密文用当前密钥版本重写。
   * 只做「读旧写新」，不落地 UI；由 CLI 脚本驱动。
   */
  rotatePayloads(
    items: { id: string; userId: string; field: VaultField; payload: string | null }[],
  ): { rotated: { id: string; field: VaultField; payload: string }[]; failed: { id: string; field: VaultField; message: string }[] } {
    const rotated: { id: string; field: VaultField; payload: string }[] = [];
    const failed: { id: string; field: VaultField; message: string }[] = [];

    for (const it of items) {
      if (!it.payload) continue;
      const opened = this.open(it.payload, it.userId, it.field);
      if (!opened.ok) {
        failed.push({ id: it.id, field: it.field, message: opened.message });
        continue;
      }
      const next = this.seal(opened.value, it.userId, it.field);
      // 版本没变就不必写
      if (next !== it.payload) rotated.push({ id: it.id, field: it.field, payload: next });
    }
    return { rotated, failed };
  }
}

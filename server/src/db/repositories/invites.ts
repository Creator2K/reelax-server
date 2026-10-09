// 邀请码仓储
//
// 消费必须原子：`UPDATE ... WHERE used_count < max_uses` 的 changes === 1 才算成功，
// 否则并发注册会出现「一个邀请码被用两次」。
import { randomBytes } from "node:crypto";
import { BaseRepo, newId, nn, now } from "./base.ts";

export type InviteRow = {
  id: string;
  code: string;
  max_uses: number | null;
  used_count: number;
  expires_at: number | null;
  created_by: string | null;
  note: string | null;
  created_at: number;
};

/** 人类可读且不易混淆的邀请码（去掉 0/O/1/I/L） */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateInviteCode(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return out;
}

export class InvitesRepo extends BaseRepo {
  findById(id: string): InviteRow | undefined {
    return this.db.get<InviteRow>("SELECT * FROM invite_codes WHERE id = ?", id);
  }

  /** 大小写不敏感匹配（用户手输容易大小写混乱） */
  findByCode(code: string): InviteRow | undefined {
    return this.db.get<InviteRow>("SELECT * FROM invite_codes WHERE upper(code) = upper(?)", code.trim());
  }

  list(): InviteRow[] {
    return this.db.all<InviteRow>("SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT 200");
  }

  create(input: {
    code?: string;
    maxUses?: number | null;
    expiresAt?: number | null;
    createdBy?: string | null;
    note?: string | null;
  }): InviteRow {
    let code = (input.code ?? generateInviteCode()).trim().toUpperCase();
    // 极小概率碰撞：重试几次
    for (let i = 0; i < 5 && this.findByCode(code); i++) {
      code = generateInviteCode();
    }
    if (this.findByCode(code)) throw new Error("邀请码生成冲突，请重试");

    const id = newId();
    this.db.run(
      `INSERT INTO invite_codes (id, code, max_uses, used_count, expires_at, created_by, note, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      id,
      code,
      nn(input.maxUses),
      nn(input.expiresAt),
      nn(input.createdBy),
      nn(input.note),
      now(),
    );
    const row = this.findById(id);
    if (!row) throw new Error("创建邀请码后读取失败");
    return row;
  }

  /** 可用性判断（不消费） */
  isUsable(row: InviteRow, at = now()): { ok: true } | { ok: false; reason: string } {
    if (row.expires_at != null && Number(row.expires_at) <= at) return { ok: false, reason: "邀请码已过期" };
    if (row.max_uses != null && Number(row.used_count) >= Number(row.max_uses)) {
      return { ok: false, reason: "邀请码已用尽" };
    }
    return { ok: true };
  }

  /**
   * 原子消费一次。成功返回 true。
   * 用 `used_count < max_uses` 作为条件，避免并发下超发。
   */
  consume(code: string, at = now()): boolean {
    const res = this.db.run(
      `UPDATE invite_codes
          SET used_count = used_count + 1
        WHERE upper(code) = upper(?)
          AND (expires_at IS NULL OR expires_at > ?)
          AND (max_uses IS NULL OR used_count < max_uses)`,
      code.trim(),
      at,
    );
    return Number(res.changes) === 1;
  }

  delete(id: string): boolean {
    return Number(this.db.run("DELETE FROM invite_codes WHERE id = ?", id).changes) > 0;
  }

  /**
   * 回滚一次消费（注册流程在「已消费邀请码」之后失败时调用）。
   * 只减不小于 0，避免计数被刷到负数。
   */
  refund(code: string): boolean {
    const res = this.db.run(
      "UPDATE invite_codes SET used_count = used_count - 1 WHERE upper(code) = upper(?) AND used_count > 0",
      code.trim(),
    );
    return Number(res.changes) === 1;
  }

  /** 回收已用尽的邀请码（可选维护任务） */
  purgeExhausted(at = now()): number {
    return Number(
      this.db.run(
        "DELETE FROM invite_codes WHERE (expires_at IS NOT NULL AND expires_at <= ?) OR (max_uses IS NOT NULL AND used_count >= max_uses) AND created_at < ?",
        at,
        at - 30 * 86_400_000,
      ).changes,
    );
  }
}

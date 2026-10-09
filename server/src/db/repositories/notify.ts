// 推送通道仓储
//
// config_enc 是密文（Server酱的 SendKey / 微信的凭证目录与绑定目标），
// 列表查询不返回明文，只有真正要发消息时才解密。
import { BaseRepo, newId, nn, now } from "./base.ts";

export type NotifyKind = "serverchan" | "wechat";

export type NotifyStatus = "idle" | "starting" | "qrcode" | "scanned" | "online" | "bound" | "error";

export type NotifyRow = {
  id: string;
  user_id: string;
  kind: NotifyKind;
  label: string;
  enabled: number;
  config_enc: string | null;
  status: NotifyStatus;
  status_detail: string | null;
  target_id: string | null;
  target_label: string | null;
  qr_text: string | null;
  sent_count: number;
  last_sent_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  /** 绑定验证码（微信：等待用户回发以确认绑定） */
  verify_code: string | null;
  verify_expires_at: number | null;
  verify_attempts: number;
  /** 验证期间的临时接收人（通过后才写入 target_id） */
  pending_target_id: string | null;
};

export class NotifyRepo extends BaseRepo {
  findById(id: string): NotifyRow | undefined {
    return this.db.get<NotifyRow>("SELECT * FROM notify_channels WHERE id = ?", id);
  }

  /** ★ 归属校验：不属于该用户返回 undefined */
  findOwned(id: string, userId: string): NotifyRow | undefined {
    return this.db.get<NotifyRow>("SELECT * FROM notify_channels WHERE id = ? AND user_id = ?", id, userId);
  }

  listForUser(userId: string): NotifyRow[] {
    return this.db.all<NotifyRow>(
      "SELECT * FROM notify_channels WHERE user_id = ? ORDER BY created_at ASC",
      userId,
    );
  }

  /** 全量（服务启动时恢复微信登录用） */
  listAll(): NotifyRow[] {
    return this.db.all<NotifyRow>("SELECT * FROM notify_channels ORDER BY created_at ASC");
  }

  listEnabledByKind(kind: NotifyKind): NotifyRow[] {
    return this.db.all<NotifyRow>(
      "SELECT * FROM notify_channels WHERE kind = ? AND enabled = 1",
      kind,
    );
  }

  /** 该用户是否配置了至少一个「可用」的推送通道（日报据此决定是否可配置） */
  countUsable(userId: string): number {
    const r = this.db.get<{ c: number }>(
      "SELECT count(*) AS c FROM notify_channels WHERE user_id = ? AND enabled = 1 AND kind != ''",
      userId,
    );
    return Number(r?.c ?? 0);
  }

  create(input: {
    userId: string;
    kind: NotifyKind;
    label: string;
    enabled?: boolean;
    configEnc?: string | null;
  }): NotifyRow {
    const id = newId();
    const ts = now();
    this.db.run(
      `INSERT INTO notify_channels
         (id, user_id, kind, label, enabled, config_enc, status, sent_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, ?, ?)`,
      id,
      input.userId,
      input.kind,
      input.label.trim() || (input.kind === "serverchan" ? "Server酱" : "微信机器人"),
      input.enabled === false ? 0 : 1,
      nn(input.configEnc),
      ts,
      ts,
    );
    const row = this.findById(id);
    if (!row) throw new Error("创建推送通道后读取失败");
    return row;
  }

  /** 更新；configEnc 语义：undefined=不改、null=清空、字符串=覆盖 */
  update(
    id: string,
    userId: string,
    patch: {
      label?: string;
      enabled?: boolean;
      configEnc?: string | null;
      status?: NotifyStatus;
      statusDetail?: string | null;
      targetId?: string | null;
      targetLabel?: string | null;
      qrText?: string | null;
      lastError?: string | null;
    },
  ): NotifyRow | undefined {
    const cur = this.findOwned(id, userId);
    if (!cur) return undefined;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const push = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };

    if (patch.label !== undefined) push("label", patch.label.trim());
    if (patch.enabled !== undefined) push("enabled", patch.enabled ? 1 : 0);
    if (patch.configEnc !== undefined) push("config_enc", nn(patch.configEnc));
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.statusDetail !== undefined) push("status_detail", nn(patch.statusDetail));
    if (patch.targetId !== undefined) push("target_id", nn(patch.targetId));
    if (patch.targetLabel !== undefined) push("target_label", nn(patch.targetLabel));
    if (patch.qrText !== undefined) push("qr_text", nn(patch.qrText));
    if (patch.lastError !== undefined) push("last_error", nn(patch.lastError));

    if (!sets.length) return cur;
    push("updated_at", now());
    params.push(id, userId);
    this.db.run(`UPDATE notify_channels SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, ...params);
    return this.findById(id);
  }

  /** 运行时状态回写（微信登录回调里高频调用，不带 userId 校验） */
  setRuntime(
    id: string,
    patch: {
      status?: NotifyStatus;
      statusDetail?: string | null;
      qrText?: string | null;
      targetId?: string | null;
      targetLabel?: string | null;
      lastError?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.statusDetail !== undefined) {
      sets.push("status_detail = ?");
      params.push(nn(patch.statusDetail));
    }
    if (patch.qrText !== undefined) {
      sets.push("qr_text = ?");
      params.push(nn(patch.qrText));
    }
    if (patch.targetId !== undefined) {
      sets.push("target_id = ?");
      params.push(nn(patch.targetId));
    }
    if (patch.targetLabel !== undefined) {
      sets.push("target_label = ?");
      params.push(nn(patch.targetLabel));
    }
    if (patch.lastError !== undefined) {
      sets.push("last_error = ?");
      params.push(nn(patch.lastError));
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    params.push(now());
    params.push(id);
    this.db.run(`UPDATE notify_channels SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  /** 记录一次成功发送 */
  recordSent(id: string): void {
    this.db.run(
      "UPDATE notify_channels SET sent_count = sent_count + 1, last_sent_at = ?, updated_at = ? WHERE id = ?",
      now(),
      now(),
      id,
    );
  }

  /* ---------------- 绑定验证码 ---------------- */

  /**
   * 生成验证码：进入「等待用户回发验证码」状态。
   *
   * pendingTargetId 现在传 null —— 验证码由**网页端**生成（见 notify-service 的
   * bind-code 动作），不再绑定「谁先给机器人发消息」，所以没有「待定接收人」。
   */
  startVerification(
    id: string,
    input: { code: string; pendingTargetId: string | null; expiresAt: number; hint: string | null },
  ): void {
    this.db.run(
      `UPDATE notify_channels
         SET verify_code = ?, verify_expires_at = ?, verify_attempts = 0,
             pending_target_id = ?, status = 'online', status_detail = ?, qr_text = NULL,
             last_error = NULL, updated_at = ?
       WHERE id = ?`,
      input.code,
      input.expiresAt,
      input.pendingTargetId,
      input.hint,
      now(),
      id,
    );
  }

  /** 验证码输错：计数 +1（用于限制猜测次数） */
  bumpVerifyAttempts(id: string): void {
    this.db.run("UPDATE notify_channels SET verify_attempts = verify_attempts + 1 WHERE id = ?", id);
  }

  /** 验证通过：清掉验证码，正式写入接收人 */
  completeVerification(id: string, targetId: string, targetLabel: string | null): void {
    this.db.run(
      `UPDATE notify_channels
         SET target_id = ?, target_label = ?, status = 'bound', status_detail = NULL,
             verify_code = NULL, verify_expires_at = NULL, verify_attempts = 0,
             pending_target_id = NULL, last_error = NULL, updated_at = ?
       WHERE id = ?`,
      targetId,
      targetLabel,
      now(),
      id,
    );
  }

  /** 取消验证（解绑或重新登录时调用） */
  clearVerification(id: string, statusDetail: string | null = null): void {
    this.db.run(
      `UPDATE notify_channels
         SET verify_code = NULL, verify_expires_at = NULL, verify_attempts = 0,
             pending_target_id = NULL, status_detail = ?, updated_at = ?
       WHERE id = ?`,
      statusDetail,
      now(),
      id,
    );
  }

  delete(id: string, userId: string): boolean {
    return Number(this.db.run("DELETE FROM notify_channels WHERE id = ? AND user_id = ?", id, userId).changes) > 0;
  }

  countByUser(userId: string): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM notify_channels WHERE user_id = ?", userId);
    return Number(r?.c ?? 0);
  }
}

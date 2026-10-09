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

  delete(id: string, userId: string): boolean {
    return Number(this.db.run("DELETE FROM notify_channels WHERE id = ? AND user_id = ?", id, userId).changes) > 0;
  }

  countByUser(userId: string): number {
    const r = this.db.get<{ c: number }>("SELECT count(*) AS c FROM notify_channels WHERE user_id = ?", userId);
    return Number(r?.c ?? 0);
  }
}

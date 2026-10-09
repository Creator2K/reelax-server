// 迁移守卫测试
//
// ★ 这条测试是为了一个真实踩过的坑：
//   我把新表 notify_channels 直接写进了**已经发布过**的 0001_init，
//   结果全新安装正常，但**已有数据库永远不会执行**（那条迁移早已被标记为已应用），
//   启动时报 "no such table: notify_channels"。
//
//   规矩：迁移一旦发布就不能再改，新增表/字段必须追加新的迁移项。
//   这里用「SQL 校验和冻结」把这条规矩变成会失败的测试 ——
//   改了已发布的迁移，测试就会红，并告诉你要新建一条迁移。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/schema.ts";
import { openDb } from "../src/db/client.ts";

/**
 * 已发布迁移的 SQL 校验和（前 16 位）。
 *
 * 如果你改动了某个迁移的 SQL，这个测试会失败 —— 这是**有意的**：
 *  - 该迁移若已发布过：请改成**新增**一条迁移（追加数组项）
 *  - 该迁移确实还没发布给任何人：把这里对应的校验和更新为新的值
 */
const FROZEN_CHECKSUMS: Record<string, string> = {
  "0001_init": "e2c4ce3128efbf54",
  "0002_notify_channels": "c42fb6f1fab3c967",
};

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

describe("迁移的不可变性", () => {
  it("每个已发布的迁移 SQL 都没被改动过", () => {
    for (const m of MIGRATIONS) {
      const frozen = FROZEN_CHECKSUMS[m.id];
      if (frozen === undefined) {
        // 新迁移：提醒把它登记进来，否则下次改了也没人拦
        throw new Error(
          `迁移 ${m.id} 还没登记进 FROZEN_CHECKSUMS。请在本文件里加上它的校验和：\n  "${m.id}": "${checksum(m.sql)}",`,
        );
      }
      expect(checksum(m.sql), `迁移 ${m.id} 的 SQL 被改动了 —— 已发布的迁移不能修改，请新增一条迁移`).toBe(frozen);
    }
  });

  it("迁移 id 唯一且有序", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 按 id 字典序 == 数组顺序（0001 < 0002 < ...），保证应用顺序可预期
    expect([...ids].sort()).toEqual(ids);
  });

  it("每个迁移都有非空 SQL", () => {
    for (const m of MIGRATIONS) {
      expect(m.sql.trim().length, m.id).toBeGreaterThan(0);
    }
  });
});

describe("全新数据库能建出全部表", () => {
  it("所有业务表都存在（含后来的 notify_channels）", () => {
    const db = openDb(":memory:");
    try {
      const { applied } = db.migrate();
      expect(applied).toEqual(MIGRATIONS.map((m) => m.id));

      const tables = new Set(
        db
          .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .map((r) => r.name),
      );

      for (const t of [
        "_migrations",
        "users",
        "auth_sessions",
        "invite_codes",
        "proxies",
        "game_accounts",
        "account_modules",
        "logs",
        "account_stats_daily",
        "audit_events",
        // ★ 就是这条漏过：曾经写在 0001 里，已存在的库不会补建
        "notify_channels",
      ]) {
        expect(tables.has(t), `缺少表 ${t}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("★ 模拟「旧库升级」：只跑 0001 后再跑全部，必须补出新表", () => {
    const db = openDb(":memory:");
    try {
      // 手工只应用第一条（模拟一个已经在线上跑了旧版本的库）
      db.exec(`
        CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      `);
      const first = MIGRATIONS[0]!;
      db.exec(first.sql);
      db.run("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", first.id, Date.now());

      // 现在跑迁移：应当只应用「缺失的那些」，并把新表补出来
      const { applied } = db.migrate();
      expect(applied).not.toContain(first.id); // 已应用的不重跑
      expect(applied.length).toBeGreaterThan(0); // 但确实补了新迁移

      const has = db.get<{ c: number }>(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='notify_channels'",
      );
      expect(Number(has?.c)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("重复 migrate 幂等", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      expect(db.migrate().applied).toEqual([]);
    } finally {
      db.close();
    }
  });
});

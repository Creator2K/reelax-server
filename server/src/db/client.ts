// SQLite 客户端：连接、PRAGMA、迁移、备份、WAL 维护
//
// 用 Node 24 内置的 node:sqlite —— 零原生依赖，Alpine 镜像不需要 build toolchain。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS, MIGRATION_TABLE } from "./schema.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export class Db {
  readonly db: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.applyPragmas();
  }

  private applyPragmas(): void {
    // WAL 让读不阻塞写；busy_timeout 避免瞬时锁冲突直接抛错
    if (this.file !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA temp_store = MEMORY");
  }

  /** 迁移：先备份，再按 id 顺序应用未执行过的迁移（每个迁移一个事务） */
  migrate(): { applied: string[]; backup: string | null } {
    this.db.exec(MIGRATION_TABLE);
    const done = new Set(
      this.all<{ id: string }>("SELECT id FROM _migrations").map((r) => String(r.id)),
    );
    const pending = MIGRATIONS.filter((m) => !done.has(m.id));
    if (pending.length === 0) return { applied: [], backup: null };

    const backup = this.file === ":memory:" ? null : this.backupNow();

    const applied: string[] = [];
    for (const m of pending) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)").run(m.id, Date.now());
        this.db.exec("COMMIT");
        applied.push(m.id);
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* 回滚失败也要把原始错误抛出去 */
        }
        throw new Error(
          `迁移 ${m.id} 失败，数据库未改动（已保留备份 ${backup ?? "无"}）：\n${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { applied, backup };
  }

  /** 备份：VACUUM INTO 出一份一致快照，保留最近 3 份 */
  backupNow(keep = 3): string | null {
    if (this.file === ":memory:") return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(path.dirname(this.file), `reelax.db.bak-${stamp}`);
    try {
      // VACUUM INTO 需要目标不存在
      if (fs.existsSync(target)) fs.unlinkSync(target);
      this.db.prepare("VACUUM INTO ?").run(target);
    } catch (err) {
      console.error("[db] 备份失败：", err instanceof Error ? err.message : err);
      return null;
    }
    this.pruneBackups(keep);
    return target;
  }

  private pruneBackups(keep: number): void {
    try {
      const dir = path.dirname(this.file);
      const prefix = path.basename(this.file) + ".bak-";
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .sort()
        .reverse();
      for (const f of files.slice(keep)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* 清理失败不影响启动 */
        }
      }
    } catch {
      /* 目录不可读则跳过 */
    }
  }

  /** WAL 定期 truncate，防 WAL 无界增长 */
  checkpoint(): void {
    if (this.file === ":memory:") return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* checkpoint 失败不影响运行 */
    }
  }

  /* ---------- 查询封装 ---------- */

  run(sql: string, ...params: SqlValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    // node:sqlite 的 all() 返回 Record<string, SQLValue>[]，这里断言为目标行类型。
    // 调用方负责保证 sql 与 T 匹配（仓储层是唯一入口，可控）。
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** 事务包装（同步回调，与 node:sqlite 的同步 API 匹配） */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 保留原始错误 */
      }
      throw err;
    }
  }

  /** FTS5 可用性（日志搜索降级用） */
  hasFts5(): boolean {
    try {
      const r = this.get<{ fts: number }>("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts");
      return Number(r?.fts) === 1;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.checkpoint();
    } catch {
      /* 关闭前 checkpoint 失败无需处理 */
    }
    this.db.close();
  }
}

export function openDb(file: string): Db {
  return new Db(file);
}

// 数据库与仓储单测
//
// 重点覆盖两件事：
//  1) 迁移能建出完整 schema，且外键级联真的生效
//  2) 仓储的「按用户隔离」在 SQL 层就成立（不只是靠上层判断）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { createRepos, type Repos } from "../src/db/repositories/index.ts";

let db: Db;
let repos: Repos;

function makeUser(email: string, status: "pending" | "approved" | "banned" = "approved", role: "user" | "admin" = "user") {
  return repos.users.create({
    email,
    passwordHash: "scrypt$N=32768,r=8,p=1$c2FsdA$aGFzaA",
    displayName: email.split("@")[0] as string,
    role,
    status,
  });
}

beforeEach(() => {
  db = openDb(":memory:");
  db.migrate();
  repos = createRepos(db);
});

afterEach(() => {
  db.close();
});

describe("迁移", () => {
  it("建出全部业务表", () => {
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name)
      .sort();
    for (const t of [
      "_migrations",
      "account_modules",
      "account_stats_daily",
      "audit_events",
      "auth_sessions",
      "game_accounts",
      "invite_codes",
      "logs",
      "proxies",
      "users",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("重复迁移是幂等的", () => {
    const second = db.migrate();
    expect(second.applied).toEqual([]);
  });

  it("外键约束已开启", () => {
    // PRAGMA 返回的列名就是 foreign_keys，不是自定义别名
    const r = db.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(Number(r?.foreign_keys)).toBe(1);
  });

  it("FTS5 可用（日志搜索降级路径的前提）", () => {
    expect(db.hasFts5()).toBe(true);
  });
});

describe("users", () => {
  it("邮箱唯一且大小写不敏感", () => {
    makeUser("Alice@Example.com");
    expect(repos.users.existsEmail("alice@example.com")).toBe(true);
    expect(repos.users.existsEmail("ALICE@EXAMPLE.COM")).toBe(true);
    expect(repos.users.existsEmail("other@example.com")).toBe(false);
    expect(() => makeUser("ALICE@example.com")).toThrow();
  });

  it("countAdmins 只数未封禁的管理员", () => {
    const a = makeUser("a@x.com", "approved", "admin");
    makeUser("b@x.com", "approved", "admin");
    makeUser("c@x.com", "approved", "user");
    expect(repos.users.countAdmins()).toBe(2);
    repos.users.setStatus(a.id, "banned");
    expect(repos.users.countAdmins()).toBe(1);
  });

  it("setStatus 在 approved 时写入 approved_at", () => {
    const admin = makeUser("admin@x.com", "approved", "admin");
    const u = makeUser("p@x.com", "pending");
    expect(u.approved_at).toBeNull();
    repos.users.setStatus(u.id, "approved", admin.id);
    const after = repos.users.findById(u.id);
    expect(after?.status).toBe("approved");
    expect(after?.approved_by).toBe(admin.id);
    expect(after?.approved_at).toBeTypeOf("number");
  });

  it("approvedBy 指向不存在的用户时被拒（外键保护，避免脏引用）", () => {
    const u = makeUser("p3@x.com", "pending");
    expect(() => repos.users.setStatus(u.id, "approved", "no-such-admin")).toThrow(/FOREIGN KEY/i);
  });

  it("toPublic 不泄漏 password_hash", () => {
    const u = makeUser("h@x.com");
    const pub = JSON.stringify(repos.users.findById(u.id) ? { ...u } : {});
    expect(pub).toContain("password_hash"); // 原始行确实有
    const { password_hash: _h, ...rest } = u;
    expect(JSON.stringify(rest)).not.toContain("scrypt$");
  });
});

describe("auth_sessions", () => {
  it("只按 token_hash 命中，且过期会话查不出来", () => {
    const u = makeUser("s@x.com");
    const hash = "a".repeat(64);
    const s = repos.sessions.create({ userId: u.id, tokenHash: hash, ttlMs: 1000 });
    expect(repos.sessions.findValidByTokenHash(hash)?.id).toBe(s.id);

    // 时间推到过期之后
    expect(repos.sessions.findValidByTokenHash(hash, Date.now() + 5000)).toBeUndefined();
    expect(repos.sessions.findByTokenHash(hash)?.id).toBe(s.id); // 行还在，只是不 valid
  });

  it("purgeExpired 只删过期行", () => {
    const u = makeUser("p2@x.com");
    repos.sessions.create({ userId: u.id, tokenHash: "b".repeat(64), ttlMs: -1000 });
    repos.sessions.create({ userId: u.id, tokenHash: "c".repeat(64), ttlMs: 60_000 });
    expect(repos.sessions.purgeExpired()).toBe(1);
    expect(repos.sessions.listForUser(u.id)).toHaveLength(1);
  });

  it("extend 会把过期时间推后", () => {
    const u = makeUser("e@x.com");
    const s = repos.sessions.create({ userId: u.id, tokenHash: "d".repeat(64), ttlMs: 1000 });
    repos.sessions.extend(s.id, 60_000);
    expect(repos.sessions.findById(s.id)?.expires_at).toBeGreaterThan(s.expires_at);
  });

  it("删除用户会级联删除其会话", () => {
    const u = makeUser("cas@x.com");
    repos.sessions.create({ userId: u.id, tokenHash: "e".repeat(64), ttlMs: 60_000 });
    db.run("DELETE FROM users WHERE id = ?", u.id);
    expect(repos.sessions.listForUser(u.id)).toHaveLength(0);
  });
});

describe("invite_codes", () => {
  it("生成的码不含易混淆字符", () => {
    for (let i = 0; i < 30; i++) {
      const inv = repos.invites.create({});
      expect(inv.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/);
    }
  });

  it("可达使用上限后不可再用", () => {
    const inv = repos.invites.create({ maxUses: 2 });
    expect(repos.invites.consume(inv.code)).toBe(true);
    expect(repos.invites.consume(inv.code)).toBe(true);
    expect(repos.invites.consume(inv.code)).toBe(false);
    const after = repos.invites.findByCode(inv.code);
    expect(after?.used_count).toBe(2);
    expect(repos.invites.isUsable(after!).ok).toBe(false);
  });

  it("过期后不可用", () => {
    const inv = repos.invites.create({ expiresAt: Date.now() - 1 });
    expect(repos.invites.isUsable(inv).ok).toBe(false);
    expect(repos.invites.consume(inv.code)).toBe(false);
  });

  it("maxUses=null 表示不限次", () => {
    const inv = repos.invites.create({ maxUses: null });
    for (let i = 0; i < 5; i++) expect(repos.invites.consume(inv.code)).toBe(true);
    expect(repos.invites.isUsable(repos.invites.findByCode(inv.code)!).ok).toBe(true);
  });

  it("大小写与首尾空格容错", () => {
    const inv = repos.invites.create({});
    expect(repos.invites.findByCode(`  ${inv.code.toLowerCase()} `)?.id).toBe(inv.id);
    expect(repos.invites.consume(` ${inv.code.toLowerCase()} `)).toBe(true);
  });

  it("未知邀请码消费失败", () => {
    expect(repos.invites.consume("NOTEXIST00")).toBe(false);
  });
});

describe("proxies（用户隔离）", () => {
  it("findOwned 不返回别人的代理", () => {
    const a = makeUser("a2@x.com");
    const b = makeUser("b2@x.com");
    const p = repos.proxies.create({ userId: a.id, label: "p1", protocol: "http", host: "1.2.3.4", port: 8080 });

    expect(repos.proxies.findOwned(p.id, a.id)?.id).toBe(p.id);
    expect(repos.proxies.findOwned(p.id, b.id)).toBeUndefined();
    expect(repos.proxies.listForUser(b.id)).toHaveLength(0);
  });

  it("update 不能改别人的代理", () => {
    const a = makeUser("a3@x.com");
    const b = makeUser("b3@x.com");
    const p = repos.proxies.create({ userId: a.id, label: "p1", protocol: "socks5", host: "1.1.1.1", port: 1080 });
    expect(repos.proxies.update(p.id, b.id, { label: "hacked" })).toBeUndefined();
    expect(repos.proxies.findById(p.id)?.label).toBe("p1");
  });

  it("recordCheck 写入检测结果", () => {
    const a = makeUser("a4@x.com");
    const p = repos.proxies.create({ userId: a.id, label: "p", protocol: "http", host: "h", port: 1 });
    repos.proxies.recordCheck(p.id, { ok: true, latencyMs: 123, exitIp: "9.9.9.9", error: null });
    const after = repos.proxies.findById(p.id);
    expect(after?.last_check_ok).toBe(1);
    expect(after?.last_check_ms).toBe(123);
    expect(after?.last_exit_ip).toBe("9.9.9.9");
    expect(after?.last_check_at).toBeTypeOf("number");
  });

  it("删除代理会把账号的 proxy_id 置空（SET NULL）", () => {
    const a = makeUser("a5@x.com");
    const p = repos.proxies.create({ userId: a.id, label: "p", protocol: "http", host: "h", port: 1 });
    const acc = repos.accounts.create({
      userId: a.id,
      label: "acc",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
      proxyId: p.id,
    });
    expect(repos.proxies.boundAccountCount(p.id)).toBe(1);

    repos.proxies.delete(p.id, a.id);
    expect(repos.accounts.findById(acc.id)?.proxy_id).toBeNull();
  });

  it("删除用户级联删除其代理", () => {
    const a = makeUser("a6@x.com");
    repos.proxies.create({ userId: a.id, label: "p", protocol: "http", host: "h", port: 1 });
    db.run("DELETE FROM users WHERE id = ?", a.id);
    expect(repos.proxies.listForUser(a.id)).toHaveLength(0);
  });
});

describe("game_accounts（用户隔离与脱敏）", () => {
  it("listSafeForUser 不返回密文列", () => {
    const u = makeUser("ac@x.com");
    repos.accounts.create({
      userId: u.id,
      label: "acc",
      authType: "credentials",
      email: "g@x.com",
      passwordEnc: "v1.nonce.tag.ciphertext",
      baseUrl: "https://reelax.cn",
    });
    const row = repos.accounts.listSafeForUser(u.id)[0]!;
    expect(JSON.stringify(row)).not.toContain("ciphertext");
    expect(row.has_password).toBe(1);
    expect(row.has_cookie).toBe(0);
  });

  it("findCredentials 才返回密文，且限本人", () => {
    const u = makeUser("ac2@x.com");
    const other = makeUser("ac3@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "acc",
      authType: "credentials",
      email: "g@x.com",
      passwordEnc: "v1.aaa.bbb.ccc",
      baseUrl: "https://reelax.cn",
    });
    expect(repos.accounts.findCredentials(acc.id, u.id)?.passwordEnc).toBe("v1.aaa.bbb.ccc");
    expect(repos.accounts.findCredentials(acc.id, other.id)).toBeUndefined();
  });

  it("findSafe 与 update 都限本人", () => {
    const u = makeUser("ac4@x.com");
    const other = makeUser("ac5@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "acc",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });
    expect(repos.accounts.findSafe(acc.id, other.id)).toBeUndefined();
    expect(repos.accounts.update(acc.id, other.id, { label: "hacked" })).toBeUndefined();
    expect(repos.accounts.delete(acc.id, other.id)).toBe(false);
    expect(repos.accounts.findById(acc.id)?.label).toBe("acc");
  });

  it("update 的密文语义：undefined 不改、null 清空、字符串覆盖", () => {
    const u = makeUser("ac6@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "acc",
      authType: "credentials",
      email: "g@x.com",
      passwordEnc: "v1.keep.me.here",
      baseUrl: "https://reelax.cn",
    });

    // undefined = 不改
    repos.accounts.update(acc.id, u.id, { label: "renamed" });
    expect(repos.accounts.findById(acc.id)?.password_enc).toBe("v1.keep.me.here");

    // null = 清空
    repos.accounts.update(acc.id, u.id, { passwordEnc: null });
    expect(repos.accounts.findById(acc.id)?.password_enc).toBeNull();

    // 字符串 = 覆盖
    repos.accounts.update(acc.id, u.id, { passwordEnc: "v1.new.one.x" });
    expect(repos.accounts.findById(acc.id)?.password_enc).toBe("v1.new.one.x");
  });

  it("countForUser 用于配额判断", () => {
    const u = makeUser("ac7@x.com");
    for (let i = 0; i < 3; i++) {
      repos.accounts.create({
        userId: u.id,
        label: `acc${i}`,
        authType: "credentials",
        email: `g${i}@x.com`,
        baseUrl: "https://reelax.cn",
      });
    }
    expect(repos.accounts.countForUser(u.id)).toBe(3);
  });

  it("resetAllStatuses 复位脏状态", () => {
    const u = makeUser("ac8@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "acc",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });
    repos.accounts.setStatus(acc.id, "online");
    repos.accounts.resetAllStatuses();
    const after = repos.accounts.findById(acc.id);
    expect(after?.status).toBe("stopped");
    expect(after?.last_error).toBeNull();
  });

  it("listAutoStart 只返回 auto_start=1", () => {
    const u = makeUser("ac9@x.com");
    repos.accounts.create({
      userId: u.id,
      label: "on",
      authType: "credentials",
      email: "on@x.com",
      baseUrl: "https://reelax.cn",
      autoStart: true,
    });
    repos.accounts.create({
      userId: u.id,
      label: "off",
      authType: "credentials",
      email: "off@x.com",
      baseUrl: "https://reelax.cn",
      autoStart: false,
    });
    const rows = repos.accounts.listAutoStart();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBeTruthy();
  });
});

describe("account_modules", () => {
  it("upsert 部分更新：只改 enabled 不动 config", () => {
    const u = makeUser("m@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "a",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });

    repos.modules.upsert(acc.id, "keep-online", { enabled: true, config: { syncJitterMs: 600 } });
    repos.modules.upsert(acc.id, "keep-online", { enabled: false });

    const st = repos.modules.find(acc.id, "keep-online");
    expect(st?.enabled).toBe(false);
    expect(st?.config).toEqual({ syncJitterMs: 600 });
  });

  it("config 合并而不是替换", () => {
    const u = makeUser("m2@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "a",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });
    repos.modules.upsert(acc.id, "keep-online", { config: { a: 1, b: 2 } });
    repos.modules.upsert(acc.id, "keep-online", { config: { b: 3, c: 4 } });
    expect(repos.modules.find(acc.id, "keep-online")?.config).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("不存在的模块记录返回 null（表示用默认策略）", () => {
    const u = makeUser("m3@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "a",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });
    expect(repos.modules.find(acc.id, "never-set")).toBeNull();
    expect(repos.modules.has(acc.id, "never-set")).toBe(false);
  });

  it("删除账号级联删除模块配置", () => {
    const u = makeUser("m4@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "a",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });
    repos.modules.upsert(acc.id, "keep-online", { enabled: true });
    repos.accounts.delete(acc.id, u.id);
    expect(repos.modules.listForAccount(acc.id)).toHaveLength(0);
  });
});

describe("logs", () => {
  it("query 强制按 user_id 过滤（拿不到别人的日志）", () => {
    const a = makeUser("l1@x.com");
    const b = makeUser("l2@x.com");
    repos.logs.insert({ userId: a.id, tag: "系统", msg: "A 的日志", level: "info" });
    repos.logs.insert({ userId: b.id, tag: "系统", msg: "B 的日志", level: "info" });

    const forA = repos.logs.query(a.id);
    expect(forA).toHaveLength(1);
    expect(forA[0]?.msg).toBe("A 的日志");
    expect(repos.logs.query(b.id)).toHaveLength(1);
  });

  it("级别筛选只返回该级别及以上", () => {
    const u = makeUser("l3@x.com");
    for (const lv of ["debug", "info", "warn", "error"] as const) {
      repos.logs.insert({ userId: u.id, tag: "t", msg: lv, level: lv });
    }
    expect(repos.logs.query(u.id)).toHaveLength(4);
    expect(repos.logs.query(u.id, { minLevel: "info" })).toHaveLength(3);
    expect(repos.logs.query(u.id, { minLevel: "warn" })).toHaveLength(2);
    expect(repos.logs.query(u.id, { minLevel: "error" })).toHaveLength(1);
  });

  it("搜索命中 tag 或 msg", () => {
    const u = makeUser("l4@x.com");
    repos.logs.insert({ userId: u.id, tag: "保持在线", msg: "开始钓鱼", level: "info" });
    repos.logs.insert({ userId: u.id, tag: "卖鱼", msg: "已挂委托", level: "info" });
    expect(repos.logs.query(u.id, { search: "钓鱼" })).toHaveLength(1);
    expect(repos.logs.query(u.id, { search: "卖鱼" })).toHaveLength(1);
    expect(repos.logs.query(u.id, { search: "不存在" })).toHaveLength(0);
  });

  it("trimForUser 把条数压到上限内", () => {
    const u = makeUser("l5@x.com");
    for (let i = 0; i < 50; i++) {
      repos.logs.insert({ userId: u.id, tag: "t", msg: `m${i}`, level: "info", createdAt: 1000 + i });
    }
    expect(repos.logs.countForUser(u.id)).toBe(50);
    repos.logs.trimForUser(u.id, 20);
    expect(repos.logs.countForUser(u.id)).toBeLessThanOrEqual(20);
  });

  it("deleteOlderThan 按时间清理", () => {
    const u = makeUser("l6@x.com");
    repos.logs.insert({ userId: u.id, tag: "t", msg: "old", level: "info", createdAt: 100 });
    repos.logs.insert({ userId: u.id, tag: "t", msg: "new", level: "info", createdAt: 10_000 });
    expect(repos.logs.deleteOlderThan(5000)).toBe(1);
    expect(repos.logs.query(u.id)).toHaveLength(1);
  });

  it("删除用户后日志由显式清理移除（logs.user_id 故意不设外键）", () => {
    // 为什么 logs.user_id 不做外键：日终清理与管理员排查都希望日志比用户活得久一点。
    // 因此删用户时必须显式调用 deleteForUser（删除用户的 service 会调）。
    const u = makeUser("l7@x.com");
    repos.logs.insert({ userId: u.id, tag: "t", msg: "x", level: "info" });
    expect(repos.logs.query(u.id)).toHaveLength(1);
    db.run("DELETE FROM users WHERE id = ?", u.id);
    expect(repos.logs.query(u.id)).toHaveLength(1); // 仍在
    expect(repos.logs.deleteForUser(u.id)).toBe(1); // 显式清理
    expect(repos.logs.query(u.id)).toHaveLength(0);
  });
});

describe("account_stats_daily", () => {
  it("同日累加", () => {
    const u = makeUser("st@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "a",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });
    repos.stats.add(acc.id, u.id, { casts: 10, fish: 5, gold: 100, experience: 50 }, "2026-01-01");
    repos.stats.add(acc.id, u.id, { casts: 3, fish: 2, gold: 20, experience: 10 }, "2026-01-01");
    const row = repos.stats.get(acc.id, "2026-01-01");
    expect(row?.casts).toBe(13);
    expect(row?.fish).toBe(7);
    expect(row?.gold).toBe(120);
    expect(row?.experience).toBe(60);
  });

  it("不同日分开记", () => {
    const u = makeUser("st2@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "a",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });
    repos.stats.add(acc.id, u.id, { casts: 1 }, "2026-01-01");
    repos.stats.add(acc.id, u.id, { casts: 2 }, "2026-01-02");
    expect(repos.stats.listForUser(u.id)).toHaveLength(2);
    expect(repos.stats.listForUser(u.id, { from: "2026-01-02" })).toHaveLength(1);
  });

  it("net_gold 用 income - baitCost，缺 income 时退回 gold", () => {
    const u = makeUser("st3@x.com");
    const acc = repos.accounts.create({
      userId: u.id,
      label: "a",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });
    repos.stats.add(acc.id, u.id, { income: 1000, baitCost: 200 }, "2026-02-01");
    expect(repos.stats.get(acc.id, "2026-02-01")?.net_gold).toBe(800);
    repos.stats.add(acc.id, u.id, { gold: 500 }, "2026-02-02");
    expect(repos.stats.get(acc.id, "2026-02-02")?.net_gold).toBe(500);
  });

  it("sumForUserDay 汇总当天全部账号", () => {
    const u = makeUser("st4@x.com");
    const a1 = repos.accounts.create({
      userId: u.id,
      label: "a1",
      authType: "credentials",
      email: "1@x.com",
      baseUrl: "https://reelax.cn",
    });
    const a2 = repos.accounts.create({
      userId: u.id,
      label: "a2",
      authType: "credentials",
      email: "2@x.com",
      baseUrl: "https://reelax.cn",
    });
    repos.stats.add(a1.id, u.id, { casts: 5, gold: 50 }, "2026-03-01");
    repos.stats.add(a2.id, u.id, { casts: 7, gold: 70 }, "2026-03-01");
    const sum = repos.stats.sumForUserDay(u.id, "2026-03-01");
    expect(sum.casts).toBe(12);
    expect(sum.gold).toBe(120);
  });

  it("listForUser 不返回别人的统计", () => {
    const a = makeUser("st5@x.com");
    const b = makeUser("st6@x.com");
    const acc = repos.accounts.create({
      userId: a.id,
      label: "a",
      authType: "credentials",
      email: "g@x.com",
      baseUrl: "https://reelax.cn",
    });
    repos.stats.add(acc.id, a.id, { casts: 9 });
    expect(repos.stats.listForUser(b.id)).toHaveLength(0);
  });
});

describe("audit_events", () => {
  it("记录并可查询，detail 序列化为 JSON", () => {
    const u = makeUser("au@x.com");
    repos.audit.record({ userId: u.id, action: "account.created", target: "acc-1", detail: { label: "测试" }, ip: "1.2.3.4" });
    const rows = repos.audit.listForUser(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("account.created");
    expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toEqual({ label: "测试" });
    expect(rows[0]?.ip).toBe("1.2.3.4");
  });

  it("detail 无法序列化时不抛错", () => {
    const u = makeUser("au2@x.com");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => repos.audit.record({ userId: u.id, action: "x", detail: circular })).not.toThrow();
  });

  it("删除用户后审计记录保留（user_id 未设外键，便于追责）", () => {
    const u = makeUser("au3@x.com");
    repos.audit.record({ userId: u.id, action: "auth.login.ok" });
    db.run("DELETE FROM users WHERE id = ?", u.id);
    expect(repos.audit.countAll()).toBe(1);
  });
});

describe("localDay", async () => {
  const { localDay } = await import("../src/db/repositories/stats.ts");
  it("格式为 YYYY-MM-DD", () => {
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localDay(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

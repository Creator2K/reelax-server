// 运行时设置测试
//
// 这组测试守的是两条容易出错的语义：
//  1) 环境变量只提供**初始值** —— 重启不能把运维在后台改的值冲掉
//  2) 改动要**立即生效** —— 早期实现把并发上限存成常量，必须重启才生效
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.ts";
import type { Env } from "../src/env.ts";
import { SettingsService, SETTING_DEFS } from "../src/services/settings-service.ts";

/** 只填 SettingsService 需要的字段 */
function makeEnv(over: Partial<Env> = {}): Env {
  return {
    sessionTtlDays: 30,
    maxAccountsPerUser: 5,
    maxRunningAccounts: 50,
    allowRegistration: true,
    logRetentionDays: 14,
    ...over,
  } as Env;
}

describe("SettingsService · 初始值来自环境变量", () => {
  it("首次启动把环境变量的值写进库", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const s = new SettingsService(db, makeEnv({ maxAccountsPerUser: 3, maxRunningAccounts: 20 }));
      expect(s.get("maxAccountsPerUser")).toBe(3);
      expect(s.get("maxRunningAccounts")).toBe(20);
      expect(s.get("allowRegistration")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("★ 重启不覆盖已改过的值（环境变量只是初始值）", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const first = new SettingsService(db, makeEnv({ maxAccountsPerUser: 5 }));
      first.update({ maxAccountsPerUser: 8 }, "admin-1");

      // 模拟重启：新建一个服务实例，环境变量里仍是旧值 5
      const second = new SettingsService(db, makeEnv({ maxAccountsPerUser: 5 }));
      expect(second.get("maxAccountsPerUser")).toBe(8);
      expect(second.isOverridden("maxAccountsPerUser")).toBe(true);
      expect(second.envValue("maxAccountsPerUser")).toBe(5);
    } finally {
      db.close();
    }
  });

  it("仍等于初始值时不标记为「已改动」", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const s = new SettingsService(db, makeEnv({ maxRunningAccounts: 50 }));
      expect(s.isOverridden("maxRunningAccounts")).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("SettingsService · 写入与校验", () => {
  it("写入后立即生效，并回报实际改动的键", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const s = new SettingsService(db, makeEnv());
      const changed = s.update({ maxAccountsPerUser: 10, allowRegistration: false }, "admin-1");
      expect(changed.sort()).toEqual(["allowRegistration", "maxAccountsPerUser"]);
      expect(s.get("maxAccountsPerUser")).toBe(10);
      expect(s.get("allowRegistration")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("值没变化时不算改动", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const s = new SettingsService(db, makeEnv({ maxAccountsPerUser: 5 }));
      expect(s.update({ maxAccountsPerUser: 5 }, null)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("★ 非法值被拒绝（并发上限不能是 0 或负数）", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const s = new SettingsService(db, makeEnv());
      expect(() => s.update({ maxRunningAccounts: 0 }, null)).toThrow();
      expect(() => s.update({ maxRunningAccounts: -1 }, null)).toThrow();
      expect(() => s.update({ maxRunningAccounts: 1.5 }, null)).toThrow();
      expect(() => s.update({ maxRunningAccounts: 99999 }, null)).toThrow();
      // 值没被写坏
      expect(s.get("maxRunningAccounts")).toBe(50);
    } finally {
      db.close();
    }
  });

  it("类型不对（把布尔值填进数字项）会被拒绝", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const s = new SettingsService(db, makeEnv());
      expect(() => s.update({ maxAccountsPerUser: true }, null)).toThrow();
      expect(() => s.update({ allowRegistration: "yes" }, null)).toThrow();
    } finally {
      db.close();
    }
  });

  it("未知设置项报错，而不是静默忽略", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const s = new SettingsService(db, makeEnv());
      expect(() => s.update({ notASetting: 1 } as never, null)).toThrow(/未知设置项/);
    } finally {
      db.close();
    }
  });

  it("变更会通知订阅者（注册表据此立刻用新上限）", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const s = new SettingsService(db, makeEnv());
      const seen: number[] = [];
      const off = s.onChange((v) => seen.push(v.maxRunningAccounts));
      s.update({ maxRunningAccounts: 7 }, null);
      expect(seen).toEqual([7]);
      off();
      s.update({ maxRunningAccounts: 9 }, null);
      expect(seen).toEqual([7]); // 退订后不再收到
    } finally {
      db.close();
    }
  });
});

describe("SettingsService · 容错", () => {
  it("库里存了坏 JSON / 已下线的键时不崩，退回默认值", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      new SettingsService(db, makeEnv());
      // 手工写坏一条 + 加一条不认识的键
      db.run("UPDATE app_settings SET value = ? WHERE key = ?", "{坏掉的", "maxRunningAccounts");
      db.run(
        "INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)",
        "removedSetting",
        "123",
        Date.now(),
      );

      const s = new SettingsService(db, makeEnv({ maxRunningAccounts: 50 }));
      expect(s.get("maxRunningAccounts")).toBe(50); // 退回环境变量值
    } finally {
      db.close();
    }
  });

  it("describe() 给出界面需要的全部字段", () => {
    const db = openDb(":memory:");
    try {
      db.migrate();
      const s = new SettingsService(db, makeEnv({ maxAccountsPerUser: 4 }));
      s.update({ maxAccountsPerUser: 9 }, null);
      const items = s.describe();

      expect(items.length).toBe(Object.keys(SETTING_DEFS).length);
      const quota = items.find((i) => i.key === "maxAccountsPerUser");
      expect(quota?.value).toBe(9);
      expect(quota?.envValue).toBe(4);
      expect(quota?.overridden).toBe(true);
      expect(quota?.type).toBe("number");
      expect(quota?.label).toBeTruthy();
      expect(quota?.hint).toBeTruthy();

      const reg = items.find((i) => i.key === "allowRegistration");
      expect(reg?.type).toBe("boolean");
    } finally {
      db.close();
    }
  });

  it("每个设置项都有标签、说明与类型（防止新增时漏填）", () => {
    for (const [key, def] of Object.entries(SETTING_DEFS)) {
      expect(def.label, key).toBeTruthy();
      expect(def.hint, key).toBeTruthy();
      expect(["boolean", "number"], key).toContain(def.type);
    }
  });
});

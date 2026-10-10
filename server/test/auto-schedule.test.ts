// 定时挂机：时间表语义 + 服务端调度器
//
// 这块的风险最高（它会真的启停账号），所以把三条语义都钉死：
//   1) 只在**跨过新的一档**时执行一次 —— 否则用户手动点「停止」会在半分钟内被拉起来
//   2) 服务重启后按当前档重新对齐一次 —— 否则该跑的时候可能一直不跑
//   3) 启动失败要退避（凭证过期不该每 30 秒撞一次）
import { describe, expect, it } from "vitest";
import { buildFullApp } from "./helpers/full-app.ts";
import type { ModuleContext } from "../src/modules/types.ts";
import autoSchedule from "../src/modules/auto-schedule/index.ts";
import { parseSchedulePlan, describeSchedulePlan } from "../src/modules/auto-schedule/plan.ts";
import { milestoneOccurrence } from "../src/modules/shared/schedule.ts";
import {
  AccountScheduleService,
  SCHEDULE_RETRY_MS,
  type ScheduleLogger,
  type ScheduleRegistry,
} from "../src/services/account-schedule-service.ts";
import type { AccountStatus } from "../src/game/account-runtime.ts";

const at = (h: number, m = 0, day = 10): Date => new Date(2026, 9, day, h, m, 0, 0);

describe("时间表语义（与「航线助手调度」共用解析）", () => {
  it("解析 on / off 与中英文写法", () => {
    const { entries } = parseSchedulePlan("08:00 on\n20:00 关");
    expect(entries.map((e) => [e.at, e.on])).toEqual([
      ["08:00", true],
      ["20:00", false],
    ]);
  });

  it("非法行报错但不影响其它行", () => {
    const { entries, errors } = parseSchedulePlan("08:00 on\n09:00 随便\n10:00 off");
    expect(entries).toHaveLength(2);
    expect(errors[0]).toContain("只能写 on / off");
  });

  it("预览标出「现在生效」的那一条", () => {
    const lines = describeSchedulePlan("08:00 on\n20:00 off", at(12), "Asia/Shanghai");
    expect(lines[0]).toContain("Asia/Shanghai");
    expect(lines[1]).toContain("08:00 起 → 启动账号");
    expect(lines[1]).toContain("← 现在生效");
    expect(lines[2]).toContain("20:00 起 → 停止账号");
  });

  it("★ 里程碑时刻：当天已过用当天，还没到用昨天", () => {
    const entry = parseSchedulePlan("08:00 on").entries[0]!;
    expect(milestoneOccurrence(entry, at(9))).toBe(at(8).getTime());
    expect(milestoneOccurrence(entry, at(7))).toBe(at(8, 0, 9).getTime()); // 昨天 08:00
    expect(milestoneOccurrence(entry, at(8))).toBe(at(8).getTime()); // 正好到点算今天
  });
});

/* ==================== 调度器 ==================== */

function makeSvc(opts: {
  rows: Array<{ accountId: string; config: Record<string, unknown> }>;
  status?: Record<string, AccountStatus>;
  startError?: Error;
  stopError?: Error;
}) {
  const log = { info: [] as string[], warn: [] as string[] };
  const started: string[] = [];
  const stopped: string[] = [];
  const listCalls: Array<{ moduleId: string; enabledOnly?: boolean }> = [];
  const status: Record<string, AccountStatus> = { ...(opts.status ?? {}) };

  const logger: ScheduleLogger & { child: () => unknown } = {
    info: (_t: string, m: string) => log.info.push(m),
    warn: (_t: string, m: string) => log.warn.push(m),
    child: () => logger,
  };

  const repos = {
    modules: {
      listByModule: (moduleId: string, o?: { enabledOnly?: boolean }) => {
        listCalls.push({ moduleId, enabledOnly: o?.enabledOnly });
        return opts.rows.map((r) => ({
          accountId: r.accountId,
          moduleId: "auto-schedule",
          enabled: true,
          config: r.config,
          updatedAt: 0,
        }));
      },
    },
    accounts: {
      findById: (id: string) => ({ id, user_id: "u1", label: `账号 ${id}` }),
    },
  };

  const registry: ScheduleRegistry = {
    statusOf: (id: string) => status[id] ?? "stopped",
    start: async (id: string) => {
      started.push(id);
      if (opts.startError) throw opts.startError;
      status[id] = "online";
    },
    stop: async (id: string) => {
      stopped.push(id);
      if (opts.stopError) throw opts.stopError;
      status[id] = "stopped";
    },
  };

  const svc = new AccountScheduleService({
    repos: repos as never,
    registry,
    logger: logger as never,
  });
  return { svc, started, stopped, log, status, listCalls };
}

const PLAN = { plan: "08:00 on\n20:00 off" };

describe("AccountScheduleService", () => {
  it("★ 只读「定时挂机」模块里已启用的行（账号停着也要读得到）", async () => {
    const { svc, listCalls } = makeSvc({ rows: [{ accountId: "a1", config: PLAN }] });
    await svc.tick(at(9));
    expect(listCalls).toEqual([{ moduleId: "auto-schedule", enabledOnly: true }]);
  });

  it("★ 到「on」那一档启动账号，到「off」那一档停止", async () => {
    const { svc, started, stopped, status } = makeSvc({ rows: [{ accountId: "a1", config: PLAN }] });

    await svc.tick(at(9)); // 08:00 那档
    expect(started).toEqual(["a1"]);
    expect(status.a1).toBe("online");

    await svc.tick(at(21)); // 20:00 那档
    expect(stopped).toEqual(["a1"]);
    expect(status.a1).toBe("stopped");
  });

  it("★ 同一档内不重复执行（每 30 秒扫一次也不会反复启停）", async () => {
    const { svc, started, stopped } = makeSvc({ rows: [{ accountId: "a1", config: PLAN }] });

    await svc.tick(at(9, 0));
    await svc.tick(at(9, 1));
    await svc.tick(at(9, 30));
    expect(started).toHaveLength(1);
    expect(stopped).toHaveLength(0);
  });

  it("★ 两档之间手动停止会被尊重（不会半分钟又被拉起来）", async () => {
    const { svc, started, status } = makeSvc({ rows: [{ accountId: "a1", config: PLAN }] });

    await svc.tick(at(9)); // 时间表启动
    status.a1 = "stopped"; // 用户手动停止
    await svc.tick(at(10));
    await svc.tick(at(11));
    expect(started).toHaveLength(1); // 没有第二次启动
  });

  it("★ 服务重启（记忆为空）后按当前档重新对齐一次", async () => {
    const { svc, started } = makeSvc({ rows: [{ accountId: "a1", config: PLAN }] });
    // 10:00 那档应当是"运行中"，但账号是停的 → 拉起来
    await svc.tick(at(10));
    expect(started).toEqual(["a1"]);
  });

  it("已经是该有的状态就不做无意义操作（但记住这一档）", async () => {
    const { svc, started, stopped } = makeSvc({
      rows: [{ accountId: "a1", config: PLAN }],
      status: { a1: "online" },
    });
    await svc.tick(at(9));
    expect(started).toHaveLength(0);
    expect(stopped).toHaveLength(0);

    await svc.tick(at(21)); // off 档，账号却在跑 → 停
    expect(stopped).toEqual(["a1"]);
  });

  it("凌晨沿用昨天的最后一档", async () => {
    const { svc, stopped } = makeSvc({
      rows: [{ accountId: "a1", config: PLAN }],
      status: { a1: "online" },
    });
    await svc.tick(at(3)); // 昨天的 20:00 → off
    expect(stopped).toEqual(["a1"]);
  });

  it("时间表为空 / 模块未配置时什么都不做", async () => {
    const empty = makeSvc({ rows: [{ accountId: "a1", config: { plan: "" } }] });
    await empty.svc.tick(at(9));
    expect(empty.started).toEqual([]);
    expect(empty.stopped).toEqual([]);

    const none = makeSvc({ rows: [] });
    await none.svc.tick(at(9));
    expect(none.started).toEqual([]);
  });

  it("演练模式只记录，不启停", async () => {
    const { svc, started, stopped, log } = makeSvc({
      rows: [{ accountId: "a1", config: { ...PLAN, dryRun: true } }],
    });
    await svc.tick(at(9));
    await svc.tick(at(21));
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
    expect(log.info.filter((m) => m.includes("[演练]"))).toHaveLength(2);
  });

  it("★ 启动失败：警告一次 + 5 分钟冷却，之后重试", async () => {
    const err = new Error("邮箱或口令不正确");
    const { svc, started, log } = makeSvc({ rows: [{ accountId: "a1", config: PLAN }], startError: err });

    await svc.tick(at(9));
    await svc.tick(at(9, 1)); // 冷却期内 → 不再尝试
    expect(started).toHaveLength(1);
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toContain("启动账号失败");

    // 冷却过后重试：把失败时间往前挪（判定只看传入的 now，所以直接改内部记录）
    const failedAt = (svc as unknown as { failedAt: Map<string, number> }).failedAt;
    failedAt.set("a1", at(9).getTime() - SCHEDULE_RETRY_MS - 1);
    await svc.tick(at(9, 30));
    expect(started).toHaveLength(2);
    expect(log.warn).toHaveLength(1); // 同一档只警告一次
  });

  it("停止失败只记一条警告，不影响其它账号", async () => {
    const { svc, log, stopped } = makeSvc({
      rows: [
        { accountId: "a1", config: PLAN },
        { accountId: "a2", config: PLAN },
      ],
      status: { a1: "online", a2: "online" },
      stopError: new Error("停不下来"),
    });
    await svc.tick(at(21));
    expect(stopped).toEqual(["a1", "a2"]);
    expect(log.warn.filter((m) => m.includes("停止账号失败"))).toHaveLength(2);
  });

  it("★ 上一轮还没扫完时不再重入（账号多、启动慢时两轮会叠在一起）", async () => {
    const { svc, listCalls } = makeSvc({ rows: [{ accountId: "a1", config: PLAN }] });
    const first = svc.tick(at(9));
    const second = svc.tick(at(9)); // 第一次还没扫完（等 registry.start）
    await Promise.all([first, second]);
    expect(listCalls).toHaveLength(1);
  });

  it("多个账号各按自己的时间表走", async () => {
    const { svc, started, stopped } = makeSvc({
      rows: [
        { accountId: "a1", config: { plan: "08:00 on\n20:00 off" } },
        { accountId: "a2", config: { plan: "10:00 on\n22:00 off" } },
      ],
      status: { a2: "online" },
    });
    await svc.tick(at(9)); // a1 的 08:00 档（启动）；a2 还在昨天的 22:00 档（off）→ 但 a2 在跑 → 停
    expect(started).toEqual(["a1"]);
    expect(stopped).toEqual(["a2"]);
  });
});

describe("定时挂机模块（配置入口）", () => {
  it("启动时把时间表讲清楚，并说明启停由服务端执行", async () => {
    const log = { info: [] as string[], warn: [] as string[] };
    const ctx = {
      moduleId: "auto-schedule",
      config: { plan: "08:00 on\n20:00 off", dryRun: false },
      state: {},
      log: {
        debug: () => {},
        info: (_t: string, m: string) => log.info.push(m),
        warn: (_t: string, m: string) => log.warn.push(m),
        error: (_t: string, m: string) => log.warn.push(m),
      },
      api: {},
      account: {},
      on: () => () => {},
      every: () => ({}) as NodeJS.Timeout,
      schedule: () => ({}) as NodeJS.Timeout,
    } as unknown as ModuleContext;

    await autoSchedule.onStart!(ctx);
    expect(log.info.some((m) => m.includes("时间表 2 条") && m.includes("08:00→开"))).toBe(true);
    expect(log.info.some((m) => m.includes("启停由服务端执行"))).toBe(true);
    expect(log.warn).toEqual([]);
  });

  it("时间表为空时明确说明不会启停", async () => {
    const log = { info: [] as string[], warn: [] as string[] };
    const ctx = {
      moduleId: "auto-schedule",
      config: { plan: "  \n# 待定\n", dryRun: false },
      state: {},
      log: {
        debug: () => {},
        info: (_t: string, m: string) => log.info.push(m),
        warn: (_t: string, m: string) => log.warn.push(m),
        error: () => {},
      },
      api: {},
      account: {},
      on: () => () => {},
      every: () => ({}) as NodeJS.Timeout,
      schedule: () => ({}) as NodeJS.Timeout,
    } as unknown as ModuleContext;

    await autoSchedule.onStart!(ctx);
    expect(log.info.some((m) => m.includes("时间表为空"))).toBe(true);
  });
});

/* ==================== 端到端（真的接上 RunnerRegistry） ==================== */

/** 简易 proof：客户端只解析里面的 expiresAt */
const PROOF = `${Buffer.from(JSON.stringify({ version: 1, expiresAt: Date.now() + 3_600_000 })).toString("base64url")}.sig`;

/** 只实现启动账号必经的几个接口 */
function makeGameFetch() {
  const calls: string[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-arcane-request-proof": PROOF },
    });
  const impl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/api/me") return json({ player: { nickname: "测试", level: 1 } });
    if (path === "/api/auth/login") return json({ ok: true });
    if (path === "/api/fishing/state") return json({ run: { id: "r1", status: "stopped" } });
    if (path === "/api/fishing/start") {
      return json({
        run: {
          id: "r1",
          status: "running",
          totalCasts: 10,
          remainingCasts: 10,
          cycleDurationMs: 600_000,
          nextCastAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
    }
    return json({});
  };
  return { impl, calls };
}

describe("定时挂机 · 端到端", () => {
  it("★ 配好时间表后调度器真的会把账号启起来（走真实 RunnerRegistry）", async () => {
    const { impl } = makeGameFetch();
    const app = await buildFullApp({ fetchImpl: impl });
    try {
      const { id: userId } = app.seedApprovedUser("sched-e2e@example.com");
      const accountId = app.seedAccount(userId, "定时端到端");
      // 只在「模块已启用」时调度器才会看到这一行
      app.repos.modules.upsert(accountId, "auto-schedule", {
        enabled: true,
        config: { plan: "00:00 on" },
      });

      const svc = new AccountScheduleService({ repos: app.repos, registry: app.registry, logger: app.logger });
      expect(app.registry.statusOf(accountId)).toBe("stopped");

      await svc.tick(new Date());
      expect(app.registry.statusOf(accountId)).not.toBe("stopped");
      // 状态真的写进了库（账号页面显示的是这个）
      expect(app.repos.accounts.findById(accountId)?.status).not.toBe("stopped");

      // 同一档再来一次：不重复操作
      const before = app.registry.statusOf(accountId);
      await svc.tick(new Date());
      expect(app.registry.statusOf(accountId)).toBe(before);
    } finally {
      await app.close();
    }
  });

  it("★ 「off」那一档会把正在跑的账号停掉；模块没启用则完全不管", async () => {
    const { impl } = makeGameFetch();
    const app = await buildFullApp({ fetchImpl: impl });
    try {
      const { id: userId } = app.seedApprovedUser("sched-e2e2@example.com");
      const accountId = app.seedAccount(userId, "定时停");

      // 没启用模块 → 调度器看不到它
      const svc = new AccountScheduleService({ repos: app.repos, registry: app.registry, logger: app.logger });
      await app.registry.start(accountId);
      await svc.tick(new Date());
      expect(app.registry.statusOf(accountId)).not.toBe("stopped");

      // 启用「00:00 off」→ 下一档 tick 就该停
      app.repos.modules.upsert(accountId, "auto-schedule", { enabled: true, config: { plan: "00:00 off" } });
      await svc.tick(new Date());
      expect(app.registry.statusOf(accountId)).toBe("stopped");
    } finally {
      await app.close();
    }
  });
});

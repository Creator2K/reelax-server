// CDK 公共库：归一化 / 提交验证 / 一键兑换
//
// 规则：
//  · 提交前必须用自己的账号试领一次：无效 → 不入库；领到了 / 已领取过 → 入库；
//    未到可兑奖时间 → 入库并标记「未开始」；
//  · 码按账号可重复领 → 库里保留，任何人都能兑换；
//  · 兑换时发现失效 → 自动移出库（标记 exhausted）；
//  · 重复提交撞唯一约束。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import { classifyRedeemFailure, normalizeCdk } from "../src/services/cdk-service.ts";

const PROOF = `${Buffer.from(JSON.stringify({ version: 1, expiresAt: Date.now() + 3_600_000 })).toString("base64url")}.sig`;

/** 假游戏服务：/api/me 发 proof；兑换接口按 codeBehaviors 决定成败 */
type Behavior = { ok: true } | { errorCode: string } | { empty: true };
let behaviors = new Map<string, Behavior>();
let redeemCalls: string[] = [];

function makeFetch(): typeof fetch {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-arcane-request-proof": PROOF },
    });
  return async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/me") return json({ player: { nickname: "测试", level: 1 } });
    if (path === "/api/sponsorship/cdks/redeem-batch") {
      const codes = (JSON.parse(String(init?.body ?? "{}")) as { codes?: string[] }).codes ?? [];
      redeemCalls.push(...codes);
      for (const code of codes) {
        const b = behaviors.get(code.toUpperCase()) ?? behaviors.get("*");
        if (b && "errorCode" in b) {
          return new Response(JSON.stringify({ error: { code: b.errorCode, message: b.errorCode } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        // ★ 「这个账号已经领过」接口不报错：200 + 没有任何 redemptions
        if (b && "empty" in b) {
          return json({ redemptions: [], redeemedCount: 0, invalidCount: codes.length });
        }
      }
      return json({
        redemptions: codes.map(() => ({ rewards: { relics: 3000, fragments: 300, itemQuantity: 0 } })),
        redeemedCount: codes.length,
        invalidCount: 0,
      });
    }
    return json({});
  };
}

let app: FullApp;
let A: ReturnType<FullApp["seedApprovedUser"]>;
let B: ReturnType<FullApp["seedApprovedUser"]>;
let aAccount: string;
let bAccount: string;

beforeAll(async () => {
  app = await buildFullApp({ fetchImpl: makeFetch() });
  A = app.seedApprovedUser("cdk-a@example.com");
  B = app.seedApprovedUser("cdk-b@example.com");
  aAccount = app.seedAccount(A.id, "甲号");
  bAccount = app.seedAccount(B.id, "乙号");
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  behaviors = new Map();
  redeemCalls = [];
});

type ListBody = {
  items: { id: string; code: string; masked: boolean; status: string; reward: { relics?: number } | null; successCount: number }[];
  counts: { available: number; not_started: number; exhausted: number };
};

describe("normalizeCdk", () => {
  it("★ 大小写 / 空格 / 连字符归一化到同一个键", () => {
    for (const raw of ["moyu666", "MOYU666", "moyu 666", "moyu-666", " moyu666 "]) {
      expect(normalizeCdk(raw)?.normalized).toBe("MOYU666");
    }
  });

  it("拒绝控制字符、超长与非字母数字", () => {
    expect(normalizeCdk("")).toBeNull();
    expect(normalizeCdk("a".repeat(81))).toBeNull();
    expect(normalizeCdk("moyu\u0000666")).toBeNull();
    expect(normalizeCdk("中秋快乐")).toBeNull();
  });
});

describe("classifyRedeemFailure", () => {
  it("★ 已领取过 / 未开始 / 失效分开处理（决定入库还是丢弃）", () => {
    expect(classifyRedeemFailure("CDK_ALREADY_REDEEMED", "").kind).toBe("already");
    expect(classifyRedeemFailure("CDK_NOT_STARTED", "").kind).toBe("not-started");
    expect(classifyRedeemFailure("SPONSORSHIP_CODE_INVALID", "").kind).toBe("invalid");
    expect(classifyRedeemFailure("CDK_DISABLED", "").kind).toBe("invalid");
    expect(classifyRedeemFailure("CDK_USAGE_LIMIT_REACHED", "").kind).toBe("invalid");
    expect(classifyRedeemFailure("SOMETHING_NEW", "boom").kind).toBe("other");
  });
});

describe("提交与兑换（对着假游戏服务跑真实路由）", () => {
  it("★ 有效码：提交即入库（带实际到账奖励），重复提交被拒", async () => {
    const r = await app.post<{ results: { ok: boolean; status?: string; reward?: { relics?: number } }[] }>(
      "/api/cdk/submit",
      { accountId: aAccount, codes: ["moyu666"] },
      A.jar,
    );
    expect(r.status).toBe(200);
    expect(r.body.results[0]?.ok).toBe(true);
    expect(r.body.results[0]?.status).toBe("available");
    expect(r.body.results[0]?.reward?.relics).toBe(3000);

    // 再次提交同一个码（大小写不同也算重复）→ 被拒
    const again = await app.post<{ results: { ok: boolean; reason?: string }[] }>(
      "/api/cdk/submit",
      { accountId: aAccount, codes: ["MOYU-666"] },
      A.jar,
    );
    expect(again.body.results[0]?.ok).toBe(false);
    expect(again.body.results[0]?.reason).toContain("已经有");
  });

  it("★ 无效码不入库；未开始的码入库并标记 not_started", async () => {
    behaviors.set("BADCODE", { errorCode: "SPONSORSHIP_CODE_INVALID" });
    behaviors.set("FUTURE1", { errorCode: "CDK_NOT_STARTED" });

    const r = await app.post<{ results: { input: string; ok: boolean; status?: string; reason?: string }[] }>(
      "/api/cdk/submit",
      { accountId: aAccount, codes: ["BADCODE", "FUTURE1"] },
      A.jar,
    );
    const bad = r.body.results.find((x) => x.input === "BADCODE");
    const future = r.body.results.find((x) => x.input === "FUTURE1");
    expect(bad?.ok).toBe(false);
    expect(future?.ok).toBe(true);
    expect(future?.status).toBe("not_started");

    const list = await app.get<ListBody>("/api/cdk", A.jar);
    expect(list.body.items.some((i) => i.code === "BADCODE")).toBe(false);
    expect(list.body.items.find((i) => i.code === "FUTURE1")?.status).toBe("not_started");
  });

  it("★ 已领取过的码也入库（本账号领过不妨碍别人领）", async () => {
    behaviors.set("ALREADY1", { errorCode: "CDK_ALREADY_REDEEMED" });
    const r = await app.post<{ results: { ok: boolean; reason?: string }[] }>(
      "/api/cdk/submit",
      { accountId: aAccount, codes: ["ALREADY1"] },
      A.jar,
    );
    expect(r.body.results[0]?.ok).toBe(true);
    expect(r.body.results[0]?.reason).toContain("已领取");
  });

  it("★ 别人提交的码在列表里打码；自己提交的可见完整码", async () => {
    await app.post("/api/cdk/submit", { accountId: aAccount, codes: ["SECRET99"] }, A.jar);
    const mine = await app.get<ListBody>("/api/cdk", A.jar);
    const theirs = await app.get<ListBody>("/api/cdk", B.jar);
    expect(mine.body.items.find((i) => i.code === "SECRET99")?.masked).toBe(false);
    const asB = theirs.body.items.find((i) => i.masked && i.code.startsWith("SECR"));
    expect(asB).toBeTruthy();
    expect(asB?.code).not.toBe("SECRET99");
  });

  it("★ 一键兑换成功：次数累加；同一码别人也能再领", async () => {
    await app.post("/api/cdk/submit", { accountId: aAccount, codes: ["SHARE1"] }, A.jar);
    const list = await app.get<ListBody>("/api/cdk", B.jar);
    const target = list.body.items.find((i) => i.code.startsWith("SHAR"));
    expect(target).toBeTruthy();

    const claim1 = await app.post<{ ok: boolean }>("/api/cdk/" + target!.id + "/claim", { accountId: bAccount }, B.jar);
    expect(claim1.body.ok).toBe(true);
    const claim2 = await app.post<{ ok: boolean }>("/api/cdk/" + target!.id + "/claim", { accountId: aAccount }, A.jar);
    expect(claim2.body.ok).toBe(true); // 按账号可重复领

    const after = await app.get<ListBody>("/api/cdk", A.jar);
    // 3 次 = 提交时验证的那一次 + 乙领的一次 + 甲领的一次（码按账号可重复领）
    expect(after.body.items.find((i) => i.id === target!.id)?.successCount).toBe(3);
  });

  it("★ 兑换时发现失效 → 自动移出库（列表里不再出现）", async () => {
    behaviors.set("DIE1", { ok: true });
    await app.post("/api/cdk/submit", { accountId: aAccount, codes: ["DIE1"] }, A.jar);
    const list = await app.get<ListBody>("/api/cdk", A.jar);
    const target = list.body.items.find((i) => i.code === "DIE1");
    expect(target).toBeTruthy();

    // 之后这个码被停用
    behaviors.set("DIE1", { errorCode: "CDK_DISABLED" });
    const claim = await app.post<{ ok: boolean; reason?: string; removed?: boolean }>(
      `/api/cdk/${target!.id}/claim`,
      { accountId: aAccount },
      A.jar,
    );
    expect(claim.body.ok).toBe(false);
    expect(claim.body.removed).toBe(true);
    expect(claim.body.reason).toContain("移除");

    const after = await app.get<ListBody>("/api/cdk", A.jar);
    // 默认视图按状态筛（界面默认「可兑换」）；已失效的码在「全部/已失效」里可见但状态为 exhausted
    expect(after.body.items.find((i) => i.id === target!.id)?.status).toBe("exhausted");
    const onlyAvailable = await app.get<ListBody>("/api/cdk?status=available", A.jar);
    expect(onlyAvailable.body.items.some((i) => i.id === target!.id)).toBe(false);
  });

  it("不能用别人的账号提交", async () => {
    const r = await app.post("/api/cdk/submit", { accountId: bAccount, codes: ["X1"] }, A.jar);
    expect(r.status).toBe(404);
  });

  /* ---------- 用户反馈：已领取过却显示「兑换成功」 ---------- */

  it("★ 已领取过（200 但没有任何 redemptions）不能谎报成功", async () => {
    behaviors.set("DONE1", { empty: true }); // 提交时也领不到（本账号已领过）
    const submitRes = await app.post<{ results: { ok: boolean; reason?: string }[] }>(
      "/api/cdk/submit",
      { accountId: aAccount, codes: ["DONE1"] },
      A.jar,
    );
    // 已领取过仍入库，但要说明原因
    expect(submitRes.body.results[0]?.ok).toBe(true);
    expect(submitRes.body.results[0]?.reason).toContain("已经领过");

    const list = await app.get<ListBody>("/api/cdk", A.jar);
    const target = list.body.items.find((i) => i.code === "DONE1");
    expect(target).toBeTruthy();

    const claim = await app.post<{ ok: boolean; already?: boolean; reason?: string }>(
      `/api/cdk/${target!.id}/claim`,
      { accountId: aAccount },
      A.jar,
    );
    expect(claim.body.ok).toBe(false); // ★ 关键：不是成功
    expect(claim.body.already).toBe(true);
    expect(claim.body.reason).toContain("已经领过");

    // 码仍留在库里（对别人可能有效），也不该记成功次数
    const after = await app.get<ListBody>("/api/cdk", A.jar);
    expect(after.body.items.find((i) => i.id === target!.id)?.status).toBe("available");
  });

  it("★ 一键领取：领到 / 已领过 / 失效分别计数", async () => {
    await app.post("/api/cdk/submit", { accountId: aAccount, codes: ["OK1", "OK2"] }, A.jar);
    behaviors.set("OK2", { empty: true }); // 领的时候发现本账号已领过
    behaviors.set("DEAD1", { ok: true });
    await app.post("/api/cdk/submit", { accountId: aAccount, codes: ["DEAD1"] }, A.jar);
    behaviors.set("DEAD1", { errorCode: "CDK_DISABLED" }); // 之后失效

    const r = await app.post<{ ok: number; already: number; removed: number; failed: number }>(
      "/api/cdk/claim-all",
      { accountId: bAccount },
      B.jar,
    );
    expect(r.status).toBe(200);
    expect(r.body.already).toBeGreaterThanOrEqual(1);
    expect(r.body.removed).toBe(1);
    expect(r.body.ok).toBeGreaterThanOrEqual(1);
  });

  it("★ 列表支持状态筛选 / 搜索 / 只看自己 与分页", async () => {
    await app.post("/api/cdk/submit", { accountId: aAccount, codes: ["FILTER1"] }, A.jar);
    behaviors.set("FILTER2", { errorCode: "CDK_NOT_STARTED" });
    await app.post("/api/cdk/submit", { accountId: bAccount, codes: ["FILTER2"] }, B.jar);

    const avail = await app.get<ListBody>("/api/cdk?status=available&search=FILTER1", A.jar);
    expect(avail.body.items.map((i) => i.code)).toContain("FILTER1");
    expect(avail.body.items.map((i) => i.code)).not.toContain("FILTER2");

    const notStarted = await app.get<ListBody>("/api/cdk?status=not_started", A.jar);
    // A 看到的 FILTER2 是别人提交的 → 打码；用状态与归属断言，而不是明文
    expect(notStarted.body.items.some((i) => i.status === "not_started" && i.masked)).toBe(true);
    const notStartedB = await app.get<ListBody>("/api/cdk?status=not_started", B.jar);
    expect(notStartedB.body.items.map((i) => i.code)).toContain("FILTER2");

    const mineB = await app.get<ListBody>("/api/cdk?mine=1", B.jar);
    expect(mineB.body.items.every((i) => i.mine)).toBe(true);
    expect(mineB.body.items.map((i) => i.code)).toContain("FILTER2");

    const paged = await app.get<ListBody>("/api/cdk?limit=1&offset=0", A.jar);
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.total).toBeGreaterThan(1);
  });

  it("提交需要登录", async () => {
    expect((await app.post("/api/cdk/submit", { accountId: aAccount, codes: ["X1"] })).status).toBe(401);
    expect((await app.get("/api/cdk")).status).toBe(401);
  });
});

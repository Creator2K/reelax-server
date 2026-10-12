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
type Behavior = { ok: true } | { errorCode: string };
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
    expect(after.body.items.some((i) => i.id === target!.id)).toBe(false);
    // 带上 all=1 仍能看到历史（标记为 exhausted）
    const all = await app.get<ListBody>("/api/cdk?all=1", A.jar);
    expect(all.body.items.find((i) => i.id === target!.id)?.status).toBe("exhausted");
  });

  it("不能用别人的账号提交", async () => {
    const r = await app.post("/api/cdk/submit", { accountId: bAccount, codes: ["X1"] }, A.jar);
    expect(r.status).toBe(404);
  });

  it("提交需要登录", async () => {
    expect((await app.post("/api/cdk/submit", { accountId: aAccount, codes: ["X1"] })).status).toBe(401);
    expect((await app.get("/api/cdk")).status).toBe(401);
  });
});

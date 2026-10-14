// 船队面板：状态组装 + 错误码翻译（纯函数）
//
// 这块判错的后果很具体：把"船长不能离开"说成任意失败、或把邀请的昵称显示错，
// 用户就会反复点、或者跑去游戏里看 —— 所以逐条钉住。
import { describe, expect, it } from "vitest";
import { buildPartyView, invitationList, partyErrorMessage, CAPTAIN_LEAVE_HINT } from "../src/services/party-view.ts";

describe("buildPartyView", () => {
  it("★ 在船队里：船名 / 所在地图 / 权限 / 被带走开关都摊平出来", () => {
    const view = buildPartyView({
      party: {
        isInParty: true,
        boatName: "奥潮远洋舰",
        boatBiomeId: "b_012",
        canChangeBoatBiome: true,
        isPartySummonAllowed: false,
        isOnBoat: true,
      },
      biomeName: (id) => (id === "b_012" ? "熔潮环礁" : null),
    });

    expect(view.inParty).toBe(true);
    expect(view.boatName).toBe("奥潮远洋舰");
    expect(view.boatBiomeName).toBe("熔潮环礁");
    expect(view.canChangeBoatBiome).toBe(true);
    expect(view.canBeSummoned).toBe(false);
    expect(view.onBoat).toBe(true);
  });

  it("★ 船长（可改航线）给「不能直接离开」的说明；普通成员不给", () => {
    const captain = buildPartyView({ party: { isInParty: true, canChangeBoatBiome: true } });
    expect(captain.leaveBlockedReason).toBe(CAPTAIN_LEAVE_HINT);

    const crew = buildPartyView({ party: { isInParty: true, canChangeBoatBiome: false } });
    expect(crew.leaveBlockedReason).toBeNull();
  });

  it("不在船队时字段清空，不残留上一艘船的信息", () => {
    const view = buildPartyView({ party: { isInParty: false } });
    expect(view.inParty).toBe(false);
    expect(view.boatName).toBeNull();
    expect(view.boatBiomeName).toBeNull();
    expect(view.leaveBlockedReason).toBeNull();
  });

  it("isPartySummonAllowed 缺失时默认「允许被带走」（与游戏默认一致）", () => {
    expect(buildPartyView({ party: { isInParty: true } }).canBeSummoned).toBe(true);
  });

  it("邀请列表：取 id / 邀请人昵称 / 船名，形状不认识也不报错", () => {
    const view = buildPartyView({
      party: { isInParty: false },
      invitations: [
        { id: "i1", inviter: { nickname: "艾拉" }, crewName: "芦汐轻舟" },
        { id: "i2", inviterNickname: "北辰" },
        { id: "i3", senderNickname: "小满", boatName: "远洋号" },
        { crewName: "缺 id 的邀请" },
        { id: "i4" },
      ],
    });

    expect(view.invitations).toEqual([
      { id: "i1", from: "艾拉", boatName: "芦汐轻舟" },
      { id: "i2", from: "北辰", boatName: null },
      { id: "i3", from: "小满", boatName: "远洋号" },
      { id: "i4", from: null, boatName: null },
    ]);
  });

  it("响应为空时不抛错", () => {
    expect(buildPartyView({ party: null }).invitations).toEqual([]);
    expect(buildPartyView({ party: null, invitations: undefined }).inParty).toBe(false);
  });
});

describe("invitationList（响应形状兜底）", () => {
  it("裸数组 / items / invitations 三种形状都认", () => {
    expect(invitationList([{ id: "a" }])).toHaveLength(1);
    expect(invitationList({ items: [{ id: "a" }, { id: "b" }] })).toHaveLength(2);
    expect(invitationList({ invitations: [{ id: "a" }] })).toHaveLength(1);
  });

  it("认不出 / 空值 → 空数组（面板当成「没有邀请」，不报错）", () => {
    expect(invitationList(null)).toEqual([]);
    expect(invitationList({})).toEqual([]);
    expect(invitationList({ items: null })).toEqual([]);
    expect(invitationList("nope")).toEqual([]);
  });
});

describe("partyErrorMessage（错误码 → 人话）", () => {
  it("★ 邀请码无效 / 满员 / 未运营 各自说清楚", () => {
    expect(partyErrorMessage(new Error("POST /api/party-boats/join-by-code 失败：PARTY_BOAT_JOIN_CODE_INVALID"))).toContain(
      "邀请码无效",
    );
    expect(partyErrorMessage(new Error("PARTY_BOAT_FULL"))).toContain("满员");
    expect(partyErrorMessage(new Error("PARTY_BOAT_NOT_ACTIVE"))).toContain("未运营");
  });

  it("★ 船长不能离开 → 给出下一步该去哪做", () => {
    expect(partyErrorMessage(new Error("PARTY_BOAT_CAPTAIN_CANNOT_LEAVE"))).toBe(CAPTAIN_LEAVE_HINT);
  });

  it("认不出的错误原样带出来（便于排查），空值也给一句", () => {
    expect(partyErrorMessage(new Error("HTTP 502"))).toBe("HTTP 502");
    expect(partyErrorMessage(null)).toBe("操作失败（没有返回原因）");
  });
});

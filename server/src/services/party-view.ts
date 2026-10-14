// 船队（组队）状态与操作：面板数据组装 + 错误码翻译（纯函数，便于单测）
//
// 数据只有两个来源：
//  · `/api/fishing/state` 的 `party`（是否在船队、船名、船所在地图、能否改航线、是否允许被带走）；
//  · `/api/party-boats/invitations`（别人发给我的邀请）。
// 不在助手侧缓存：船队状态变化频繁（有人拉你上船、有人退队），每次打开面板都现读。
//
// 操作（加入 / 离开 / 接受邀请）走官方接口：
//  · POST /api/party-boats/join-by-code   body { code }
//  · POST /api/party-boats/leave
//  · POST /api/party-boats/invitations/{id}/accept | reject

export type PartyInvitationView = {
  id: string;
  /** 邀请人昵称（拿不到就给 null，界面显示"未知玩家"） */
  from: string | null;
  /** 船名 */
  boatName: string | null;
};

export type PartyView = {
  inParty: boolean;
  boatName: string | null;
  boatBiomeId: string | null;
  boatBiomeName: string | null;
  /** 能否改变船队航线（= 船长 / 舵手） */
  canChangeBoatBiome: boolean;
  /** 是否允许船长 / 舵手换图时把自己一起带走 */
  canBeSummoned: boolean;
  /** 是否在船上（在船队且在船上才能跟着换图） */
  onBoat: boolean | null;
  /** 船长不能直接离开：给出说明；普通成员为 null */
  leaveBlockedReason: string | null;
  /** 别人发来的、还没处理的邀请 */
  invitations: PartyInvitationView[];
};

/** 「船长不能离开」的固定说明（游戏会用 PARTY_BOAT_CAPTAIN_CANNOT_LEAVE 拒绝） */
export const CAPTAIN_LEAVE_HINT = "船长不能直接离开：需要先结束租赁或解散船队（游戏里的船队管理页可以做）";

/** 邀请列表响应的形状兜底：`{items: []}` / `{invitations: []}` / 直接数组都认 */
export function invitationList(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  const p = payload as { items?: unknown; invitations?: unknown } | null;
  if (Array.isArray(p?.items)) return p.items;
  if (Array.isArray(p?.invitations)) return p.invitations;
  return [];
}

export function buildPartyView(input: {
  party: any;
  invitations?: any[];
  biomeName?: (id: string) => string | null;
}): PartyView {
  const party = input.party ?? null;
  const inParty = Boolean(party?.isInParty);
  const boatBiomeId = party?.boatBiomeId ? String(party.boatBiomeId) : null;
  const canChangeBoatBiome = Boolean(party?.canChangeBoatBiome);

  return {
    inParty,
    boatName: party?.boatName ? String(party.boatName) : null,
    boatBiomeId,
    boatBiomeName: boatBiomeId ? (input.biomeName?.(boatBiomeId) ?? null) : null,
    canChangeBoatBiome,
    canBeSummoned: party?.isPartySummonAllowed === undefined ? true : Boolean(party.isPartySummonAllowed),
    onBoat: typeof party?.isOnBoat === "boolean" ? party.isOnBoat : null,
    leaveBlockedReason: inParty && canChangeBoatBiome ? CAPTAIN_LEAVE_HINT : null,
    invitations: (input.invitations ?? [])
      .filter((i) => i?.id)
      .map((i) => ({
        id: String(i.id),
        from:
          (i?.inviter?.nickname as string | undefined) ??
          (i?.inviterNickname as string | undefined) ??
          (i?.senderNickname as string | undefined) ??
          null,
        boatName: (i?.crewName as string | undefined) ?? (i?.boatName as string | undefined) ?? null,
      })),
  };
}

/**
 * 船队相关错误 → 人话。
 *
 * 服务端返回的是错误码（`PARTY_BOAT_*`），直接抖给用户看不懂；
 * 认不出的错误原样带出来（便于排查），但至少把"邀请码"这类已知情况说清楚。
 */
export function partyErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const known: [string, string][] = [
    ["PARTY_BOAT_JOIN_CODE_INVALID", "邀请码无效，请检查后重试"],
    ["PARTY_BOAT_NOT_ACTIVE", "船队当前未运营，无法完成该操作"],
    ["PARTY_BOAT_FULL", "这支船队已经满员"],
    ["PARTY_BOAT_NOT_PUBLIC", "该船队当前不能公开加入"],
    ["PARTY_BOAT_CAPTAIN_CANNOT_LEAVE", CAPTAIN_LEAVE_HINT],
    ["PARTY_BOAT_PERMISSION_DENIED", "当前船队身份无权执行该操作"],
    ["PARTY_BOAT_INVITATION_NOT_PENDING", "邀请已经被处理或已过期"],
    ["PARTY_BOAT_HELMSMAN_LIMIT", "这支船队已经有两名舵手"],
    ["PARTY_BOAT_ALREADY_IN_PARTY", "已经在一个船队里了，需要先离开"],
    ["PARTY_BOAT_BIOME_NOT_UNLOCKED_BY_ALL", "有船员还没解锁目标地图，船队换图被拒绝"],
    ["PARTY_BOAT_NAME_INVALID", "船名不符合要求（2–24 个字符）"],
  ];
  for (const [code, text] of known) {
    if (raw.includes(code)) return text;
  }
  return raw || "操作失败（没有返回原因）";
}

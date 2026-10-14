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

export type PartyMemberView = {
  publicId: string;
  nickname: string;
  level: number | null;
  role: "captain" | "helmsman" | "crew";
  /** 当前所在地图 */
  biomeId: string | null;
  biomeName: string | null;
  /** 是否正在钓鱼 */
  fishing: "online" | "offline" | "none";
  /** 是否计入本船的经验加成（同船同图） */
  effective: boolean;
};

export type PartyView = {
  inParty: boolean;
  boatName: string | null;
  boatBiomeId: string | null;
  boatBiomeName: string | null;
  /** 我在船上的身份 */
  role: "captain" | "helmsman" | "crew" | null;
  isCaptain: boolean;
  /** 能否改变船队航线（= 船长 / 舵手） */
  canChangeBoatBiome: boolean;
  /** 是否允许船长 / 舵手换图时把自己一起带走 */
  canBeSummoned: boolean;
  /** 是否在船上（在船队且在船上才能跟着换图） */
  onBoat: boolean | null;
  /** 船队运营状态（停航待保养 / 租赁到期等） */
  status: "active" | "maintenance_due" | "rental_due" | string | null;
  /** 邀请码（船长与船员都能分享） */
  joinCode: string | null;
  capacity: number | null;
  isCrowdfunded: boolean;
  /** 是否允许「转让船长」（只有租用中的船可以） */
  canTransferCaptain: boolean;
  members: PartyMemberView[];
  /** 船长不能直接离开：给出说明；普通成员为 null */
  leaveBlockedReason: string | null;
  /** 别人发来的、还没处理的邀请 */
  invitations: PartyInvitationView[];
};

/** 「船长不能离开」的固定说明（游戏会用 PARTY_BOAT_CAPTAIN_CANNOT_LEAVE 拒绝） */
export const CAPTAIN_LEAVE_HINT = "船长不能直接离开：需要先结束租赁或解散船队（游戏里的船队管理页可以做）";

const ROLE_LABELS: Record<string, string> = { captain: "船长", helmsman: "舵手", crew: "船员" };
export const partyRoleLabel = (role: unknown): string => ROLE_LABELS[String(role)] ?? "船员";

function fishingOf(v: unknown): PartyMemberView["fishing"] {
  const s = String(v ?? "");
  if (s === "online_fishing" || s === "online") return "online";
  if (s === "offline_fishing" || s === "offline") return "offline";
  return "none";
}

/** 邀请列表响应的形状兜底：`{items: []}` / `{invitations: []}` / 直接数组都认 */
export function invitationList(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  const p = payload as { items?: unknown; invitations?: unknown } | null;
  if (Array.isArray(p?.items)) return p.items;
  if (Array.isArray(p?.invitations)) return p.invitations;
  return [];
}

export function buildPartyView(input: {
  /** /api/fishing/state 的 party（兜底与权限来源） */
  party?: any;
  /** /api/party-boats/overview（成员列表 / 邀请码 / 船队状态） */
  overview?: any;
  invitations?: any[];
  biomeName?: (id: string) => string | null;
}): PartyView {
  const state = input.party ?? null;
  const ov = input.overview ?? null;
  const ovParty = ov?.party ?? null;
  const crew = ov?.crew ?? null;

  const inParty = Boolean(ovParty?.isInParty ?? state?.isInParty);
  const roleRaw = String(ovParty?.role ?? "");
  const role: PartyView["role"] = roleRaw === "captain" || roleRaw === "helmsman" || roleRaw === "crew" ? roleRaw : null;
  const canChangeBoatBiome = Boolean(state?.canChangeBoatBiome ?? (role === "captain" || role === "helmsman"));
  const boatBiomeId = ovParty?.boatBiomeId
    ? String(ovParty.boatBiomeId)
    : state?.boatBiomeId
      ? String(state.boatBiomeId)
      : null;
  const name = (id: string | null) => (id ? (input.biomeName?.(id) ?? null) : null);

  const members: PartyMemberView[] = (crew?.members ?? [])
    .filter((m: any) => m?.identity?.publicId)
    .map((m: any) => {
      const biomeId = m?.currentBiomeId ? String(m.currentBiomeId) : null;
      return {
        publicId: String(m.identity.publicId),
        nickname: String(m.identity.nickname ?? "未知玩家"),
        level: Number.isFinite(Number(m.identity.level)) ? Number(m.identity.level) : null,
        role: m?.role === "captain" || m?.role === "helmsman" ? m.role : "crew",
        biomeId,
        biomeName: name(biomeId),
        fishing: fishingOf(m?.fishingStatus),
        effective: Boolean(m?.isEffectiveForCurrentPlayer),
      };
    });

  return {
    inParty,
    boatName:
      (crew?.name as string | undefined) ??
      (crew?.crewName as string | undefined) ??
      (ovParty?.crewName as string | undefined) ??
      (state?.boatName ? String(state.boatName) : null),
    boatBiomeId,
    boatBiomeName: name(boatBiomeId),
    role,
    isCaptain: role === "captain",
    canChangeBoatBiome,
    canBeSummoned: state?.isPartySummonAllowed === undefined ? true : Boolean(state.isPartySummonAllowed),
    onBoat: typeof state?.isOnBoat === "boolean" ? state.isOnBoat : null,
    status: (crew?.status as string | undefined) ?? null,
    joinCode: (crew?.joinCode as string | undefined) ?? null,
    capacity: Number.isFinite(Number(crew?.capacity)) ? Number(crew.capacity) : null,
    isCrowdfunded: Boolean(crew?.isCrowdfunded),
    canTransferCaptain: String(crew?.source ?? "") === "rented",
    members,
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
    ["PARTY_BOAT_MEMBER_NOT_FOUND", "该成员已经不在船上"],
    ["PARTY_BOAT_CAPTAIN_REQUIRED", "只有船长能做这个操作"],
  ];
  for (const [code, text] of known) {
    if (raw.includes(code)) return text;
  }
  return raw || "操作失败（没有返回原因）";
}

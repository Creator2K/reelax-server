// Party state normalization shared by auto-travel and manual travel.
//
// The game can expose party data through either /api/fishing/state or /api/party-boats/overview.
// Newer versions may omit canChangeBoatBiome from fishing state while still providing the role
// in overview. Normalize both shapes so captain/helmsman travel keeps working.

export type TravelPartyState = {
  isInParty: boolean;
  canChangeBoatBiome: boolean;
  boatName: string | null;
  boatBiomeId: string | null;
  role: "captain" | "helmsman" | "crew" | null;
};

export function normalizeTravelParty(stateParty: any, overview: any): TravelPartyState | null {
  const state = stateParty && typeof stateParty === "object" ? stateParty : null;
  const ovParty = overview?.party && typeof overview.party === "object" ? overview.party : null;
  const crew = overview?.crew && typeof overview.crew === "object" ? overview.crew : null;
  if (!state && !ovParty) return null;

  const roleRaw = String(ovParty?.role ?? state?.role ?? "");
  const role: TravelPartyState["role"] =
    roleRaw === "captain" || roleRaw === "helmsman" || roleRaw === "crew" ? roleRaw : null;

  const explicitCanChange = state?.canChangeBoatBiome ?? ovParty?.canChangeBoatBiome ?? crew?.canChangeBoatBiome;
  const canChangeBoatBiome =
    typeof explicitCanChange === "boolean"
      ? explicitCanChange
      : role === "captain" || role === "helmsman";

  const boatName =
    crew?.name ??
    crew?.crewName ??
    ovParty?.crewName ??
    state?.boatName ??
    null;
  const boatBiomeId = ovParty?.boatBiomeId ?? crew?.boatBiomeId ?? state?.boatBiomeId ?? null;

  return {
    isInParty: Boolean(ovParty?.isInParty ?? state?.isInParty ?? Boolean(crew)),
    canChangeBoatBiome,
    boatName: boatName == null ? null : String(boatName),
    boatBiomeId: boatBiomeId == null ? null : String(boatBiomeId),
    role,
  };
}

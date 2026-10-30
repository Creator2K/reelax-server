import { describe, expect, it } from "vitest";
import { normalizeTravelParty } from "../src/modules/shared/party.ts";

describe("normalizeTravelParty", () => {
  it("derives captain permission from party overview when fishing state omits it", () => {
    const party = normalizeTravelParty(
      { isInParty: true, boatName: "boat", boatBiomeId: "b_001" },
      { party: { isInParty: true, role: "captain", boatBiomeId: "b_002" }, crew: { name: "boat-2" } },
    );
    expect(party).toEqual({
      isInParty: true,
      canChangeBoatBiome: true,
      boatName: "boat-2",
      boatBiomeId: "b_002",
      role: "captain",
    });
  });

  it("keeps an explicit false permission from fishing state", () => {
    const party = normalizeTravelParty(
      { isInParty: true, canChangeBoatBiome: false, boatBiomeId: "b_001" },
      { party: { isInParty: true, role: "captain" } },
    );
    expect(party?.canChangeBoatBiome).toBe(false);
  });

  it("returns null when neither endpoint reports a party", () => {
    expect(normalizeTravelParty(null, null)).toBeNull();
    expect(normalizeTravelParty({ isInParty: false }, { party: null })).not.toBeNull();
  });
});

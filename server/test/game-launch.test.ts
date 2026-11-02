import { describe, expect, it } from "vitest";
import { buildFullApp } from "./helpers/full-app.ts";
import { buildGameLaunchExtensionZip } from "../src/services/game-launch-extension.ts";

const PROOF = `${Buffer.from(JSON.stringify({ version: 1, expiresAt: Date.now() + 3_600_000 })).toString("base64url")}.sig`;

function gameFetch(): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/me" || path === "/api/auth/login") {
      const headers = new Headers({
        "content-type": "application/json",
        "x-arcane-request-proof": PROOF,
      });
      headers.append("set-cookie", "arcane_session=browser-session; Path=/; HttpOnly; SameSite=Lax");
      return new Response(JSON.stringify({ player: { nickname: "test", level: 1 } }), { status: 200, headers });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("game launch tickets", () => {
  it("redeems a one-time cookie ticket and rejects reuse", async () => {
    const app = await buildFullApp({ fetchImpl: gameFetch() });
    try {
      const user = app.seedApprovedUser("launch@example.com");
      const accountId = app.seedAccount(user.id, "launch-account");
      app.registry.ensure(app.repos.accounts.findById(accountId)!);

      const ticket = await app.post<{ ticket: string; gameUrl: string }>(
        "/api/game-launch/tickets",
        { accountId, mode: "cookie" },
        user.jar,
      );
      expect(ticket.status).toBe(200);
      expect(ticket.body.gameUrl).toBe("https://reelax.cn");

      const redeemed = await app.post<{ mode: string; cookies: { name: string; value: string }[] }>(
        "/api/game-launch/redeem",
        { ticket: ticket.body.ticket },
      );
      expect(redeemed.status).toBe(200);
      expect(redeemed.body.mode).toBe("cookie");
      expect(redeemed.body.cookies).toContainEqual({ name: "arcane_session", value: "browser-session" });
      expect(redeemed.body).not.toHaveProperty("password");

      const reused = await app.post("/api/game-launch/redeem", { ticket: ticket.body.ticket });
      expect(reused.status).toBe(400);
      expect(reused.body.error.code).toBe("LAUNCH_TICKET_INVALID");
    } finally {
      await app.close();
    }
  });

  it("returns credentials only for a credentials-mode ticket", async () => {
    const app = await buildFullApp({ fetchImpl: gameFetch() });
    try {
      const user = app.seedApprovedUser("fill@example.com");
      const accountId = app.seedAccount(user.id, "fill-account");
      const passwordEnc = app.vault.seal("game-password", user.id, "password");
      app.repos.accounts.update(accountId, user.id, { passwordEnc });
      app.registry.ensure(app.repos.accounts.findById(accountId)!);

      const ticket = await app.post<{ ticket: string }>(
        "/api/game-launch/tickets",
        { accountId, mode: "credentials" },
        user.jar,
      );
      expect(ticket.status).toBe(200);
      const redeemed = await app.post<{ mode: string; email: string; password: string }>(
        "/api/game-launch/redeem",
        { ticket: ticket.body.ticket },
      );
      expect(redeemed.status).toBe(200);
      expect(redeemed.body.mode).toBe("credentials");
      expect(redeemed.body.password).toBe("game-password");
      expect(redeemed.body).not.toHaveProperty("cookies");
    } finally {
      await app.close();
    }
  });

  it("does not let another user create a ticket for the account", async () => {
    const app = await buildFullApp({ fetchImpl: gameFetch() });
    try {
      const owner = app.seedApprovedUser("owner@example.com");
      const other = app.seedApprovedUser("other@example.com");
      const accountId = app.seedAccount(owner.id, "private-account");
      const r = await app.post("/api/game-launch/tickets", { accountId, mode: "cookie" }, other.jar);
      expect(r.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects credential mode when the account has no saved password", async () => {
    const app = await buildFullApp({ fetchImpl: gameFetch() });
    try {
      const user = app.seedApprovedUser("nopass@example.com");
      const accountId = app.seedAccount(user.id, "no-password");
      const r = await app.post("/api/game-launch/tickets", { accountId, mode: "credentials" }, user.jar);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("PASSWORD_NOT_SAVED");
    } finally {
      await app.close();
    }
  });
});

describe("extension download", () => {
  it("serves an authenticated origin-specific ZIP and allows bookmarklet CORS preflight", async () => {
    const app = await buildFullApp({ fetchImpl: gameFetch() });
    try {
      const user = app.seedApprovedUser("zip@example.com");
      const zip = await fetch(`${app.url}/api/game-launch/extension.zip`, {
        headers: { Cookie: user.jar.header() },
      });
      expect(zip.status).toBe(200);
      expect(zip.headers.get("content-type")).toContain("application/zip");
      const bytes = Buffer.from(await zip.arrayBuffer());
      expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
      expect(bytes.toString("utf8")).toContain("manifest.json");

      const preflight = await fetch(`${app.url}/api/game-launch/redeem`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://reelax.cn",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://reelax.cn");
    } finally {
      await app.close();
    }
  });

  it("builds a zip with origin-specific permissions and extension sources", () => {
    const zip = buildGameLaunchExtensionZip({
      serverOrigin: "https://panel.example.com",
      gameOrigin: "https://reelax.cn",
    });
    const text = zip.toString("utf8");
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(text).toContain("manifest.json");
    expect(text).toContain("https://panel.example.com/*");
    expect(text).toContain("https://reelax.cn/*");
    expect(text).toContain("reelax-game-launch");
  });
});

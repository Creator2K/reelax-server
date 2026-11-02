// Reelax Game Login extension background worker.
// The server origin is substituted when the user downloads the extension from the panel.
const SERVER_ORIGIN = "__REELAX_SERVER_ORIGIN__";
const GAME_ORIGIN = "__REELAX_GAME_ORIGIN__";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "reelax-game-launch") return false;

  (async () => {
    const response = await fetch(`${SERVER_ORIGIN}/api/game-launch/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: message.ticket }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);

    const cookies = (Array.isArray(data.cookies) ? data.cookies : []).filter(
      (cookie) => cookie?.name && typeof cookie.value === "string",
    );
    if (!cookies.length) throw new Error("No game cookies returned");

    // A game origin can have the same cookie name in both host-only and domain
    // scopes. Remove every old copy first; otherwise Chrome sends both and the
    // game may still authenticate the previously logged-in account.
    const gameHost = new URL(GAME_ORIGIN).hostname;
    const incomingNames = new Set(cookies.map((cookie) => String(cookie.name)));
    const existing = await chrome.cookies.getAll({ domain: gameHost });
    for (const cookie of existing) {
      if (!incomingNames.has(cookie.name)) continue;
      await chrome.cookies.remove({
        url: `${GAME_ORIGIN}${cookie.path || "/"}`,
        name: cookie.name,
        ...(cookie.storeId ? { storeId: cookie.storeId } : {}),
      });
    }

    for (const cookie of cookies) {
      const name = String(cookie.name);
      const value = String(cookie.value);
      await chrome.cookies.set({
        url: `${GAME_ORIGIN}/`,
        name,
        value,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      });
      const saved = await chrome.cookies.get({ url: `${GAME_ORIGIN}/`, name });
      if (!saved || saved.value !== value) {
        throw new Error(`Failed to replace game cookie: ${name}`);
      }
    }

    await chrome.tabs.create({ url: data.gameUrl || `${GAME_ORIGIN}/` });
    return { ok: true, label: data.label || "" };
  })()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));

  return true;
});

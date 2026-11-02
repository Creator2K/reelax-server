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

    const cookies = Array.isArray(data.cookies) ? data.cookies : [];
    if (!cookies.length) throw new Error("No game cookies returned");

    for (const cookie of cookies) {
      if (!cookie?.name || typeof cookie.value !== "string") continue;
      await chrome.cookies.set({
        url: `${GAME_ORIGIN}/`,
        name: String(cookie.name),
        value: String(cookie.value),
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      });
    }

    await chrome.tabs.create({ url: data.gameUrl || `${GAME_ORIGIN}/` });
    return { ok: true, label: data.label || "" };
  })()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));

  return true;
});

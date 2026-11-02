// Runs only on the Reelax management panel; announces that the extension is available.
(() => {
  document.documentElement.dataset.reelaxGameLaunchExtension = "1";

  window.addEventListener("reelax:game-launch", (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!detail?.ticket || !detail?.requestId) return;

    chrome.runtime.sendMessage(
      { type: "reelax-game-launch", ticket: String(detail.ticket) },
      (response) => {
        const error = chrome.runtime.lastError?.message;
        window.dispatchEvent(
          new CustomEvent("reelax:game-launch-result", {
            detail: {
              requestId: String(detail.requestId),
              ok: Boolean(response?.ok) && !error,
              error: error || response?.error || null,
            },
          }),
        );
      },
    );
  });
})();

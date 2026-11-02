import { readFileSync } from "node:fs";
import { createStoreZip } from "../lib/zip.ts";
import { VERSION } from "../version.ts";

function readExtensionFile(name: string): string {
  return readFileSync(new URL(`../game-extension/${name}`, import.meta.url), "utf8");
}

function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

export function buildGameLaunchExtensionZip(input: { serverOrigin: string; gameOrigin: string }): Buffer {
  const serverOrigin = normalizeOrigin(input.serverOrigin);
  const gameOrigin = normalizeOrigin(input.gameOrigin);
  const manifest = {
    manifest_version: 3,
    name: "Reelax Game Login",
    version: VERSION,
    description: "Open a saved Reelax game account in a new tab with its login session.",
    permissions: ["cookies"],
    host_permissions: [`${serverOrigin}/*`, `${gameOrigin}/*`],
    background: { service_worker: "background.js" },
    content_scripts: [
      {
        matches: [`${serverOrigin}/*`],
        js: ["content.js"],
        run_at: "document_start",
      },
    ],
    action: { default_title: "Reelax Game Login" },
  };

  const background = readExtensionFile("background.js")
    .replaceAll("__REELAX_SERVER_ORIGIN__", serverOrigin)
    .replaceAll("__REELAX_GAME_ORIGIN__", gameOrigin);

  return createStoreZip([
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) + "\n" },
    { name: "background.js", data: background },
    { name: "content.js", data: readExtensionFile("content.js") },
    { name: "README.txt", data: readExtensionFile("README.txt") },
  ]);
}

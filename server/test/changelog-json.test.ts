// 仓库根目录的 changelog.json 必须与 server/src/version.ts 一致
//
// 为什么需要这个文件：在线更新面板要显示「新版修了什么」，可是**旧版本的服务端不可能知道
// 新版本改了什么**（它的 CHANGELOG 编译在过去里）。所以把变更日志同时以机器可读的形式
// 放在仓库根目录，面板直接从 GitHub 上取。
//
// 一旦两份漂移，用户看到的"新版说明"就是错的 —— 这里钉死。
//
// 改了 CHANGELOG 之后重新生成：
//   node --experimental-strip-types -e "import('./server/src/version.ts').then(({VERSION,CHANGELOG})=>require('node:fs').writeFileSync('changelog.json', JSON.stringify({version:VERSION,entries:CHANGELOG},null,2)+'\n'))"
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANGELOG, VERSION } from "../src/version.ts";

describe("changelog.json（在线更新面板的数据源）", () => {
  it("★ 与 server/src/version.ts 完全一致", () => {
    const raw = JSON.parse(readFileSync(new URL("../../changelog.json", import.meta.url), "utf8")) as {
      version?: unknown;
      entries?: unknown;
    };
    expect(raw.version).toBe(VERSION);
    expect(raw.entries).toEqual(CHANGELOG);
  });

  it("至少包含最新一个版本的标题与条目（面板要靠它渲染）", () => {
    const raw = JSON.parse(readFileSync(new URL("../../changelog.json", import.meta.url), "utf8")) as {
      entries?: { version: string; title: string; changes: unknown[] }[];
    };
    const first = raw.entries?.[0];
    expect(first?.version).toBe(VERSION);
    expect(first?.title?.length).toBeGreaterThan(0);
    expect(first?.changes?.length).toBeGreaterThan(0);
  });
});

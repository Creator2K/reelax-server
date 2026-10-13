// 编码体检：仓库里的文本文件必须都是合法 UTF-8
//
// ★ 为什么值得一个测试：PowerShell 的 `Get-Content -Raw` + `Set-Content` 往返会把中文
//   写成双重编码（UTF-8 字节被当成 GBK 再编码一次），文件从此不是合法 UTF-8 ——
//   而这类损坏**不会让测试失败**：JSON 仍然能解析，TypeScript 仍然能编译，
//   只是用户看到乱码。根 package.json 的 description 就这样坏过（后来才发现）。
//   同一个坑已经踩过两次（另一次是 .tsx / .test.ts），所以加一道自动守卫。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录（本文件在 server/test/ 下） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".vite", ".cache", ".dsh"]);
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".html",
  ".css",
  ".txt",
  ".sql",
  ".sh",
  ".toml",
  "",
]);

function findBroken(root: string): { scanned: number; broken: string[] } {
  const broken: string[] = [];
  let scanned = 0;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      const file = path.join(dir, entry.name);
      const buf = fs.readFileSync(file);
      // 含 NUL 的按二进制跳过（图片、字体之类即使扩展名在清单里也不该检查）
      if (buf.includes(0)) continue;
      scanned += 1;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        broken.push(path.relative(root, file));
      }
    }
  };

  walk(root);
  return { scanned, broken };
}

describe("编码体检", () => {
  it("★ 仓库里的文本文件都是合法 UTF-8（防 PowerShell 往返写坏中文）", () => {
    const { scanned, broken } = findBroken(ROOT);
    expect(scanned).toBeGreaterThan(50); // 扫到的东西太少说明路径算错了
    expect(broken).toEqual([]);
  });

  it("守卫本身有效：人为构造的坏字节能被认出来", () => {
    // "多" 的正确 UTF-8 是 E5 A4 9A；下面把它拆成两个坏序列
    const corrupted = Buffer.from([0x22, 0xe5, 0xa4, 0x22]);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(corrupted)).toThrow();
  });
});

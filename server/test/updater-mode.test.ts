// updater 的模式解析（纯函数）
//
// 这块猜错的后果很隐蔽：明明该拉预构建镜像，却去跑 git pull —— 在 tar 解压的部署上
// 直接失败；反过来在有 .git 的部署上不去本机构建，就可能一直用着旧代码。
// 所以「auto 怎么判」和「pull 要跑哪两条命令」都钉住。
import { describe, expect, it } from "vitest";
import { describeMode, parseImageCommit, pullCommands, requiresGitWorktree, resolveMode } from "../../updater/mode.mjs";

describe("resolveMode", () => {
  it("★ auto：有 .git 走 git（保持老行为），没有就走 pull（tar 部署靠它）", () => {
    expect(resolveMode({ requested: undefined, hasGitDir: true })).toBe("git");
    expect(resolveMode({ requested: undefined, hasGitDir: false })).toBe("pull");
    expect(resolveMode({ requested: "auto", hasGitDir: false })).toBe("pull");
  });

  it("显式指定时照办（哪怕与自动判断相反）", () => {
    // 有 .git 也能强制走 pull：想省掉本机构建的开销
    expect(resolveMode({ requested: "pull", hasGitDir: true })).toBe("pull");
    // 没有 .git 也强制 git → 由 preflight 报出「不是 git 工作区」，不静默改道
    expect(resolveMode({ requested: "git", hasGitDir: false })).toBe("git");
  });

  it("大小写与空格容错；无法识别的值退回按 .git 判断", () => {
    expect(resolveMode({ requested: " PULL ", hasGitDir: true })).toBe("pull");
    expect(resolveMode({ requested: "Git", hasGitDir: true })).toBe("git");
    expect(resolveMode({ requested: "什么鬼", hasGitDir: false })).toBe("pull");
    expect(resolveMode({ requested: "", hasGitDir: true })).toBe("git");
    expect(resolveMode({})).toBe("pull"); // 连 hasGitDir 都没给 → 不假设有 .git
  });
});

describe("requiresGitWorktree / describeMode", () => {
  it("只有 git 模式需要 .git 与 token", () => {
    expect(requiresGitWorktree("git")).toBe(true);
    expect(requiresGitWorktree("pull")).toBe(false);
  });

  it("两种模式都有可读的说明（会出现在 /health 与启动日志里）", () => {
    expect(describeMode("git")).toContain("git pull");
    expect(describeMode("pull")).toContain("预构建镜像");
  });
});

describe("pullCommands", () => {
  it("★ 先 pull 再 up：两步都是 docker compose，且只动 app（--no-deps 不重启 updater 自己）", () => {
    const cmds = pullCommands({ composeFile: "docker-compose.yml", service: "app" });
    expect(cmds.map((c) => c.step)).toEqual(["image-pull", "compose-up"]);
    expect(cmds[0]?.cmd).toBe("docker");
    expect(cmds[0]?.args).toEqual(["compose", "-f", "docker-compose.yml", "pull", "app"]);
    expect(cmds[1]?.args).toEqual(["compose", "-f", "docker-compose.yml", "up", "-d", "--no-deps", "app"]);
    for (const c of cmds) expect(c.timeoutMs).toBeGreaterThan(0);
  });

  it("没给参数时有安全默认值", () => {
    const cmds = pullCommands({});
    expect(cmds[0]?.args).toContain("docker-compose.yml");
    expect(cmds[0]?.args).toContain("app");
  });
});

describe("parseImageCommit", () => {
  it("从 docker image inspect 的 ENV 输出里取 APP_COMMIT", () => {
    const out = ["PATH=/usr/bin", "APP_COMMIT=5ecfe35abcdef", "APP_BUILD_TIME=2026-10-10T08:00:00Z", ""].join("\n");
    expect(parseImageCommit(out)).toBe("5ecfe35abcdef");
  });

  it("没有 APP_COMMIT（例如老镜像）时返回 null，不编造", () => {
    expect(parseImageCommit("PATH=/usr/bin\nNODE_ENV=production\n")).toBeNull();
    expect(parseImageCommit("")).toBeNull();
    expect(parseImageCommit(undefined)).toBeNull();
    expect(parseImageCommit("APP_COMMIT=\n")).toBeNull();
  });
});

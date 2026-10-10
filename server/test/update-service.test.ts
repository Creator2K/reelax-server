// 在线更新服务测试
//
// 覆盖两条部署形态的关键分支：
//   - 有 .git（裸机）：读本地提交
//   - 没有 .git（Docker 镜像）：退回构建时烧进镜像的 APP_COMMIT
// 以及远端查询（GitHub API）、旁路 updater 探测、以及「不能自动更新时给命令」。
import { describe, expect, it, afterEach } from "vitest";
import { UpdateService } from "../src/services/update-service.ts";
import { Logger } from "../src/lib/logger.ts";

const logger = new Logger({ limit: 100, minLevel: "error" });

/** 造一个只回固定 JSON 的假 fetch，并记录调用（含 Authorization，用于验证令牌确实发出去了） */
function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; throwError?: unknown }) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init?.method ?? "GET"),
      auth: new Headers(init?.headers as HeadersInit | undefined).get("authorization"),
    });
    const r = handler(url, init);
    if (r.throwError) throw r.throwError;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { impl, calls };
}

const ORIGINAL_COMMIT = process.env.APP_COMMIT;
afterEach(() => {
  if (ORIGINAL_COMMIT === undefined) delete process.env.APP_COMMIT;
  else process.env.APP_COMMIT = ORIGINAL_COMMIT;
});

describe("currentCommit 的两种来源", () => {
  it("★ 没有 .git 时退回镜像里烧好的 APP_COMMIT（容器里就靠它显示版本）", async () => {
    process.env.APP_COMMIT = "abcdef1234567890abcdef1234567890abcdef12";
    process.env.APP_BUILD_TIME = "2026-10-09T12:00:00Z";

    const svc = new UpdateService({
      logger,
      repoSlug: "Creator2K/reelax-server",
      // null = 容器内没有挂载仓库
      workDir: null,
      updaterUrl: null,
      allowLocalUpdate: false,
    });

    const cur = await svc.currentCommit();
    expect(cur).not.toBeNull();
    expect(cur?.short).toBe("abcdef1");
    expect(cur?.date).toBe("2026-10-09T12:00:00Z");
    expect(cur?.message).toContain("镜像构建时");
  });

  it("APP_COMMIT 不是合法 sha 时返回 null（不编造版本号）", async () => {
    for (const bad of ["unknown", "", "not-a-sha", "xyz!!"]) {
      process.env.APP_COMMIT = bad;
      const svc = new UpdateService({
        logger,
        repoSlug: "r/r",
        workDir: null,
        updaterUrl: null,
        allowLocalUpdate: false,
      });
      expect(await svc.currentCommit(), `APP_COMMIT=${bad}`).toBeNull();
    }
  });

  it("workDir 指向不存在的目录时也不抛错", async () => {
    delete process.env.APP_COMMIT;
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: "D:/definitely/not/here",
      updaterUrl: null,
      allowLocalUpdate: false,
    });
    await expect(svc.currentCommit()).resolves.toBeNull();
  });
});

describe("check：远端查询与更新判定", () => {
  const ghResponse = (sha: string, msg = "fix something") => ({
    sha,
    commit: { message: `${msg}\n\nmore body`, committer: { date: "2026-10-09T10:00:00Z", name: "Creator2K" }, author: { name: "Creator2K" } },
  });

  it("远端有新提交时 hasUpdate = true（靠 sha 比对）", async () => {
    process.env.APP_COMMIT = "1111111111111111111111111111111111111111";
    const { impl, calls } = fakeFetch(() => ({ body: ghResponse("2222222222222222222222222222222222222222", "新功能") }));

    const svc = new UpdateService({
      logger,
      repoSlug: "Creator2K/reelax-server",
      workDir: null,
      updaterUrl: null,
      allowLocalUpdate: false,
      fetchImpl: impl,
    });

    const r = await svc.check();
    expect(r.current?.short).toBe("1111111");
    expect(r.latest?.short).toBe("2222222");
    expect(r.hasUpdate).toBe(true);
    // message 只取第一行（GitHub 的 message 可能很长）
    expect(r.latest?.message).toBe("新功能");
    // 调用了 GitHub API 而不是 git
    expect(calls.some((c) => c.url.includes("api.github.com"))).toBe(true);
    // 没有 .git → 给出裸机/容器的操作指引
    expect(r.canApplyLocal).toBe(false);
    expect(r.manualHint).toBeTruthy();
  });

  it("sha 相同时 hasUpdate = false", async () => {
    const sha = "3333333333333333333333333333333333333333";
    process.env.APP_COMMIT = sha;
    const { impl } = fakeFetch(() => ({ body: ghResponse(sha) }));
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: null,
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.check();
    expect(r.hasUpdate).toBe(false);
  });

  it("★ 私有仓库 404 时给出明确提示（而不是静默失败）", async () => {
    process.env.APP_COMMIT = "4444444444444444444444444444444444444444";
    const { impl } = fakeFetch(() => ({ status: 404, body: { message: "Not Found" } }));
    const svc = new UpdateService({
      logger,
      repoSlug: "Creator2K/private-repo",
      workDir: null,
      updaterUrl: null,
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.check();
    expect(r.latest).toBeNull();
    expect(r.note).toContain("404");
    expect(r.note).toContain("GITHUB_TOKEN");
  });

  it("网络异常时把原因放进 note，不抛错", async () => {
    process.env.APP_COMMIT = "5555555555555555555555555555555555555555";
    const { impl } = fakeFetch(() => ({ throwError: new Error("getaddrinfo ENOTFOUND") }));
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: null,
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.check();
    expect(r.latest).toBeNull();
    expect(r.note).toContain("ENOTFOUND");
  });

  it("未配置仓库地址时提示清楚", async () => {
    const svc = new UpdateService({
      logger,
      repoSlug: "",
      workDir: null,
      updaterUrl: null,
      allowLocalUpdate: false,
      fetchImpl: fakeFetch(() => ({ body: {} })).impl,
    });
    const r = await svc.check();
    expect(r.note).toContain("REELAX_REPO");
  });

  it("探测旁路 updater：/health 返回 200 即视为可用", async () => {
    process.env.APP_COMMIT = "6666666666666666666666666666666666666666";
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("/health")) return { body: { ok: true } };
      return { body: { sha: "6666666666666666666666666666666666666666", commit: { message: "x", committer: { date: "" } } } };
    });
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: "http://updater:9000",
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.check();
    expect(r.updaterAvailable).toBe(true);
    expect(calls.some((c) => c.url === "http://updater:9000/health")).toBe(true);
    // 有 updater 时不再给「手动执行命令」的提示
    expect(r.manualHint).toBeNull();
  });

  it("updater 探测失败视为不可用，并回落到手动指引", async () => {
    process.env.APP_COMMIT = "7777777777777777777777777777777777777777";
    const { impl } = fakeFetch((url) => {
      if (url.includes("/health")) return { throwError: new Error("ECONNREFUSED") };
      return { body: { sha: "8888888888888888888888888888888888888888", commit: { message: "y", committer: { date: "" } } } };
    });
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: "http://updater:9000",
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.check();
    expect(r.updaterAvailable).toBe(false);
    expect(r.manualHint).toContain("docker compose");
  });
});

describe("apply：没有更新能力时给出可执行命令", () => {
  it("★ 容器内且未开本地更新 → 拒绝并给 docker compose 命令", async () => {
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: null,
      allowLocalUpdate: false,
      fetchImpl: fakeFetch(() => ({ body: {} })).impl,
    });
    const r = await svc.apply({ reason: "test" });
    expect(r.ok).toBe(false);
    expect(r.restarting).toBe(false);
    expect(r.message).toContain("docker compose");
  });

  it("有 updater 时把触发请求转发过去，并标记需要重启", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 202, body: { ok: true, message: "已开始更新" } }));
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: "http://updater:9000",
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.apply({ reason: "管理员点了按钮" });
    expect(r.ok).toBe(true);
    expect(r.restarting).toBe(true);
    expect(r.message).toContain("重建");
    const post = calls.find((c) => c.url === "http://updater:9000/update");
    expect(post?.method).toBe("POST");
  });

  it("updater 返回错误时把状态码带回来（便于排查）", async () => {
    const { impl } = fakeFetch(() => ({ status: 409, body: { ok: false, message: "已有更新在进行" } }));
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: "http://updater:9000",
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.apply({ reason: "t" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("409");
  });

  it("updater 不可达时不抛错，返回失败说明", async () => {
    const { impl } = fakeFetch(() => ({ throwError: new Error("ECONNREFUSED 127.0.0.1:9000") }));
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: "http://updater:9000",
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.apply({ reason: "t" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("ECONNREFUSED");
  });
});

describe("apply：updater 令牌（UPDATER_TOKEN）", () => {
  it("★ 配了 REELAX_UPDATER_TOKEN 就带 Authorization（否则按文档开启令牌校验后一键更新永远 401）", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 202, body: { ok: true, message: "已开始更新" } }));
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: "http://updater:9000",
      updaterToken: "s3cret-token",
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.apply({ reason: "t" });
    expect(r.ok).toBe(true);
    expect(calls[0]?.url).toBe("http://updater:9000/update");
    expect(calls[0]?.auth).toBe("Bearer s3cret-token");
  });

  it("没配令牌时不发 Authorization 头（updater 未开启校验的部署不受影响）", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 202, body: { ok: true } }));
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: "http://updater:9000",
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.apply({ reason: "t" });
    expect(r.ok).toBe(true);
    expect(calls[0]?.auth).toBeNull();
  });

  it("令牌不匹配（401）时给出可操作的排查提示", async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { ok: false, message: "令牌不正确" } }));
    const svc = new UpdateService({
      logger,
      repoSlug: "r/r",
      workDir: null,
      updaterUrl: "http://updater:9000",
      updaterToken: "wrong",
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.apply({ reason: "t" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("401");
    expect(r.message).toContain("UPDATER_TOKEN");
  });
});

/**
 * 真实踩过的坑：镜像构建时没传 APP_COMMIT → 容器里「当前版本」读不到 →
 * 面板把「没法比」显示成「已是最新」，用户以为不用更新，而实际上可能落后很多个提交。
 * 更糟的是原来的手动指引只写了 `docker compose up -d --build` —— 照做还是不带 APP_COMMIT，
 * 这个状态会一直持续下去。
 */
describe("★ 当前版本读不到时不能谎报「已是最新」", () => {
  const GH_SHA = "abcdef1234567890abcdef1234567890abcdef12";
  const ghBody = {
    sha: GH_SHA,
    commit: { message: "feat: 新功能", committer: { date: "2026-10-10T08:00:00Z", name: "Creator2K" } },
  };

  const mk = (fetchImpl: typeof fetch) =>
    new UpdateService({
      logger,
      repoSlug: "Creator2K/reelax-server",
      workDir: null, // 容器里没有 .git
      updaterUrl: null,
      allowLocalUpdate: false,
      fetchImpl,
    });

  it("★ APP_COMMIT 缺失 → comparable=false（不谎报最新），并说明原因与修法", async () => {
    delete process.env.APP_COMMIT;
    const { impl } = fakeFetch(() => ({ body: ghBody }));
    const r = await mk(impl).check();

    expect(r.current).toBeNull();
    expect(r.latest?.short).toBe("abcdef1");
    expect(r.comparable).toBe(false);
    expect(r.hasUpdate).toBe(false); // 没得比 → 只能是 false（前端靠 comparable 区分）
    expect(r.note).toContain("当前版本读不到");
    expect(r.note).toContain("APP_COMMIT");
    expect(r.note).toContain("无法判断"); // 文案里点明「不是最新，是没法比」
  });

  it("APP_COMMIT 是 unknown（compose 默认值）同样算读不到", async () => {
    process.env.APP_COMMIT = "unknown";
    const { impl } = fakeFetch(() => ({ body: ghBody }));
    const r = await mk(impl).check();
    expect(r.current).toBeNull();
    expect(r.comparable).toBe(false);
  });

  it("两边都拿到 → comparable=true，且不再出现「读不到」的说明", async () => {
    process.env.APP_COMMIT = "1111111111111111111111111111111111111111";
    const { impl } = fakeFetch(() => ({ body: ghBody }));
    const r = await mk(impl).check();
    expect(r.current?.short).toBe("1111111");
    expect(r.latest?.short).toBe("abcdef1");
    expect(r.comparable).toBe(true);
    expect(r.hasUpdate).toBe(true);
    expect(r.note ?? "").not.toContain("当前版本读不到");
  });

  it("★ 手动指引必须带上 APP_COMMIT，且不再让人去 pull 本地构建的镜像", async () => {
    delete process.env.APP_COMMIT;
    const { impl } = fakeFetch(() => ({ body: ghBody }));
    const r = await mk(impl).check();
    expect(r.manualHint).toBeTruthy();
    expect(r.manualHint).toContain("scripts/update");
    expect(r.manualHint).toContain("APP_COMMIT");
    // `docker compose pull` 对本地构建的镜像毫无意义（只会让人以为更新过了）
    expect(r.manualHint).not.toContain("docker compose pull");
  });

  it("有 updater 时不给手动指引（与既有行为一致）", async () => {
    delete process.env.APP_COMMIT;
    const { impl } = fakeFetch((url) => (url.includes("/health") ? { body: { ok: true } } : { body: ghBody }));
    const svc = new UpdateService({
      logger,
      repoSlug: "Creator2K/reelax-server",
      workDir: null,
      updaterUrl: "http://updater:9000",
      allowLocalUpdate: false,
      fetchImpl: impl,
    });
    const r = await svc.check();
    expect(r.updaterAvailable).toBe(true);
    expect(r.manualHint).toBeNull();
  });
});

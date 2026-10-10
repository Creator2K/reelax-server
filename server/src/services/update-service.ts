// 版本与在线更新
//
// 两种部署形态下的"更新"含义不同，这里都覆盖：
//
//  1) **Docker 部署（推荐）**：应用代码在镜像里，容器内部改不了自己。
//     真正的在线更新由**旁路 updater 容器**完成（它挂了 docker.sock，能 docker compose up -d --build）。
//     本服务只需要知道「updater 在不在」，然后把按钮点过去。
//
//  2) **裸机/本地运行（git checkout + node）**：应用代码就在工作区里，
//     可以直接 git pull（+ 重建前端 + 重启进程）。
//
// 不引入任何重依赖：git 与 docker 都用子进程调用，缺失时优雅降级为「只检查、给命令」。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../lib/logger.ts";

const execFileAsync = promisify(execFile);

export type UpdateCheck = {
  /** 当前代码的提交（拿不到为 null） */
  current: CommitInfo | null;
  /** 远端最新提交 */
  latest: CommitInfo | null;
  /** 是否有更新 */
  hasUpdate: boolean;
  /**
   * ★ 到底**能不能比较**（当前版本与远端都拿到了）。
   *
   * 容器里没有 .git、镜像构建时又没传 APP_COMMIT 时，当前版本读不到 ——
   * 这时 `hasUpdate` 只能是 false，但**绝不能把它当成「已是最新」展示**：
   * 用户会以为没必要更新，而实际上镜像可能已经落后很多个提交。
   */
  comparable: boolean;
  /** 落后多少个提交（拿不到为 null） */
  behindBy: number | null;
  /** 当前分支 */
  branch: string | null;
  /** 仓库地址 */
  repo: string | null;
  /** 是否具备"本地直接更新"的条件（在 git 工作区里且有 git 命令） */
  canApplyLocal: boolean;
  /** 旁路 updater 是否可用（Docker 部署场景） */
  updaterAvailable: boolean;
  /** 无法自动更新时给用户的操作指引 */
  manualHint: string | null;
  /** 检查过程中的提示（例如网络不通） */
  note: string | null;
};

export type CommitInfo = {
  sha: string;
  short: string;
  message: string;
  date: string | null;
  author: string | null;
};

export type ApplyResult = {
  ok: boolean;
  /** 给用户看的说明 */
  message: string;
  /** 是否触发了重启（前端据此提示"稍后刷新"） */
  restarting: boolean;
  log?: string;
};

/** 更新进度（前端轮询显示用） */
export type UpdateProgress = {
  /** 是否正在更新 */
  running: boolean;
  /** 更新方式：updater（重建容器）/ local（本地 git pull） */
  mode: "updater" | "local" | "none";
  /** 当前进行到哪一步 */
  step: UpdateStep;
  /** 人类可读的当前状态 */
  label: string;
  /** 最近若干行输出（给用户看细节） */
  tail: string[];
  /** 开始/结束时间（ISO） */
  startedAt: string | null;
  finishedAt: string | null;
  /** 结束后才有值 */
  ok: boolean | null;
  error: string | null;
  /** 更新前后提交（updater 模式能拿到） */
  before: string | null;
  after: string | null;
};

export type UpdateStep =
  | "idle"
  | "preflight"
  | "git-pull"
  | "install"
  | "build"
  | "recreate"
  | "done"
  | "failed";

const STEP_LABELS: Record<UpdateStep, string> = {
  idle: "空闲",
  preflight: "检查环境",
  "git-pull": "拉取最新代码",
  install: "安装依赖",
  build: "构建前端",
  recreate: "重建并重启容器",
  done: "更新完成",
  failed: "更新失败",
};

export type UpdateServiceDeps = {
  logger: Logger;
  /** GitHub owner/repo，用于查询远端（如 Creator2K/reelax-server） */
  repoSlug: string;
  /** 代码工作区根目录（含 .git）；不在 git 工作区时为 null */
  workDir: string | null;
  /** 旁路 updater 的地址（如 http://updater:9000）；未配置为 null */
  updaterUrl: string | null;
  /**
   * updater 的访问令牌（对应 updater 容器的 UPDATER_TOKEN），可选。
   * ★ 早期只有 updater 侧校验、app 侧从不发送，于是「按文档设了令牌」的部署
   *   一键更新永远 401，唯一的解法是把令牌删掉 —— 反向破坏了加固建议。
   */
  updaterToken?: string;
  /** 允许在容器内直接 git pull + 重建（本地部署场景） */
  allowLocalUpdate: boolean;
  /** 注入 fetch 便于测试 */
  fetchImpl?: typeof fetch;
};

/** 判断某目录是不是 git 工作区 */
function isGitWorktree(dir: string | null): boolean {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

export class UpdateService {
  private deps: UpdateServiceDeps;
  private log: Logger;
  /** 本地更新（非 updater 模式）的进度，供 /status 轮询 */
  private localProgress: UpdateProgress = {
    running: false,
    mode: "none",
    step: "idle",
    label: STEP_LABELS.idle,
    tail: [],
    startedAt: null,
    finishedAt: null,
    ok: null,
    error: null,
    before: null,
    after: null,
  };

  constructor(deps: UpdateServiceDeps) {
    this.deps = deps;
    this.log = deps.logger;
  }

  /**
   * 查询更新进度。
   *
   * 有 updater 时读它的 /status（真正的重建发生在那边）；
   * 否则返回本地记录（本地 git pull 模式的步骤）。
   * 拿不到进度时返回 idle，前端不会卡在加载态。
   */
  async status(): Promise<UpdateProgress> {
    if (this.deps.updaterUrl) {
      const doFetch = this.deps.fetchImpl ?? fetch;
      try {
        const r = await doFetch(`${this.deps.updaterUrl.replace(/\/+$/, "")}/status`, {
          signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
          const j = (await r.json()) as {
            running?: boolean;
            last?: {
              startedAt?: string;
              finishedAt?: string;
              ok?: boolean | null;
              reason?: string;
              steps?: { step: string; ok: boolean }[];
              log?: string[];
              error?: string;
              before?: string;
              after?: string;
            };
          };
          const last = j.last ?? null;
          // 根据已完成的步骤推断当前处于哪一步
          const done = new Set((last?.steps ?? []).filter((s) => s.ok).map((s) => s.step));
          const step: UpdateStep = j.running
            ? done.has("git-pull")
              ? "recreate"
              : "git-pull"
            : last?.ok === true
              ? "done"
              : last?.ok === false
                ? "failed"
                : "idle";

          return {
            running: Boolean(j.running),
            mode: "updater",
            step,
            label: STEP_LABELS[step],
            tail: (last?.log ?? []).slice(-40),
            startedAt: last?.startedAt ?? null,
            finishedAt: last?.finishedAt ?? null,
            ok: last?.ok ?? null,
            error: last?.error ?? null,
            before: last?.before ?? null,
            after: last?.after ?? null,
          };
        }
      } catch {
        /* 掉线时退回本地状态 */
      }
    }
    return this.localProgress;
  }

  private setLocalProgress(patch: Partial<UpdateProgress>): void {
    this.localProgress = { ...this.localProgress, ...patch };
  }

  private pushLocalLine(line: string): void {
    const tail = [...this.localProgress.tail, line].slice(-60);
    this.setLocalProgress({ tail });
  }

  /* ---------------- git 读取 ---------------- */

  private async git(args: string[], timeoutMs = 10_000): Promise<string | null> {
    if (!this.deps.workDir) return null;
    try {
      const { stdout } = await execFileAsync("git", ["-C", this.deps.workDir, ...args], {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /** 本地当前提交 */
  async currentCommit(): Promise<CommitInfo | null> {
    // 1) 有 .git 就直接读（裸机 / 本地开发）
    const sha = await this.git(["rev-parse", "HEAD"]);
    if (sha) {
      // 一次调用拿到 message / date / author，避免多次 fork
      const raw = await this.git(["log", "-1", "--pretty=%s%n%cI%n%an"]);
      const [message = "", date = "", author = ""] = (raw ?? "").split("\n");
      return { sha, short: sha.slice(0, 7), message, date: date || null, author: author || null };
    }

    // 2) 镜像里没有 .git：用构建时烧进去的 APP_COMMIT（见 Dockerfile 的 ARG）
    const baked = String(process.env.APP_COMMIT ?? "").trim();
    if (baked && baked !== "unknown" && /^[0-9a-f]{7,40}$/i.test(baked)) {
      const buildTime = String(process.env.APP_BUILD_TIME ?? "").trim();
      return {
        sha: baked,
        short: baked.slice(0, 7),
        message: "镜像构建时的提交（容器内没有 .git，无法读取提交说明）",
        date: buildTime && buildTime !== "unknown" ? buildTime : null,
        author: null,
      };
    }

    return null;
  }

  async currentBranch(): Promise<string | null> {
    return await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  async remoteUrl(): Promise<string | null> {
    return await this.git(["remote", "get-url", "origin"]);
  }

  /* ---------------- 远端查询（优先 GitHub API，无需 git fetch） ---------------- */

  /**
   * 查远端最新提交。
   * 优先用 GitHub REST API：不需要 git fetch，容器里没有 git 也能用；
   * 私有仓库没有 token 会拿到 404，此时退回 git ls-remote（能拿到 sha，但拿不到 message）。
   */
  private async latestCommit(branch: string): Promise<{ info: CommitInfo | null; note: string | null }> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const slug = this.deps.repoSlug?.trim();
    if (!slug) return { info: null, note: "未配置仓库地址（REELAX_REPO）" };

    // 1) GitHub API
    try {
      const resp = await doFetch(`https://api.github.com/repos/${slug}/commits/${encodeURIComponent(branch)}`, {
        headers: {
          Accept: "application/vnd.github+json",
          // GitHub 要求带 UA
          "User-Agent": "reelax-server",
          ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) {
        const j = (await resp.json()) as {
          sha?: string;
          commit?: { message?: string; committer?: { date?: string; name?: string }; author?: { name?: string } };
        };
        if (j?.sha) {
          return {
            info: {
              sha: j.sha,
              short: j.sha.slice(0, 7),
              message: (j.commit?.message ?? "").split("\n")[0] ?? "",
              date: j.commit?.committer?.date ?? null,
              author: j.commit?.author?.name ?? j.commit?.committer?.name ?? null,
            },
            note: null,
          };
        }
      } else if (resp.status === 404) {
        return {
          info: null,
          note: `读不到远端提交（HTTP 404）：仓库可能是私有的。设置 GITHUB_TOKEN 环境变量后可见。`,
        };
      } else {
        return { info: null, note: `查询远端失败：HTTP ${resp.status}` };
      }
    } catch (err) {
      return { info: null, note: `查询远端失败：${err instanceof Error ? err.message : String(err)}` };
    }

    // 2) 退化：git ls-remote（只有 sha）
    const ls = await this.git(["ls-remote", "origin", `refs/heads/${branch}`], 15_000);
    if (ls) {
      const sha = ls.split(/\s+/)[0] ?? "";
      if (sha) {
        return {
          info: { sha, short: sha.slice(0, 7), message: "（远端提交信息不可用，请到 GitHub 查看）", date: null, author: null },
          note: null,
        };
      }
    }
    return { info: null, note: "无法确定远端提交" };
  }

  /** 落后多少个提交（需要本地有远端引用；没有就先 fetch 一次） */
  private async behindCount(branch: string): Promise<number | null> {
    const direct = await this.git(["rev-list", "--count", `HEAD..origin/${branch}`]);
    if (direct !== null) {
      const n = Number(direct);
      return Number.isFinite(n) ? n : null;
    }
    // 本地还没有 origin/<branch> 引用，fetch 一次再算（浅仓库/新克隆常见）
    const fetched = await this.git(["fetch", "--quiet", "origin", branch], 30_000);
    if (fetched === null) return null;
    const after = await this.git(["rev-list", "--count", `HEAD..origin/${branch}`]);
    if (after === null) return null;
    const n = Number(after);
    return Number.isFinite(n) ? n : null;
  }

  /* ---------------- 对外：检查更新 ---------------- */

  async check(): Promise<UpdateCheck> {
    const hasGit = isGitWorktree(this.deps.workDir);
    const branch = hasGit ? ((await this.currentBranch()) ?? "main") : "main";

    // currentCommit() 自己会处理「没有 .git」的情况（退回镜像里烧好的 APP_COMMIT），
    // 所以这里**不能**用 hasGit 把它短路掉 —— 之前正是这个守卫导致容器里永远显示「读不到」。
    const [current, remote, remoteUrl, behind] = await Promise.all([
      this.currentCommit(),
      this.latestCommit(branch),
      hasGit ? this.remoteUrl() : Promise.resolve(null),
      hasGit ? this.behindCount(branch) : Promise.resolve(null),
    ]);

    const latest = remote.info;
    // behind 拿不到时，用 sha 是否相同来判断「有没有更新」
    const hasUpdate = behind !== null ? behind > 0 : Boolean(current && latest && current.sha !== latest.sha);
    // ★ 两边都拿到了才算「能比较」。只有一边时 hasUpdate 无意义，
    //   前端据此展示「无法判断」，而不是骗人的「已是最新」。
    const comparable = Boolean(current && latest);

    const updaterAvailable = await this.probeUpdater();

    let manualHint: string | null = null;
    if (!this.deps.allowLocalUpdate && !updaterAvailable) {
      manualHint =
        "当前部署没有开启自动更新。在容器外的仓库目录里执行：\n" +
        "  推荐：./scripts/update.sh          （Windows PowerShell： .\\scripts\\update.ps1）\n" +
        "  它会 git pull --ff-only → 带上 APP_COMMIT 重建镜像 → 重启容器\n" +
        "\n" +
        "手动重建也行，但 ★必须带上 APP_COMMIT，否则「当前版本」永远读不到：\n" +
        "  export APP_COMMIT=$(git rev-parse HEAD)     # PowerShell: $env:APP_COMMIT = (git rev-parse HEAD)\n" +
        "  docker compose up -d --build\n" +
        "\n" +
        "想让这个面板里的「立即更新」可用：docker compose --profile update up -d --build";
    }

    // 当前版本读不到时说清楚原因 —— 否则「已是最新」会误导人以为不用更新
    const notes: string[] = [];
    if (!current) {
      notes.push(
        "当前版本读不到：容器里没有 .git，而且这个镜像是构建时没传 APP_COMMIT 建出来的" +
          "（所以无法判断有没有更新，这不等于「已是最新」）。下次重建请用仓库里的 " +
          "scripts/update.sh / update.ps1，它们会自动带上 APP_COMMIT。",
      );
    }
    if (remote.note) notes.push(remote.note);

    return {
      current,
      latest,
      hasUpdate,
      comparable,
      behindBy: behind,
      branch: hasGit ? branch : null,
      repo: remoteUrl ?? (this.deps.repoSlug ? `https://github.com/${this.deps.repoSlug}` : null),
      canApplyLocal: Boolean(hasGit && this.deps.allowLocalUpdate),
      updaterAvailable,
      manualHint,
      note: notes.length ? notes.join("  ｜  ") : null,
    };
  }

  /** 探测旁路 updater 是否在线 */
  private async probeUpdater(): Promise<boolean> {
    if (!this.deps.updaterUrl) return false;
    const doFetch = this.deps.fetchImpl ?? fetch;
    try {
      const r = await doFetch(`${this.deps.updaterUrl.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  /* ---------------- 对外：应用更新 ---------------- */

  /**
   * 触发更新。
   *  - 有 updater → 让它去 docker compose 重建并重启（容器外动作，最干净）
   *  - 否则（本地部署且允许） → 自行 git pull + 重建前端；重启交给进程管理器
   */
  async apply(opts: { reason: string }): Promise<ApplyResult> {
    if (this.deps.updaterUrl) {
      return await this.applyViaUpdater(opts.reason);
    }
    if (!this.deps.allowLocalUpdate) {
      return {
        ok: false,
        restarting: false,
        message:
          "当前部署未开启自动更新（应用代码在镜像内，容器无法替换自己）。\n" +
          "请在宿主机的仓库目录执行：./scripts/update.sh    （Windows： .\\scripts\\update.ps1）\n" +
          "手动重建也请带上 APP_COMMIT，否则「当前版本」会读不到：\n" +
          "  export APP_COMMIT=$(git rev-parse HEAD) && docker compose up -d --build",
      };
    }
    return await this.applyLocally(opts.reason);
  }

  private async applyViaUpdater(reason: string): Promise<ApplyResult> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const url = `${this.deps.updaterUrl!.replace(/\/+$/, "")}/update`;
    // 与 updater 容器的 UPDATER_TOKEN 对应；没配置就只发 Content-Type
    const token = (this.deps.updaterToken ?? "").trim();
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await r.text();
      if (!r.ok) {
        const hint =
          r.status === 401
            ? "\n（updater 开启了令牌校验：请让 app 的 REELAX_UPDATER_TOKEN 与 updater 的 UPDATER_TOKEN 保持一致）"
            : "";
        return {
          ok: false,
          restarting: false,
          message: `updater 返回 HTTP ${r.status}：${text.slice(0, 300)}${hint}`,
        };
      }
      this.log.info("更新", `已通过 updater 触发更新：${reason}`);
      return {
        ok: true,
        restarting: true,
        message: "已通知更新服务：正在拉取最新代码并重建容器。服务会在约 1 分钟内重启，请稍后刷新页面。",
        log: text.slice(0, 2000),
      };
    } catch (err) {
      return {
        ok: false,
        restarting: false,
        message: `通知 updater 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async applyLocally(reason: string): Promise<ApplyResult> {
    const dir = this.deps.workDir!;

    // 首次进入时初始化进度（前端从这一步开始轮询）
    const before = (await this.git(["rev-parse", "HEAD"]))?.slice(0, 40) ?? null;
    this.setLocalProgress({
      running: true,
      mode: "local",
      step: "git-pull",
      label: STEP_LABELS["git-pull"],
      tail: [`触发原因：${reason}`, `更新前提交：${before ?? "未知"}`],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: null,
      error: null,
      before,
      after: null,
    });

    const run = async (cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> => {
      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          cwd: dir,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { ok: true, out: `${stdout}\n${stderr}`.trim() };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.trim() };
      }
    };

    const lines: string[] = [`触发原因：${reason}`];
    const fail = (message: string): ApplyResult => {
      this.setLocalProgress({
        running: false,
        step: "failed",
        label: STEP_LABELS.failed,
        finishedAt: new Date().toISOString(),
        ok: false,
        error: message,
      });
      return { ok: false, restarting: false, message, log: lines.join("\n") };
    };

    // 1) git pull
    const pull = await run("git", ["pull", "--ff-only"], 120_000);
    lines.push(`\n$ git pull --ff-only\n${pull.out.slice(-4000)}`);
    this.pushLocalLine(`$ git pull --ff-only`);
    this.pushLocalLine(pull.out.slice(-1500) || "(无输出)");
    if (!pull.ok) {
      return fail("git pull 失败（可能有本地改动或需要手动处理冲突），请看下方输出。");
    }

    // 2) 装依赖
    this.setLocalProgress({ step: "install", label: STEP_LABELS.install });
    this.pushLocalLine("$ npm install");
    const install = await run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], 600_000);
    lines.push(`\n$ npm install\n${install.out.slice(-2000)}`);
    this.pushLocalLine(install.out.slice(-800) || "(无输出)");
    if (!install.ok) return fail("依赖安装失败，请看下方输出。");

    // 3) 重建前端
    this.setLocalProgress({ step: "build", label: STEP_LABELS.build });
    this.pushLocalLine("$ npm run build");
    const build = await run("npm", ["run", "build"], 600_000);
    lines.push(`\n$ npm run build\n${build.out.slice(-2000)}`);
    this.pushLocalLine(build.out.slice(-800) || "(无输出)");
    if (!build.ok) return fail("前端构建失败，请看下方输出。");

    this.setLocalProgress({
      running: false,
      step: "done",
      label: STEP_LABELS.done,
      finishedAt: new Date().toISOString(),
      ok: true,
      after: (await this.git(["rev-parse", "HEAD"]))?.slice(0, 40) ?? null,
    });

    this.log.info("更新", `本地更新完成：${reason}`);
    return {
      ok: true,
      restarting: true,
      message:
        "代码已更新、依赖已安装、前端已重建。\n" +
        "进程需要重启才能加载新的后端代码：请重启服务（systemd / pm2 / 前台进程）。\n" +
        "如果你用 Docker 部署，建议启用 updater 服务，以获得真正的「一键更新」体验。",
      log: lines.join("\n"),
    };
  }
}

export type { CommitInfo as UpdateCommitInfo };

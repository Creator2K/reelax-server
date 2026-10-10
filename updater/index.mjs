// 旁路更新器（updater sidecar）
//
// 为什么需要它：应用代码在镜像里，**容器无法替换自己**。
// 所以真正的"一键更新"必须由一个容器外的执行者完成 —— 这个 sidecar 挂了 docker.sock。
//
// 两种模式（UPDATER_MODE = auto | git | pull，默认 auto；见 mode.mjs）：
//   git  ：git pull → docker compose up -d --build（在本机构建镜像）
//   pull ：docker compose pull → up -d（拉 GitHub Actions 预构建好的镜像）
//   auto ：挂载的仓库有 .git 就走 git，否则走 pull（tar 解压的部署只有 pull 可选）
//
// 接口（仅监听内网，不暴露端口到宿主机）：
//   GET  /health  → { ok: true, mode, ... }
//   POST /update  → 触发更新（异步执行，立即返回）
//   GET  /status  → 最近一次更新的进度与输出
//
// 安全：不对外暴露端口；只能被同一 compose 网络里的 app 访问。
// 另外要求带着 UPDATER_TOKEN（如果配置了）才能触发。
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describeMode, parseImageCommit, pullCommands, requiresGitWorktree, resolveMode } from "./mode.mjs";

const PORT = Number(process.env.UPDATER_PORT || 9000);
/** 项目在容器内的挂载点（对应宿主机的仓库目录） */
const PROJECT_DIR = process.env.UPDATER_PROJECT_DIR || "/project";
const COMPOSE_FILE = process.env.UPDATER_COMPOSE_FILE || "docker-compose.yml";
const SERVICE = process.env.UPDATER_SERVICE || "app";
const TOKEN = process.env.UPDATER_TOKEN || "";
/** 拉取后是否重建镜像（仅 git 模式用；纯代码更新可省，但通常都要） */
const REBUILD = process.env.UPDATER_REBUILD !== "0";
/** pull 模式要拉哪个镜像（默认与 docker-compose.yml 里 app 的 image 一致）——只用于读提交号 */
const IMAGE = (process.env.UPDATER_IMAGE || "").trim();
/** 私有仓库拉取凭据（同一 token 也可用于读 commit 信息） */
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();

const hasGitDir = () => fs.existsSync(path.join(PROJECT_DIR, ".git"));
/** 每次用到时再解析：挂了 .git（改成 clone 部署）之后不用重启 updater 也能切到 git 模式 */
const REQUESTED_MODE = process.env.UPDATER_MODE;
const currentMode = () => resolveMode({ requested: REQUESTED_MODE, hasGitDir: hasGitDir() });

const startedAt = Date.now();

/** 同一时刻只允许一个更新在跑 */
let running = false;
let lastResult = null;

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  if (lastResult) {
    lastResult.log.push(line);
    if (lastResult.log.length > 400) lastResult.log.shift();
  }
};

/**
 * 构造执行 git 时的环境变量。
 *
 * ★ 为什么用 GIT_CONFIG_* 而不是把 token 写进 remote URL：
 *   写进 URL 会把 token 留在 .git/config 里（裸机挂载的仓库会被人看到）。
 *   用 http.extraheader 只在这一次命令的环境里生效，不落盘。
 *
 *   basic 认证的用户名可以是任意非空值（GitHub 只认 token），这里用 x-access-token。
 *
 * ★ safe.directory 是给 Linux 用的：updater 以 root 跑，而宿主机的仓库目录
 *   通常属于普通用户，git ≥ 2.35 会直接拒绝（"detected dubious ownership"）。
 *   这里是"我们明确要操作这个挂载进来的目录"，所以把它标成安全目录。
 *   注意两段配置都要写全：GIT_CONFIG_COUNT/KEY_n/VALUE_n 是一组，漏一个就不生效。
 */
function gitConfigEnv(extra = []) {
  const pairs = [["safe.directory", "*"], ...extra];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

function gitEnv() {
  if (!GITHUB_TOKEN) return gitConfigEnv();
  const basic = Buffer.from(`x-access-token:${GITHUB_TOKEN}`, "utf8").toString("base64");
  return gitConfigEnv([["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`]]);
}

function run(cmd, args, timeoutMs = 900_000, env = process.env) {
  return new Promise((resolve) => {
    // 输出里绝不能带 token，这里做一层兜底遮蔽
    const redact = (s) => (GITHUB_TOKEN ? String(s).replaceAll(GITHUB_TOKEN, "***") : String(s));
    log(`$ ${cmd} ${args.join(" ")}`);
    execFile(
      cmd,
      args,
      { cwd: PROJECT_DIR, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        const out = redact(`${stdout ?? ""}${stderr ?? ""}`).trim();
        if (out) {
          for (const line of out.split("\n").slice(-40)) log(`  ${line}`);
        }
        resolve({ ok: !err, out });
      },
    );
  });
}

/** 检查前置条件，给出可操作的诊断（按模式只检查该模式真正需要的） */
function preflight() {
  const mode = currentMode();
  const problems = [];
  if (!fs.existsSync(PROJECT_DIR)) problems.push(`项目目录不存在：${PROJECT_DIR}（检查 volumes 挂载）`);
  if (!fs.existsSync(path.join(PROJECT_DIR, COMPOSE_FILE))) {
    problems.push(`找不到 compose 文件：${path.join(PROJECT_DIR, COMPOSE_FILE)}`);
  }
  if (!fs.existsSync("/var/run/docker.sock")) {
    problems.push("没有挂载 docker.sock（需要 /var/run/docker.sock:/var/run/docker.sock）");
  }
  if (requiresGitWorktree(mode)) {
    if (!hasGitDir()) {
      problems.push(
        `${PROJECT_DIR} 不是 git 工作区（git 模式需要一个 .git 目录）。` +
          "用 tar 包解压的部署请设 UPDATER_MODE=pull，它会改为拉取预构建镜像。",
      );
    }
    // 私有仓库必须给 token，否则 git pull 会卡在要用户名
    const remote = (() => {
      try {
        return fs.readFileSync(path.join(PROJECT_DIR, ".git", "config"), "utf8");
      } catch {
        return "";
      }
    })();
    if (/github\.com/.test(remote) && !GITHUB_TOKEN) {
      problems.push(
        "仓库是 GitHub 上的但没提供 GITHUB_TOKEN：私有仓库拉取会失败（public 仓库不需要）。" +
          "在 .env 里设置 GITHUB_TOKEN 后重启 updater。",
      );
    }
  }
  return problems;
}

/** 读镜像里烧着的提交号（读不到返回 null —— 例如没配 UPDATER_IMAGE） */
async function imageCommit() {
  if (!IMAGE) return null;
  const r = await run(
    "docker",
    ["image", "inspect", IMAGE, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
    60_000,
  );
  return r.ok ? parseImageCommit(r.out) : null;
}

/**
 * pull 模式：拉预构建镜像 + 重启 app。
 * 不在本机构建，所以小机器上几乎不吃 CPU（只下载变化的层）。
 */
async function updateByPull() {
  const before = await imageCommit();
  lastResult.before = before;

  for (const c of pullCommands({ composeFile: COMPOSE_FILE, service: SERVICE })) {
    const r = await run(c.cmd, c.args, c.timeoutMs);
    lastResult.steps.push({ step: c.step, ok: r.ok });
    if (!r.ok) {
      lastResult.ok = false;
      lastResult.error = `${c.step} 失败，请看日志`;
      running = false;
      return lastResult;
    }
  }

  const after = await imageCommit();
  lastResult.after = after;
  lastResult.changed = Boolean(after) && after !== before;
  lastResult.ok = true;
  lastResult.finishedAt = new Date().toISOString();
  log(
    lastResult.changed
      ? `✓ 更新完成：镜像 ${String(before ?? "?").slice(0, 7)} → ${String(after).slice(0, 7)}，app 容器已重启`
      : IMAGE
        ? "✓ 已拉取镜像并重启 app（提交号没变，说明本来就已经是最新）"
        : "✓ 已拉取镜像并重启 app（未配置 UPDATER_IMAGE，无法对比提交号）",
  );
  running = false;
  return lastResult;
}

async function doUpdate(reason) {
  const mode = currentMode();
  running = true;
  lastResult = { startedAt: new Date().toISOString(), reason, mode, ok: null, steps: [], log: [] };
  log(`开始更新：${reason}（模式 ${mode}：${describeMode(mode)}）`);

  const problems = preflight();
  if (problems.length) {
    lastResult.ok = false;
    lastResult.steps.push({ step: "preflight", ok: false, problems });
    for (const p of problems) log(`✗ ${p}`);
    running = false;
    return lastResult;
  }
  lastResult.steps.push({ step: "preflight", ok: true });

  // pull 模式：没有 .git 也能用（tar 部署走的就是这条）
  if (mode === "pull") return await updateByPull();

  // 1) 记录当前提交，便于出问题时回滚
  const before = await run("git", ["rev-parse", "HEAD"], 30_000, gitEnv());
  lastResult.before = before.out.slice(0, 40);

  // 2) 拉代码（带凭据环境；token 不会落盘也不会出现在日志里）
  const pull = await run("git", ["pull", "--ff-only"], 300_000, gitEnv());
  lastResult.steps.push({ step: "git-pull", ok: pull.ok });
  if (!pull.ok) {
    lastResult.ok = false;
    lastResult.error = "git pull 失败（可能有本地改动或冲突）";
    running = false;
    return lastResult;
  }

  const after = await run("git", ["rev-parse", "HEAD"], 30_000, gitEnv());
  lastResult.after = after.out.slice(0, 40);
  const changed = lastResult.before !== lastResult.after;
  lastResult.changed = changed;
  log(changed ? `代码已更新：${lastResult.before?.slice(0, 7)} → ${lastResult.after?.slice(0, 7)}` : "代码无变化");

  if (!changed && REBUILD) {
    // 代码没变也允许重建（例如只想重启），但提示一下
    log("（代码没有变化，仍按配置执行重建）");
  }

  // 3) 重建并重启
  //
  // ★ 关键：这一步会重启 app 容器，但**不会**重启 updater
  //   （updater 是独立的 service 且用了 --no-deps），所以这里可以放心等待。
  //
  // ★ 同时把刚拉到的提交作为 APP_COMMIT 传给构建：
  //   镜像里没有 .git，只能靠构建时烧进去才能在界面上显示"当前版本"。
  //   早先没传这个变量，导致更新后「当前版本」变成读不到。
  const composeArgs = ["compose", "-f", COMPOSE_FILE, "up", "-d", "--no-deps"];
  if (REBUILD) composeArgs.splice(4, 0, "--build");

  const buildEnv = {
    ...process.env,
    ...(lastResult.after ? { APP_COMMIT: lastResult.after } : {}),
    APP_BUILD_TIME: new Date().toISOString(),
  };

  const up = await run("docker", [...composeArgs, SERVICE], 1_800_000, buildEnv);
  lastResult.steps.push({ step: "compose-up", ok: up.ok, rebuild: REBUILD, commit: lastResult.after ?? null });
  if (!up.ok) {
    lastResult.ok = false;
    lastResult.error = "docker compose up 失败，请看日志";
    running = false;
    return lastResult;
  }

  lastResult.ok = true;
  lastResult.finishedAt = new Date().toISOString();
  log("✓ 更新完成，app 容器已重启");
  running = false;
  return lastResult;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  const json = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && url.pathname === "/health") {
    const mode = currentMode();
    json(200, {
      ok: true,
      service: "reelax-updater",
      uptime: Date.now() - startedAt,
      running,
      // app 那边用 mode 决定面板上显示哪条更新路径（git 重建 / 拉取镜像）
      mode,
      modeDescription: describeMode(mode),
      projectDir: PROJECT_DIR,
      // pull 模式不做本机构建，这里如实回报
      rebuild: mode === "git" && REBUILD,
      // 把前置条件问题直接回报，省得用户猜为什么更新失败
      problems: preflight(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    json(200, { running, last: lastResult });
    return;
  }

  if (req.method === "POST" && url.pathname === "/update") {
    // 可选令牌校验（同一 compose 网络内已足够安全，令牌是额外一道）
    if (TOKEN) {
      const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-updater-token"];
      if (provided !== TOKEN) {
        json(401, { ok: false, message: "令牌不正确" });
        return;
      }
    }
    if (running) {
      json(409, { ok: false, message: "已有更新正在进行", status: lastResult });
      return;
    }

    let reason = "手动触发";
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (body?.reason) reason = String(body.reason).slice(0, 200);
      } catch {
        /* 用默认 reason */
      }
      // 异步执行，立刻返回 —— app 那边不会因为等待而超时
      void doUpdate(reason).catch((err) => {
        log(`✗ 更新异常：${err?.message || err}`);
        running = false;
      });
      json(202, { ok: true, message: `已开始更新：${reason}` });
    });
    return;
  }

  json(404, { ok: false, message: "未知接口" });
});

server.listen(PORT, "0.0.0.0", () => {
  const mode = currentMode();
  const problems = preflight();
  console.log(`[updater] 已启动，监听 :${PORT}`);
  console.log(`[updater] 项目目录 ${PROJECT_DIR}，模式 ${mode}（${describeMode(mode)}）`);
  if (problems.length) {
    console.log("[updater] ⚠ 前置条件未满足，更新会失败：");
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log("[updater] 前置条件检查通过");
  }
});

// 优雅退出
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[updater] 收到 ${sig}，退出`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

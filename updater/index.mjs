// 旁路更新器（updater sidecar）
//
// 为什么需要它：应用代码在镜像里，**容器无法替换自己**。
// 所以真正的"一键更新"必须由一个容器外的执行者完成 —— 这个 sidecar 挂了
// docker.sock，可以直接 git pull + docker compose build + up -d。
//
// 接口（仅监听内网，不暴露端口到宿主机）：
//   GET  /health  → { ok: true, ... }
//   POST /update  → 触发更新（异步执行，立即返回）
//   GET  /status  → 最近一次更新的进度与输出
//
// 安全：不对外暴露端口；只能被同一 compose 网络里的 app 访问。
// 另外要求带着 UPDATER_TOKEN（如果配置了）才能触发。
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.UPDATER_PORT || 9000);
/** 项目在容器内的挂载点（对应宿主机的仓库目录） */
const PROJECT_DIR = process.env.UPDATER_PROJECT_DIR || "/project";
const COMPOSE_FILE = process.env.UPDATER_COMPOSE_FILE || "docker-compose.yml";
const SERVICE = process.env.UPDATER_SERVICE || "app";
const TOKEN = process.env.UPDATER_TOKEN || "";
/** 拉取后是否重建镜像（纯代码更新可省，但通常都要） */
const REBUILD = process.env.UPDATER_REBUILD !== "0";
/** 私有仓库拉取凭据（同一 token 也可用于读 commit 信息） */
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();

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
 */
function gitEnv() {
  if (!GITHUB_TOKEN) return process.env;
  const basic = Buffer.from(`x-access-token:${GITHUB_TOKEN}`, "utf8").toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    // 避免凭据助手（容器里也没有）交互式索要用户名
    GIT_TERMINAL_PROMPT: "0",
  };
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

/** 检查前置条件，给出可操作的诊断 */
function preflight() {
  const problems = [];
  if (!fs.existsSync(PROJECT_DIR)) problems.push(`项目目录不存在：${PROJECT_DIR}（检查 volumes 挂载）`);
  if (!fs.existsSync(path.join(PROJECT_DIR, ".git"))) {
    problems.push(`${PROJECT_DIR} 不是 git 工作区（需要一个 .git 目录才能 pull）`);
  }
  if (!fs.existsSync(path.join(PROJECT_DIR, COMPOSE_FILE))) {
    problems.push(`找不到 compose 文件：${path.join(PROJECT_DIR, COMPOSE_FILE)}`);
  }
  if (!fs.existsSync("/var/run/docker.sock")) {
    problems.push("没有挂载 docker.sock（需要 /var/run/docker.sock:/var/run/docker.sock）");
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
  return problems;
}

async function doUpdate(reason) {
  running = true;
  lastResult = { startedAt: new Date().toISOString(), reason, ok: null, steps: [], log: [] };
  log(`开始更新：${reason}`);

  const problems = preflight();
  if (problems.length) {
    lastResult.ok = false;
    lastResult.steps.push({ step: "preflight", ok: false, problems });
    for (const p of problems) log(`✗ ${p}`);
    running = false;
    return lastResult;
  }
  lastResult.steps.push({ step: "preflight", ok: true });

  // 1) 记录当前提交，便于出问题时回滚
  const before = await run("git", ["rev-parse", "HEAD"], 30_000);
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

  const after = await run("git", ["rev-parse", "HEAD"], 30_000);
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
  // ★ 关键：这一步会重启我们自己所在的 app 容器，但**不会**重启 updater
  //   （updater 是独立的 service），所以这里可以放心等待。
  const composeArgs = ["compose", "-f", COMPOSE_FILE, "up", "-d", "--no-deps"];
  if (REBUILD) composeArgs.splice(4, 0, "--build");

  const up = await run("docker", [...composeArgs, SERVICE], 1_800_000);
  lastResult.steps.push({ step: "compose-up", ok: up.ok, rebuild: REBUILD });
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
    json(200, {
      ok: true,
      service: "reelax-updater",
      uptime: Date.now() - startedAt,
      running,
      projectDir: PROJECT_DIR,
      rebuild: REBUILD,
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
  const problems = preflight();
  console.log(`[updater] 已启动，监听 :${PORT}`);
  console.log(`[updater] 项目目录 ${PROJECT_DIR}，重建=${REBUILD}`);
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

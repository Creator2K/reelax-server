// updater 的两种更新模式（纯函数，单独成文件是为了能脱离 HTTP 服务单测）
//
//   git   —— 老路子：git pull → docker compose up -d --build（在**本机**构建镜像）
//   pull  —— 新路子：docker compose pull → up -d（镜像由 GitHub Actions 预构建好推到 GHCR）
//
// 为什么要有 pull：本机构建要跑 npm ci（前后端两次）+ vite 构建 + docker build，
// 小机器上峰值能吃掉 1~2 核、几百 MB 内存和 1~2 GB 磁盘，持续几分钟；
// 拉预构建镜像只是下载几十 MB 的层再重启容器，几秒钟、几乎不吃 CPU。
//
// auto（默认）：挂着的是 git 工作区就走 git，否则走 pull —— 这样
//   · git clone 部署：行为与以前完全一样（想省资源可以显式设 UPDATER_MODE=pull）
//   · tar 解压部署：没有 .git，也能在面板上点「立即更新」
export const MODES = ["auto", "git", "pull"];

/** 实际使用哪种模式 */
export function resolveMode(input) {
  const want = String(input?.requested ?? "auto")
    .trim()
    .toLowerCase();
  if (want === "git" || want === "pull") return want;
  return input?.hasGitDir ? "git" : "pull";
}

/** 给日志与 /health 用的一句话说明 */
export function describeMode(mode) {
  return mode === "git"
    ? "git pull + 在本机构建镜像（需要挂载的仓库里有 .git）"
    : "拉取预构建镜像并重启（不需要 .git，也不在本机构建）";
}

/** 该模式要不要在下发更新前检查 .git / GITHUB_TOKEN */
export function requiresGitWorktree(mode) {
  return mode === "git";
}

/**
 * pull 模式要执行的命令。
 * 返回数组而不是直接跑，便于单测（也便于以后加 step）。
 *
 * `--no-deps`：只动 app 这个 service，别把 updater 自己一起重启了。
 */
export function pullCommands(input) {
  const composeFile = input?.composeFile || "docker-compose.yml";
  const service = input?.service || "app";
  const base = ["compose", "-f", composeFile];
  return [
    { step: "image-pull", cmd: "docker", args: [...base, "pull", service], timeoutMs: 900_000 },
    { step: "compose-up", cmd: "docker", args: [...base, "up", "-d", "--no-deps", service], timeoutMs: 900_000 },
  ];
}

/**
 * 从 `docker image inspect --format {{range .Config.Env}}{{println .}}{{end}}` 的输出里
 * 取出镜像里烧着的提交号（Dockerfile 的 ENV APP_COMMIT）。
 * 拉取前后各读一次，就能告诉用户"这次换到了哪个提交"。
 */
export function parseImageCommit(inspectOutput) {
  const m = /^APP_COMMIT=(.+)$/m.exec(String(inspectOutput ?? ""));
  return m && m[1] ? m[1].trim() : null;
}

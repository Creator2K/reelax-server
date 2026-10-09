#!/usr/bin/env sh
# 一键更新（Linux / macOS 宿主机）
#
# 用法：
#   ./scripts/update.sh            # 拉代码 + 重建 + 重启
#   ./scripts/update.sh --no-build # 只重启（不重建镜像）
#
# 说明：这就是 web 界面上「立即更新」做的事，只是手动执行一遍。
# 也可以启动 updater sidecar，然后在「管理 → 系统 → 在线更新」里点按钮。
set -eu

SERVICE="${SERVICE:-app}"
NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

# 切到仓库根（脚本在 scripts/ 下）
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31m!! %s\033[0m\n' "$1" >&2; exit 1; }

[ -d .git ] || fail "当前目录不是 git 工作区：$ROOT"
[ -f docker-compose.yml ] || fail "找不到 docker-compose.yml"

if [ ! -f .env ]; then
  cat >&2 <<'EOF'
!! 还没有 .env，请先执行：
   cp .env.example .env
   echo "MASTER_KEY=$(openssl rand -hex 32)" >> .env
EOF
  exit 1
fi

step "记录当前提交"
BEFORE="$(git rev-parse --short HEAD)"

step "拉取最新代码（git pull --ff-only）"
git pull --ff-only || fail "git pull 失败：可能有本地改动或冲突"

AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  printf '    代码无变化（%s）\n' "$BEFORE"
else
  printf '\033[32m    代码已更新：%s -> %s\033[0m\n' "$BEFORE" "$AFTER"
fi

if [ "$NO_BUILD" -eq 0 ]; then
  step "重建镜像（并把当前提交烧进镜像，供「检查更新」显示版本）"
  export APP_COMMIT="$(git rev-parse HEAD)"
  export APP_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  docker compose build "$SERVICE" || fail "镜像构建失败"
fi

step "重启容器"
docker compose up -d "$SERVICE" || fail "容器启动失败"

step "等待健康检查"
i=0
while [ "$i" -lt 30 ]; do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 3 "http://127.0.0.1:8580/api/health" >/dev/null 2>&1; then
      printf '\n\033[32m✓ 更新完成，服务已就绪：http://127.0.0.1:8580\033[0m\n'
      exit 0
    fi
  else
    # 没有 curl 就只等一会儿
    sleep 5
    printf '\n\033[32m✓ 容器已重启（未安装 curl，跳过健康检查）\033[0m\n'
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

printf '\n\033[33m!! 服务在 60 秒内未通过健康检查，请查看日志：\033[0m\n'
printf '   docker compose logs --tail=100 %s\n' "$SERVICE"
exit 1

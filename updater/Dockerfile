# Reelax 更新器（updater sidecar）
#
# 它是「容器内一键更新」的执行者：挂了 docker.sock，能：
#   · git 模式  ：git pull + 在本机重建 app 容器（需要挂载的仓库里有 .git）
#   · pull 模式 ：docker compose pull + 重启 app（镜像由 GitHub Actions 预构建推到 GHCR）
# 模式由 UPDATER_MODE 控制（auto / git / pull，默认 auto：有 .git 走 git，否则走 pull）。
# 只有需要在线更新时才启动它（见 docker-compose.yml 里的 profile: update）。
FROM node:24-alpine

# docker CLI（用于 docker compose）+ git（仅 git 模式需要）+ compose 插件
RUN apk add --no-cache docker-cli docker-cli-compose git

WORKDIR /updater
# *.mjs：index.mjs（服务）+ mode.mjs（模式解析，可单测）
COPY *.mjs ./

ENV UPDATER_PORT=9000 \
    UPDATER_PROJECT_DIR=/project \
    UPDATER_COMPOSE_FILE=docker-compose.yml \
    UPDATER_SERVICE=app \
    UPDATER_MODE=auto \
    UPDATER_REBUILD=1

EXPOSE 9000

# 不跑 root：只要能访问 docker.sock 即可（sock 的属组通常是 docker/0）
# 这里保持 root 是为了兼容不同宿主机的 docker.sock 属组，且它只在内网可达。
CMD ["node", "index.mjs"]

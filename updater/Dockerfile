# Reelax 更新器（updater sidecar）
#
# 它是「容器内一键更新」的执行者：挂了 docker.sock，能 git pull + 重建 app 容器。
# 只有需要在线更新时才启动它（见 docker-compose.yml 里的 profile: update）。
FROM node:24-alpine

# docker CLI（用于 docker compose）+ git（用于 pull）+ compose 插件
RUN apk add --no-cache docker-cli docker-cli-compose git

WORKDIR /updater
COPY index.mjs ./

ENV UPDATER_PORT=9000 \
    UPDATER_PROJECT_DIR=/project \
    UPDATER_COMPOSE_FILE=docker-compose.yml \
    UPDATER_SERVICE=app \
    UPDATER_REBUILD=1

EXPOSE 9000

# 不跑 root：只要能访问 docker.sock 即可（sock 的属组通常是 docker/0）
# 这里保持 root 是为了兼容不同宿主机的 docker.sock 属组，且它只在内网可达。
CMD ["node", "index.mjs"]

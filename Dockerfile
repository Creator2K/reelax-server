# Reelax 服务器版 · 生产镜像
#
# 设计要点：
#  1) **零原生依赖** —— SQLite 用 Node 24 内置的 node:sqlite，口令哈希用内置 crypto 的 scrypt，
#     因此不需要在 Alpine 上装 python3 / make / g++，镜像小且构建快。
#  2) 服务端源码**不做编译**：Node 24 能直接运行 .ts（原生类型剥离），
#     少一个构建阶段，也让容器里的代码与仓库一致，排障更直接。
#  3) 前端在构建阶段编译成静态产物，运行镜像只带 dist。
#  4) 以非 root 用户运行；用 tini 作 PID 1 正确转发 SIGTERM（否则 docker stop 会 10 秒后强杀，
#     优雅关闭写不回账号状态）。

# ---- 前端构建 ----
FROM node:24-alpine AS webbuild
WORKDIR /app

# 只拷清单文件，最大化利用层缓存
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json

# 前端构建只需要 web 的依赖（含 vite/tailwind）；--ignore-scripts 避免多余 postinstall
RUN npm ci --no-audit --no-fund --ignore-scripts

COPY web/ web/
RUN npm run build -w web

# ---- 运行镜像 ----
FROM node:24-alpine

# tini：正确转发信号（容器里的 PID 1 默认不转发 SIGTERM）
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# 服务端唯一的运行时依赖
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --workspace server --include-workspace-root=false --no-audit --no-fund --ignore-scripts \
 && npm cache clean --force

# 服务端源码（Node 直接跑 .ts）
COPY server/src/ server/src/

# 前端产物
COPY --from=webbuild /app/web/dist web/dist

# 默认值：容器内必须监听 0.0.0.0 才能被映射出去
ENV PORT=8580 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

EXPOSE 8580
VOLUME ["/app/data"]

# 数据目录属主交给 node（挂载匿名卷时也能写）
RUN mkdir -p /app/data && chown -R node:node /app/data /app
USER node

# 健康检查：直接探测 /api/health（免鉴权）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8580)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.ts"]

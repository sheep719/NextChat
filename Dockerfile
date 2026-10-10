# ---------------------------------------------------------------------------
# NextChat 二开版 —— 单镜像同时托管两个进程
#
#   · Next.js 前端（standalone） :3000
#   · 自建网关 gateway（Fastify + SQLite） :3600
#
# 构建：docker build -t nextchat-fork:0.2.0 .
# 运行：docker run -d -p 3000:3000 -p 3600:3600 nextchat-fork:0.2.0
#
# 基线镜像必须是 Node 22+：网关的 better-sqlite3 v13 声明 engines.node >= 22，
# 且预编译产物按 Node ABI 发布；用 Node 18/20 会退化为源码编译甚至装不上。
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:22-bookworm-slim

# ============================ 1. 前端依赖 ============================
FROM ${NODE_IMAGE} AS web-deps

# 跳过 husky 安装：镜像里没有 .git，而 package.json 的 prepare 钩子会执行
# `husky install`，找不到 .git 会直接让 yarn install 失败。
ENV HUSKY=0
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# node:22-bookworm-slim 自 2025 年起镜像内已预装 corepack/yarn；
# 直接 npm install -g 会报 EEXIST（/usr/local/bin/yarn 已存在）。
# 改为：存在即跳过，缺失才安装。
RUN command -v yarn >/dev/null 2>&1 || npm install -g yarn@1.22.19

COPY package.json yarn.lock ./
# NPM_REGISTRY 可在构建时覆盖为镜像源（如国内 https://registry.npmmirror.com）。
# 注意两点（都是 yarn 1.x + --frozen-lockfile 的坑）：
#   1. yarn 1.x 不读 http_proxy 环境变量，代理对它无效；
#   2. frozen 模式下 tarball 从 yarn.lock 的 resolved URL 下载，--registry 参数
#      只影响解析阶段。因此网络受限环境（如 registry.yarnpkg.com 不可达）必须
#      同时把 lock 里的 resolved 域名重写到可达镜像源，否则 765 个包全部超时。
# REWRITE_LOCK_REGISTRY=1 时启用重写（默认关，保持上游 lockfile 原语义）。
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG REWRITE_LOCK_REGISTRY=0
RUN if [ "$REWRITE_LOCK_REGISTRY" = "1" ]; then \
      sed -i 's|https://registry.yarnpkg.com|'"${NPM_REGISTRY}"'|g' yarn.lock; \
    fi \
    && yarn install --frozen-lockfile --network-timeout 600000 --registry "${NPM_REGISTRY}"

# ============================ 2. 前端构建 ============================
FROM web-deps AS web-build

# 前端里写死的网关默认地址是 http://127.0.0.1:3600。
# 若要用域名/其他端口访问网关，构建时覆盖这个 ARG（会被内联进客户端包）。
ARG NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:3600
ENV NEXT_PUBLIC_GATEWAY_URL=${NEXT_PUBLIC_GATEWAY_URL}
ENV BUILD_MODE=standalone

COPY . .
RUN yarn build

# ============================ 3. 网关依赖 ============================
FROM ${NODE_IMAGE} AS gw-deps

WORKDIR /gw

# better-sqlite3 有 linux-x64 预编译包；命中不到时才会走源码编译，这里备好编译链。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY gateway/package.json gateway/package-lock.json ./
# 保留 devDependencies：运行时入口是 tsx src/server.ts
RUN npm ci

# ============================ 4. 运行镜像 ============================
FROM ${NODE_IMAGE} AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# 数据目录（SQLite 库 + 自动生成的 JWT 密钥）；建议挂卷持久化
ENV DATA_DIR=/gw/data
ENV DB_PATH=/gw/data/gateway.db

# 注意：下面前端那批 COPY 用的是相对路径，必须先 WORKDIR /app，否则会拷到根目录
WORKDIR /app

RUN mkdir -p /gw/data /app/app/mcp \
  && chmod 777 /gw/data /app/app/mcp

# ---- 前端（standalone） ----
COPY --from=web-build /app/public ./public
COPY --from=web-build /app/.next/standalone ./
COPY --from=web-build /app/.next/static ./.next/static
COPY --from=web-build /app/.next/server ./.next/server
COPY --from=web-build /app/app/mcp/mcp_config.default.json /app/app/mcp/mcp_config.json

# ---- 网关 ----
COPY --from=gw-deps /gw/node_modules /gw/node_modules
COPY gateway/package.json /gw/package.json
COPY gateway/src /gw/src

COPY docker/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 3000 3600

VOLUME ["/gw/data"]

# 网关提供 /healthz；只探网关即可反映容器整体可用性
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||3600)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/usr/local/bin/start.sh"]

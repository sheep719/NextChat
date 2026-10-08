#!/usr/bin/env bash
#
# 单容器入口：同时拉起两个进程
#   · Next.js 前端（standalone）  -> 0.0.0.0:${WEB_PORT}   默认 3000
#   · 自建网关 gateway            -> 0.0.0.0:${GATEWAY_PORT} 默认 3600
#
# 设计要点：
#   1. 两个进程都在前台的子进程里跑，任一退出 → 容器整体退出，
#      配合 `docker run --restart=unless-stopped` / compose 的 restart 策略可自愈。
#   2. 收到 SIGTERM/SIGINT 时把信号转发给两个子进程，保证优雅退出。
#   3. 未显式提供 JWT_SECRET 时自动生成并持久化到数据目录，
#      挂卷后重启仍有效 —— 这是"零配置一键启动"的关键（登录功能依赖 JWT）。
#
set -u

WEB_PORT="${WEB_PORT:-3000}"
GATEWAY_PORT="${GATEWAY_PORT:-3600}"
DATA_DIR="${DATA_DIR:-/gw/data}"

mkdir -p "$DATA_DIR"

# ---------------------------------------------------------------------------
# JWT 密钥：网关签发登录令牌必须有 JWT_SECRET（缺失时 /api/auth/login 会 500）。
# 未设置就生成一次并落盘到数据目录，保证重启/重建容器后旧令牌依然有效。
# ---------------------------------------------------------------------------
if [ -z "${JWT_SECRET:-}" ]; then
  if [ -s "$DATA_DIR/.jwt_secret" ]; then
    JWT_SECRET="$(cat "$DATA_DIR/.jwt_secret")"
    echo "[start] 复用已持久化的 JWT_SECRET"
  else
    # 用 node 生成，不依赖 head/base64/tr 等外部命令
    JWT_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(36).toString("base64url"))')"
    printf '%s' "$JWT_SECRET" >"$DATA_DIR/.jwt_secret"
    chmod 600 "$DATA_DIR/.jwt_secret"
    echo "[start] 已生成新的 JWT_SECRET 并写入 $DATA_DIR/.jwt_secret"
  fi
  export JWT_SECRET
fi

# ---------------------------------------------------------------------------
# 网关进程
# 注意：网关默认 HOST=127.0.0.1，容器内必须改成 0.0.0.0，
# 否则宿主 -p 映射不到（这是"端口映射了却连不上"的最常见原因）。
# ---------------------------------------------------------------------------
export HOST="${HOST:-0.0.0.0}"
export PORT="$GATEWAY_PORT"
export DB_PATH="${DB_PATH:-$DATA_DIR/gateway.db}"
# 容器内前端与网关端口不固定，默认放行所有来源；
# 生产环境请显式设置 GATEWAY_CORS_ORIGINS=http://your-host:3000
export GATEWAY_CORS_ORIGINS="${GATEWAY_CORS_ORIGINS:-*}"

cd /gw
echo "[start] gateway -> http://0.0.0.0:${GATEWAY_PORT}  (db: ${DB_PATH})"
node_modules/.bin/tsx src/server.ts &
GW_PID=$!

# ---------------------------------------------------------------------------
# 前端进程（Next.js standalone）。PORT/HOSTNAME 是 next server 读取的变量，
# 只在子进程作用域内覆盖，避免与网关的 PORT 冲突。
# ---------------------------------------------------------------------------
cd /app
echo "[start] web      -> http://0.0.0.0:${WEB_PORT}"
PORT="$WEB_PORT" HOSTNAME=0.0.0.0 node server.js &
WEB_PID=$!

shutdown() {
  echo "[start] 收到退出信号，停止 gateway($GW_PID) 与 web($WEB_PID)"
  kill -TERM "$GW_PID" "$WEB_PID" 2>/dev/null || true
  wait "$GW_PID" "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# 任一进程退出即整体退出（wait -n 需要 bash 4.3+，bookworm 为 5.2）
wait -n
code=$?
echo "[start] 有进程退出（code=$code），容器即将结束"
kill -TERM "$GW_PID" "$WEB_PID" 2>/dev/null || true
exit "$code"

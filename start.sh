#!/bin/sh
# 部署启动脚本 - 解决 FaaS 环境不展开 env var 的问题
PORT="${DEPLOY_RUN_PORT:-5000}"
exec python3 -m http.server "$PORT" --bind 0.0.0.0

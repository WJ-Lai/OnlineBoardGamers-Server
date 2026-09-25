#!/usr/bin/env bash
# FCM MCP Server 启动包装脚本
#
# 用途：给 MCP 客户端（Hermes / Claude / 其他）调用。
#      处理好 cwd、loader hook、环境变量，避免每次手写长命令。
#
# 用法：直接作为 MCP server 命令配置即可（见 README）

set -euo pipefail

MCP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$MCP_DIR/register-hook.mjs"

# 默认值（可被外部环境变量覆盖）
export FCM_BASE_URL="${FCM_BASE_URL:-http://127.0.0.1:8000}"
if [[ -z "${FCM_AGENT_TOKEN:-}" && ( -z "${FCM_USERNAME:-}" || -z "${FCM_PASSWORD:-}" ) ]]; then
  echo "请设置 FCM_AGENT_TOKEN；旧版仅兼容 FCM_USERNAME + FCM_PASSWORD" >&2
  exit 2
fi

# 不要走代理（本地服务）
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy 2>/dev/null || true

cd "$MCP_DIR"
exec node --import "$HOOK" "$MCP_DIR/server.mjs"

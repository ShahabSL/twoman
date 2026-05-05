#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 1
  fi
}

CONFIG_PATH="${1:-local_client/config.json}"
LISTEN_HOST="${TWOMAN_LISTEN_HOST:-127.0.0.1}"
HTTP_PORT="${TWOMAN_HTTP_PORT:-0}"
SOCKS_PORT="${TWOMAN_SOCKS_PORT:-0}"
VERIFY_TLS="${TWOMAN_VERIFY_TLS:-true}"
TWOMAN_HTTP2_CTL="${TWOMAN_HTTP2_CTL:-true}"
TWOMAN_HTTP2_DATA="${TWOMAN_HTTP2_DATA:-false}"
TWOMAN_TRANSPORT="${TWOMAN_TRANSPORT:-http}"
TWOMAN_STREAMING_UP_LANES="${TWOMAN_STREAMING_UP_LANES:-}"
TWOMAN_TRACE="${TWOMAN_TRACE:-0}"
TWOMAN_LOG_DIR="${TWOMAN_LOG_DIR:-local_client/logs}"
TWOMAN_LOG_PATH="${TWOMAN_LOG_PATH:-${TWOMAN_LOG_DIR%/}/helper.log}"
TWOMAN_LISTEN_STATE_PATH="${TWOMAN_LISTEN_STATE_PATH:-local_client/runtime/listen-state.json}"
TWOMAN_IDLE_REPOLL_CTL="${TWOMAN_IDLE_REPOLL_CTL:-0.05}"
TWOMAN_IDLE_REPOLL_DATA="${TWOMAN_IDLE_REPOLL_DATA:-0.1}"
TWOMAN_DATA_UP_MAX_BATCH_BYTES="${TWOMAN_DATA_UP_MAX_BATCH_BYTES:-524288}"
TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS="${TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS:-0.006}"
TWOMAN_DATA_UP_WORKERS="${TWOMAN_DATA_UP_WORKERS:-8}"
TWOMAN_AUTH_MODE="${TWOMAN_AUTH_MODE:-bearer}"
TWOMAN_LEGACY_CUSTOM_HEADERS_ENABLED="${TWOMAN_LEGACY_CUSTOM_HEADERS_ENABLED:-false}"
TWOMAN_BINARY_MEDIA_TYPE="${TWOMAN_BINARY_MEDIA_TYPE:-image/webp}"
if [ -z "${TWOMAN_ROUTE_TEMPLATE:-}" ]; then
  TWOMAN_ROUTE_TEMPLATE='/{lane}/{direction}'
fi
TWOMAN_HEALTH_TEMPLATE="${TWOMAN_HEALTH_TEMPLATE:-/health}"

STREAMING_UP_JSON="[]"
if [ -n "${TWOMAN_STREAMING_UP_LANES}" ]; then
  STREAMING_UP_JSON="$(python3 - <<'PY'
import json, os
values=[item.strip() for item in os.environ["TWOMAN_STREAMING_UP_LANES"].split(",") if item.strip()]
print(json.dumps(values))
PY
)"
fi

if [ ! -f "${CONFIG_PATH}" ]; then
  require_env TWOMAN_BROKER_BASE_URL
  require_env TWOMAN_CLIENT_TOKEN
  mkdir -p "$(dirname "${CONFIG_PATH}")"
  mkdir -p "$(dirname "${TWOMAN_LOG_PATH}")"
  cat > "${CONFIG_PATH}" <<EOF
{
  "transport": "${TWOMAN_TRANSPORT}",
  "transport_profile": "auto",
  "broker_base_url": "${TWOMAN_BROKER_BASE_URL}",
  "client_token": "${TWOMAN_CLIENT_TOKEN}",
  "auth_mode": "${TWOMAN_AUTH_MODE}",
  "legacy_custom_headers_enabled": ${TWOMAN_LEGACY_CUSTOM_HEADERS_ENABLED},
  "binary_media_type": "${TWOMAN_BINARY_MEDIA_TYPE}",
  "route_template": "${TWOMAN_ROUTE_TEMPLATE}",
  "health_template": "${TWOMAN_HEALTH_TEMPLATE}",
  "listen_host": "${LISTEN_HOST}",
  "http_listen_port": ${HTTP_PORT},
  "socks_listen_port": ${SOCKS_PORT},
  "listen_state_path": "${TWOMAN_LISTEN_STATE_PATH}",
  "http_timeout_seconds": 30,
  "heartbeat_interval_seconds": 15,
  "interval_jitter_ratio": 0.2,
  "backoff_initial_delay_seconds": 0.1,
  "backoff_max_delay_seconds": 5,
  "flush_delay_seconds": 0.01,
  "max_batch_bytes": 65536,
  "log_path": "${TWOMAN_LOG_PATH}",
  "verify_tls": ${VERIFY_TLS},
  "upload_profiles": {
    "data": {
      "max_batch_bytes": ${TWOMAN_DATA_UP_MAX_BATCH_BYTES},
      "flush_delay_seconds": ${TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS}
    }
  },
  "up_workers": {
    "data": ${TWOMAN_DATA_UP_WORKERS}
  },
  "streaming_up_lanes": ${STREAMING_UP_JSON},
  "idle_repoll_delay_seconds": {
    "ctl": ${TWOMAN_IDLE_REPOLL_CTL},
    "data": ${TWOMAN_IDLE_REPOLL_DATA}
  },
  "http2_enabled": {
    "ctl": ${TWOMAN_HTTP2_CTL},
    "data": ${TWOMAN_HTTP2_DATA}
  }
}
EOF
fi

mkdir -p "$(dirname "${TWOMAN_LOG_PATH}")"
echo "Local helper log: ${TWOMAN_LOG_PATH}" >&2
if ! command -v go >/dev/null 2>&1; then
  echo "go is required to build the Twoman client runtime" >&2
  exit 1
fi
GO_HELPER_BIN="${TWOMAN_GO_HELPER_BIN:-local_client/runtime/twoman-helper-agent}"
GO_HELPER_BIN="$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "${GO_HELPER_BIN}")"
mkdir -p "$(dirname "${GO_HELPER_BIN}")"
(cd helper-agent && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "${GO_HELPER_BIN}" .)
exec env \
  TWOMAN_TRACE="${TWOMAN_TRACE}" \
  "${GO_HELPER_BIN}" --config "${CONFIG_PATH}" --mode helper

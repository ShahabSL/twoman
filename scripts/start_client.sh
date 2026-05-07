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
TWOMAN_DATA_UP_MAX_BATCH_BYTES="${TWOMAN_DATA_UP_MAX_BATCH_BYTES:-}"
TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS="${TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS:-}"
TWOMAN_DATA_UP_WORKERS="${TWOMAN_DATA_UP_WORKERS:-}"
TWOMAN_ADAPTIVE_UPLOAD_ENABLED="${TWOMAN_ADAPTIVE_UPLOAD_ENABLED:-false}"
TWOMAN_ADAPTIVE_UPLOAD_MIN_WORKERS="${TWOMAN_ADAPTIVE_UPLOAD_MIN_WORKERS:-}"
TWOMAN_ADAPTIVE_UPLOAD_INITIAL_WORKERS="${TWOMAN_ADAPTIVE_UPLOAD_INITIAL_WORKERS:-}"
TWOMAN_ADAPTIVE_UPLOAD_MAX_WORKERS="${TWOMAN_ADAPTIVE_UPLOAD_MAX_WORKERS:-}"
TWOMAN_ADAPTIVE_UPLOAD_MIN_BATCH_BYTES="${TWOMAN_ADAPTIVE_UPLOAD_MIN_BATCH_BYTES:-}"
TWOMAN_ADAPTIVE_UPLOAD_MAX_BATCH_BYTES="${TWOMAN_ADAPTIVE_UPLOAD_MAX_BATCH_BYTES:-}"
TWOMAN_ADAPTIVE_UPLOAD_INCREASE_AFTER_SUCCESSES="${TWOMAN_ADAPTIVE_UPLOAD_INCREASE_AFTER_SUCCESSES:-}"
TWOMAN_ADAPTIVE_UPLOAD_DECREASE_AFTER_ERRORS="${TWOMAN_ADAPTIVE_UPLOAD_DECREASE_AFTER_ERRORS:-}"
TWOMAN_ADAPTIVE_UPLOAD_BACKLOG_THRESHOLD_FRAMES="${TWOMAN_ADAPTIVE_UPLOAD_BACKLOG_THRESHOLD_FRAMES:-}"
TWOMAN_ADAPTIVE_UPLOAD_DECISION_INTERVAL_SECONDS="${TWOMAN_ADAPTIVE_UPLOAD_DECISION_INTERVAL_SECONDS:-}"
TWOMAN_AUTH_MODE="${TWOMAN_AUTH_MODE:-bearer}"
TWOMAN_LEGACY_CUSTOM_HEADERS_ENABLED="${TWOMAN_LEGACY_CUSTOM_HEADERS_ENABLED:-false}"
TWOMAN_BINARY_MEDIA_TYPE="${TWOMAN_BINARY_MEDIA_TYPE:-image/webp}"
TWOMAN_TARGET_AGENT_PEER_LABEL="${TWOMAN_TARGET_AGENT_PEER_LABEL:-}"
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
  export TWOMAN_TRANSPORT TWOMAN_BROKER_BASE_URL TWOMAN_CLIENT_TOKEN TWOMAN_TARGET_AGENT_PEER_LABEL
  export TWOMAN_AUTH_MODE TWOMAN_LEGACY_CUSTOM_HEADERS_ENABLED TWOMAN_BINARY_MEDIA_TYPE
  export TWOMAN_ROUTE_TEMPLATE TWOMAN_HEALTH_TEMPLATE LISTEN_HOST HTTP_PORT SOCKS_PORT
  export TWOMAN_LISTEN_STATE_PATH TWOMAN_LOG_PATH VERIFY_TLS STREAMING_UP_JSON
  export TWOMAN_IDLE_REPOLL_CTL TWOMAN_IDLE_REPOLL_DATA TWOMAN_HTTP2_CTL TWOMAN_HTTP2_DATA
  export TWOMAN_DATA_UP_MAX_BATCH_BYTES TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS TWOMAN_DATA_UP_WORKERS
  export TWOMAN_ADAPTIVE_UPLOAD_ENABLED TWOMAN_ADAPTIVE_UPLOAD_MIN_WORKERS
  export TWOMAN_ADAPTIVE_UPLOAD_INITIAL_WORKERS TWOMAN_ADAPTIVE_UPLOAD_MAX_WORKERS
  export TWOMAN_ADAPTIVE_UPLOAD_MIN_BATCH_BYTES TWOMAN_ADAPTIVE_UPLOAD_MAX_BATCH_BYTES
  export TWOMAN_ADAPTIVE_UPLOAD_INCREASE_AFTER_SUCCESSES TWOMAN_ADAPTIVE_UPLOAD_DECREASE_AFTER_ERRORS
  export TWOMAN_ADAPTIVE_UPLOAD_BACKLOG_THRESHOLD_FRAMES TWOMAN_ADAPTIVE_UPLOAD_DECISION_INTERVAL_SECONDS
  python3 - <<'PY' > "${CONFIG_PATH}"
import json
import os

def as_bool(name):
    return os.environ.get(name, "").lower() in {"1", "true", "yes", "on"}

def maybe_int(name):
    value = os.environ.get(name, "").strip()
    return int(value) if value else None

def maybe_float(name):
    value = os.environ.get(name, "").strip()
    return float(value) if value else None

config = {
    "transport": os.environ["TWOMAN_TRANSPORT"],
    "transport_profile": "auto",
    "broker_base_url": os.environ["TWOMAN_BROKER_BASE_URL"],
    "client_token": os.environ["TWOMAN_CLIENT_TOKEN"],
    "target_agent_peer_label": os.environ.get("TWOMAN_TARGET_AGENT_PEER_LABEL", ""),
    "auth_mode": os.environ["TWOMAN_AUTH_MODE"],
    "legacy_custom_headers_enabled": as_bool("TWOMAN_LEGACY_CUSTOM_HEADERS_ENABLED"),
    "binary_media_type": os.environ["TWOMAN_BINARY_MEDIA_TYPE"],
    "route_template": os.environ["TWOMAN_ROUTE_TEMPLATE"],
    "health_template": os.environ["TWOMAN_HEALTH_TEMPLATE"],
    "listen_host": os.environ["LISTEN_HOST"],
    "http_listen_port": int(os.environ["HTTP_PORT"]),
    "socks_listen_port": int(os.environ["SOCKS_PORT"]),
    "listen_state_path": os.environ["TWOMAN_LISTEN_STATE_PATH"],
    "http_timeout_seconds": 30,
    "heartbeat_interval_seconds": 15,
    "interval_jitter_ratio": 0.2,
    "backoff_initial_delay_seconds": 0.1,
    "backoff_max_delay_seconds": 5,
    "flush_delay_seconds": 0.01,
    "log_path": os.environ["TWOMAN_LOG_PATH"],
    "verify_tls": as_bool("VERIFY_TLS"),
    "streaming_up_lanes": json.loads(os.environ["STREAMING_UP_JSON"]),
    "idle_repoll_delay_seconds": {
        "ctl": float(os.environ["TWOMAN_IDLE_REPOLL_CTL"]),
        "data": float(os.environ["TWOMAN_IDLE_REPOLL_DATA"]),
    },
    "http2_enabled": {
        "ctl": as_bool("TWOMAN_HTTP2_CTL"),
        "data": as_bool("TWOMAN_HTTP2_DATA"),
    },
}
data_profile = {}
if (batch := maybe_int("TWOMAN_DATA_UP_MAX_BATCH_BYTES")):
    data_profile["max_batch_bytes"] = batch
if (flush := maybe_float("TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS")) is not None:
    data_profile["flush_delay_seconds"] = flush
if data_profile:
    config["upload_profiles"] = {"data": data_profile}
if (workers := maybe_int("TWOMAN_DATA_UP_WORKERS")):
    config["up_workers"] = {"data": workers}
if as_bool("TWOMAN_ADAPTIVE_UPLOAD_ENABLED"):
    adaptive = {
        "enabled": True,
        "lanes": ["data"],
    }
    for env_name, key in [
        ("TWOMAN_ADAPTIVE_UPLOAD_MIN_WORKERS", "min_workers"),
        ("TWOMAN_ADAPTIVE_UPLOAD_INITIAL_WORKERS", "initial_workers"),
        ("TWOMAN_ADAPTIVE_UPLOAD_MAX_WORKERS", "max_workers"),
        ("TWOMAN_ADAPTIVE_UPLOAD_MIN_BATCH_BYTES", "min_batch_bytes"),
        ("TWOMAN_ADAPTIVE_UPLOAD_MAX_BATCH_BYTES", "max_batch_bytes"),
        ("TWOMAN_ADAPTIVE_UPLOAD_INCREASE_AFTER_SUCCESSES", "increase_after_successes"),
        ("TWOMAN_ADAPTIVE_UPLOAD_DECREASE_AFTER_ERRORS", "decrease_after_errors"),
        ("TWOMAN_ADAPTIVE_UPLOAD_BACKLOG_THRESHOLD_FRAMES", "backlog_threshold_frames"),
    ]:
        if (value := maybe_int(env_name)):
            adaptive[key] = value
    if (value := maybe_float("TWOMAN_ADAPTIVE_UPLOAD_DECISION_INTERVAL_SECONDS")) is not None:
        adaptive["decision_interval_seconds"] = value
    config["adaptive_upload"] = adaptive
print(json.dumps(config, indent=2))
PY
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

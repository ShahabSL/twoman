#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 1
  fi
}

require_env TWOMAN_REPO_ROOT
require_env TWOMAN_BROKER_BASE_URL
require_env TWOMAN_AGENT_TOKEN

TWOMAN_INSTALL_ROOT="${TWOMAN_INSTALL_ROOT:-/opt/twoman}"
TWOMAN_AGENT_PEER_ID="${TWOMAN_AGENT_PEER_ID:-agent-main}"
TWOMAN_AGENT_SERVICE_NAME="${TWOMAN_AGENT_SERVICE_NAME:-twoman-agent.service}"
TWOMAN_AGENT_SERVICE_USER="${TWOMAN_AGENT_SERVICE_USER:-twoman}"
TWOMAN_AGENT_SERVICE_GROUP="${TWOMAN_AGENT_SERVICE_GROUP:-twoman}"
TWOMAN_WATCHDOG_SERVICE_NAME="${TWOMAN_WATCHDOG_SERVICE_NAME:-twoman-agent-watchdog.service}"
TWOMAN_WATCHDOG_TIMER_NAME="${TWOMAN_WATCHDOG_TIMER_NAME:-twoman-agent-watchdog.timer}"
TWOMAN_VERIFY_TLS="${TWOMAN_VERIFY_TLS:-true}"
TWOMAN_TLS_HANDSHAKE_TIMEOUT_SECONDS="${TWOMAN_TLS_HANDSHAKE_TIMEOUT_SECONDS:-15}"
TWOMAN_HTTP2_CTL="${TWOMAN_HTTP2_CTL:-false}"
TWOMAN_HTTP2_DATA="${TWOMAN_HTTP2_DATA:-false}"
TWOMAN_TRANSPORT="${TWOMAN_TRANSPORT:-http}"
TWOMAN_STREAMING_UP_LANES="${TWOMAN_STREAMING_UP_LANES:-}"
TWOMAN_TRACE="${TWOMAN_TRACE:-0}"
TWOMAN_IDLE_REPOLL_CTL="${TWOMAN_IDLE_REPOLL_CTL:-0.05}"
TWOMAN_IDLE_REPOLL_DATA="${TWOMAN_IDLE_REPOLL_DATA:-0.1}"
TWOMAN_DOWN_READ_TIMEOUT_SECONDS="${TWOMAN_DOWN_READ_TIMEOUT_SECONDS:-10}"
TWOMAN_DOWN_STREAM_MAX_SESSION_SECONDS="${TWOMAN_DOWN_STREAM_MAX_SESSION_SECONDS:-60}"
TWOMAN_DATA_UP_MAX_BATCH_BYTES="${TWOMAN_DATA_UP_MAX_BATCH_BYTES:-524288}"
TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS="${TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS:-0.006}"
TWOMAN_DATA_UP_WORKERS="${TWOMAN_DATA_UP_WORKERS:-8}"
TWOMAN_ADAPTIVE_UPLOAD_ENABLED="${TWOMAN_ADAPTIVE_UPLOAD_ENABLED:-false}"
TWOMAN_ADAPTIVE_UPLOAD_MIN_WORKERS="${TWOMAN_ADAPTIVE_UPLOAD_MIN_WORKERS:-0}"
TWOMAN_ADAPTIVE_UPLOAD_INITIAL_WORKERS="${TWOMAN_ADAPTIVE_UPLOAD_INITIAL_WORKERS:-0}"
TWOMAN_ADAPTIVE_UPLOAD_MAX_WORKERS="${TWOMAN_ADAPTIVE_UPLOAD_MAX_WORKERS:-0}"
TWOMAN_ADAPTIVE_UPLOAD_MIN_BATCH_BYTES="${TWOMAN_ADAPTIVE_UPLOAD_MIN_BATCH_BYTES:-0}"
TWOMAN_ADAPTIVE_UPLOAD_MAX_BATCH_BYTES="${TWOMAN_ADAPTIVE_UPLOAD_MAX_BATCH_BYTES:-0}"
TWOMAN_ADAPTIVE_UPLOAD_INCREASE_AFTER_SUCCESSES="${TWOMAN_ADAPTIVE_UPLOAD_INCREASE_AFTER_SUCCESSES:-16}"
TWOMAN_ADAPTIVE_UPLOAD_DECREASE_AFTER_ERRORS="${TWOMAN_ADAPTIVE_UPLOAD_DECREASE_AFTER_ERRORS:-1}"
TWOMAN_ADAPTIVE_UPLOAD_BACKLOG_THRESHOLD_FRAMES="${TWOMAN_ADAPTIVE_UPLOAD_BACKLOG_THRESHOLD_FRAMES:-128}"
TWOMAN_ADAPTIVE_UPLOAD_DECISION_INTERVAL_SECONDS="${TWOMAN_ADAPTIVE_UPLOAD_DECISION_INTERVAL_SECONDS:-2}"
TWOMAN_PURGE_CONFLICTING_AGENT_UNITS="${TWOMAN_PURGE_CONFLICTING_AGENT_UNITS:-true}"
TWOMAN_MAX_FRAME_PAYLOAD_BYTES="${TWOMAN_MAX_FRAME_PAYLOAD_BYTES:-2097152}"
TWOMAN_SEND_QUEUE_TIMEOUT_SECONDS="${TWOMAN_SEND_QUEUE_TIMEOUT_SECONDS:-5}"
TWOMAN_OPEN_CONNECT_TIMEOUT_SECONDS="${TWOMAN_OPEN_CONNECT_TIMEOUT_SECONDS:-12}"
TWOMAN_PREFER_IPV4="${TWOMAN_PREFER_IPV4:-true}"
TWOMAN_DISABLE_IPV6_ORIGIN="${TWOMAN_DISABLE_IPV6_ORIGIN:-true}"
TWOMAN_HAPPY_EYEBALLS_DELAY_SECONDS="${TWOMAN_HAPPY_EYEBALLS_DELAY_SECONDS:-0.25}"
TWOMAN_UPSTREAM_PROXY_URL="${TWOMAN_UPSTREAM_PROXY_URL:-}"
TWOMAN_UPSTREAM_PROXY_LABEL="${TWOMAN_UPSTREAM_PROXY_LABEL:-}"
TWOMAN_OUTBOUND_PROXY_URL="${TWOMAN_OUTBOUND_PROXY_URL:-}"
TWOMAN_OUTBOUND_PROXY_LABEL="${TWOMAN_OUTBOUND_PROXY_LABEL:-}"
TWOMAN_AUTO_WIREPROXY="${TWOMAN_AUTO_WIREPROXY:-true}"
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

local_wireproxy_port_open() {
  python3 - <<'PY' >/dev/null 2>&1
import socket
s = socket.socket()
s.settimeout(1.0)
try:
    s.connect(("127.0.0.1", 1280))
except OSError:
    raise SystemExit(1)
finally:
    s.close()
PY
}

if [ "${TWOMAN_AUTO_WIREPROXY}" = "true" ] && local_wireproxy_port_open; then
  if [ -z "${TWOMAN_UPSTREAM_PROXY_URL}" ]; then
    TWOMAN_UPSTREAM_PROXY_URL="socks5h://127.0.0.1:1280"
    TWOMAN_UPSTREAM_PROXY_LABEL="wireproxy"
    echo "Detected local WireProxy on 127.0.0.1:1280; routing broker traffic through WARP."
  fi
  if [ -z "${TWOMAN_OUTBOUND_PROXY_URL}" ]; then
    TWOMAN_OUTBOUND_PROXY_URL="${TWOMAN_UPSTREAM_PROXY_URL}"
    TWOMAN_OUTBOUND_PROXY_LABEL="${TWOMAN_UPSTREAM_PROXY_LABEL:-wireproxy}"
    echo "Routing hidden-agent outbound traffic through ${TWOMAN_OUTBOUND_PROXY_LABEL}."
  fi
fi

UPSTREAM_PROXY_JSON="null"
if [ -n "${TWOMAN_UPSTREAM_PROXY_URL}" ]; then
  UPSTREAM_PROXY_JSON="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "${TWOMAN_UPSTREAM_PROXY_URL}")"
fi

OUTBOUND_PROXY_JSON="null"
if [ -n "${TWOMAN_OUTBOUND_PROXY_URL}" ]; then
  OUTBOUND_PROXY_JSON="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "${TWOMAN_OUTBOUND_PROXY_URL}")"
fi

SYSTEMD_AFTER="After=network-online.target"
SYSTEMD_WANTS="Wants=network-online.target"
if [ "${TWOMAN_UPSTREAM_PROXY_LABEL}" = "wireproxy" ] || [ "${TWOMAN_OUTBOUND_PROXY_LABEL}" = "wireproxy" ]; then
  SYSTEMD_AFTER="After=network-online.target wireproxy.service"
  SYSTEMD_WANTS="Wants=network-online.target wireproxy.service"
fi

mkdir -p "${TWOMAN_INSTALL_ROOT}"
install -m 0755 -d "${TWOMAN_INSTALL_ROOT}/logs"

echo "Preparing Twoman hidden-server files in ${TWOMAN_INSTALL_ROOT}..."

install -m 0644 "${TWOMAN_REPO_ROOT}/hidden_server/agent_watchdog.py" "${TWOMAN_INSTALL_ROOT}/agent_watchdog.py"
install -m 0644 "${TWOMAN_REPO_ROOT}/hidden_server/systemd/twoman-agent-watchdog.timer" "${TWOMAN_INSTALL_ROOT}/twoman-agent-watchdog.timer"
chmod 0755 "${TWOMAN_INSTALL_ROOT}/agent_watchdog.py"
if ! command -v go >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y golang-go
  else
    echo "go is required to build the Twoman hidden-agent runtime" >&2
    exit 1
  fi
fi
echo "Building Go hidden-agent runtime..."
(cd "${TWOMAN_REPO_ROOT}/helper-agent" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "${TWOMAN_INSTALL_ROOT}/twoman-helper-agent" .)
chmod 0755 "${TWOMAN_INSTALL_ROOT}/twoman-helper-agent"

CONFIG_JSON="$(cat <<EOF
{
  "transport": "${TWOMAN_TRANSPORT}",
  "transport_profile": "auto",
  "broker_base_url": "${TWOMAN_BROKER_BASE_URL}",
  "upstream_proxy_url": ${UPSTREAM_PROXY_JSON},
  "outbound_proxy_url": ${OUTBOUND_PROXY_JSON},
  "agent_token": "${TWOMAN_AGENT_TOKEN}",
  "auth_mode": "${TWOMAN_AUTH_MODE}",
  "legacy_custom_headers_enabled": ${TWOMAN_LEGACY_CUSTOM_HEADERS_ENABLED},
  "binary_media_type": "${TWOMAN_BINARY_MEDIA_TYPE}",
  "route_template": "${TWOMAN_ROUTE_TEMPLATE}",
  "health_template": "${TWOMAN_HEALTH_TEMPLATE}",
  "http_timeout_seconds": 30,
  "tls_handshake_timeout_seconds": ${TWOMAN_TLS_HANDSHAKE_TIMEOUT_SECONDS},
  "heartbeat_interval_seconds": 15,
  "down_read_timeout_seconds": ${TWOMAN_DOWN_READ_TIMEOUT_SECONDS},
  "down_stream_max_session_seconds": ${TWOMAN_DOWN_STREAM_MAX_SESSION_SECONDS},
  "interval_jitter_ratio": 0.2,
  "backoff_initial_delay_seconds": 0.1,
  "backoff_max_delay_seconds": 5,
  "flush_delay_seconds": 0.01,
  "max_batch_bytes": 65536,
  "max_frame_payload_bytes": ${TWOMAN_MAX_FRAME_PAYLOAD_BYTES},
  "send_queue_timeout_seconds": ${TWOMAN_SEND_QUEUE_TIMEOUT_SECONDS},
  "verify_tls": ${TWOMAN_VERIFY_TLS},
  "peer_id": "${TWOMAN_AGENT_PEER_ID}",
  "outbound_proxy_label": "${TWOMAN_OUTBOUND_PROXY_LABEL}",
  "open_connect_timeout_seconds": ${TWOMAN_OPEN_CONNECT_TIMEOUT_SECONDS},
  "prefer_ipv4": ${TWOMAN_PREFER_IPV4},
  "disable_ipv6_origin": ${TWOMAN_DISABLE_IPV6_ORIGIN},
  "happy_eyeballs_delay_seconds": ${TWOMAN_HAPPY_EYEBALLS_DELAY_SECONDS},
  "upload_profiles": {
    "data": {
      "max_batch_bytes": ${TWOMAN_DATA_UP_MAX_BATCH_BYTES},
      "flush_delay_seconds": ${TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS}
    }
  },
  "up_workers": {
    "data": ${TWOMAN_DATA_UP_WORKERS}
  },
  "adaptive_upload": {
    "enabled": ${TWOMAN_ADAPTIVE_UPLOAD_ENABLED},
    "lanes": ["data"],
    "min_workers": ${TWOMAN_ADAPTIVE_UPLOAD_MIN_WORKERS},
    "initial_workers": ${TWOMAN_ADAPTIVE_UPLOAD_INITIAL_WORKERS},
    "max_workers": ${TWOMAN_ADAPTIVE_UPLOAD_MAX_WORKERS},
    "min_batch_bytes": ${TWOMAN_ADAPTIVE_UPLOAD_MIN_BATCH_BYTES},
    "max_batch_bytes": ${TWOMAN_ADAPTIVE_UPLOAD_MAX_BATCH_BYTES},
    "increase_after_successes": ${TWOMAN_ADAPTIVE_UPLOAD_INCREASE_AFTER_SUCCESSES},
    "decrease_after_errors": ${TWOMAN_ADAPTIVE_UPLOAD_DECREASE_AFTER_ERRORS},
    "backlog_threshold_frames": ${TWOMAN_ADAPTIVE_UPLOAD_BACKLOG_THRESHOLD_FRAMES},
    "decision_interval_seconds": ${TWOMAN_ADAPTIVE_UPLOAD_DECISION_INTERVAL_SECONDS}
  },
  "streaming_up_lanes": ${STREAMING_UP_JSON},
  "idle_repoll_delay_seconds": {
    "ctl": ${TWOMAN_IDLE_REPOLL_CTL},
    "data": ${TWOMAN_IDLE_REPOLL_DATA}
  },
  "http2_enabled": {
    "ctl": ${TWOMAN_HTTP2_CTL},
    "data": ${TWOMAN_HTTP2_DATA}
  },
  "log_path": "${TWOMAN_INSTALL_ROOT}/logs/agent.log",
  "event_log_path": "${TWOMAN_INSTALL_ROOT}/logs/agent-events.ndjson"
}
EOF
)"

cat > "${TWOMAN_INSTALL_ROOT}/config.json" <<EOF
${CONFIG_JSON}
EOF
chmod 0600 "${TWOMAN_INSTALL_ROOT}/config.json"

getent group "${TWOMAN_AGENT_SERVICE_GROUP}" >/dev/null 2>&1 || groupadd --system "${TWOMAN_AGENT_SERVICE_GROUP}"
id -u "${TWOMAN_AGENT_SERVICE_USER}" >/dev/null 2>&1 || useradd --system --gid "${TWOMAN_AGENT_SERVICE_GROUP}" --home-dir "${TWOMAN_INSTALL_ROOT}" --shell /usr/sbin/nologin "${TWOMAN_AGENT_SERVICE_USER}"

chown -R "${TWOMAN_AGENT_SERVICE_USER}:${TWOMAN_AGENT_SERVICE_GROUP}" "${TWOMAN_INSTALL_ROOT}"

SERVICE_CONTENT="$(cat <<EOF
[Unit]
Description=Twoman Go hidden agent
${SYSTEMD_AFTER}
${SYSTEMD_WANTS}

[Service]
Type=simple
WorkingDirectory=${TWOMAN_INSTALL_ROOT}
User=${TWOMAN_AGENT_SERVICE_USER}
Group=${TWOMAN_AGENT_SERVICE_GROUP}
Environment=TWOMAN_TRACE=${TWOMAN_TRACE}
ExecStart=${TWOMAN_INSTALL_ROOT}/twoman-helper-agent --config ${TWOMAN_INSTALL_ROOT}/config.json --mode agent
Restart=always
RestartSec=2
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${TWOMAN_INSTALL_ROOT}
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
)"

WATCHDOG_SERVICE_CONTENT="$(cat <<EOF
[Unit]
Description=Twoman agent watchdog
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 ${TWOMAN_INSTALL_ROOT}/agent_watchdog.py --service ${TWOMAN_AGENT_SERVICE_NAME} --fd-threshold 16384 --close-wait-threshold 256
EOF
)"

cat > "/etc/systemd/system/${TWOMAN_AGENT_SERVICE_NAME}" <<EOF
${SERVICE_CONTENT}
EOF
cat > "/etc/systemd/system/${TWOMAN_WATCHDOG_SERVICE_NAME}" <<EOF
${WATCHDOG_SERVICE_CONTENT}
EOF
install -m 0644 "${TWOMAN_INSTALL_ROOT}/twoman-agent-watchdog.timer" "/etc/systemd/system/${TWOMAN_WATCHDOG_TIMER_NAME}"

echo "Compiling the hidden-agent runtime..."
/usr/bin/python3 -m py_compile "${TWOMAN_INSTALL_ROOT}/agent_watchdog.py"
echo "Enabling and starting Twoman systemd services..."
systemctl daemon-reload
if [ "${TWOMAN_PURGE_CONFLICTING_AGENT_UNITS}" = "true" ]; then
  systemctl list-unit-files 'twoman*.service' 'twoman*.timer' --no-legend --no-pager 2>/dev/null | awk '{print $1}' | while read -r unit; do
    [ -n "${unit}" ] || continue
    case "${unit}" in
      "${TWOMAN_AGENT_SERVICE_NAME}"|"${TWOMAN_WATCHDOG_SERVICE_NAME}"|"${TWOMAN_WATCHDOG_TIMER_NAME}") continue ;;
    esac
    content="$(systemctl cat "${unit}" 2>/dev/null || true)"
    case "${unit} ${content}" in
      *twoman-helper-agent*--mode\ agent*|*twoman-agent*|*twoman-nima*|*twoman-toork*|*twoman-server2*)
        systemctl stop "${unit}" >/dev/null 2>&1 || true
        systemctl disable "${unit}" >/dev/null 2>&1 || true
        systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
        ;;
    esac
  done
  systemctl daemon-reload
fi
systemctl enable --now "${TWOMAN_AGENT_SERVICE_NAME}"
systemctl enable --now "${TWOMAN_WATCHDOG_TIMER_NAME}"
systemctl restart "${TWOMAN_AGENT_SERVICE_NAME}"
systemctl start "${TWOMAN_WATCHDOG_SERVICE_NAME}"
systemctl is-active "${TWOMAN_AGENT_SERVICE_NAME}"
systemctl is-active "${TWOMAN_WATCHDOG_TIMER_NAME}"

#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 1
  fi
}

require_env TWOMAN_SERVER_HOST
require_env TWOMAN_SERVER_USER
require_env TWOMAN_BROKER_BASE_URL
require_env TWOMAN_AGENT_TOKEN

TWOMAN_SERVER_PORT="${TWOMAN_SERVER_PORT:-22}"
TWOMAN_SERVER_DIR="${TWOMAN_SERVER_DIR:-/opt/twoman}"
TWOMAN_AGENT_PEER_ID="${TWOMAN_AGENT_PEER_ID:-agent-main}"
TWOMAN_SERVER_PASSWORD="${TWOMAN_SERVER_PASSWORD:-}"
TWOMAN_SERVER_SSH_KEY="${TWOMAN_SERVER_SSH_KEY:-}"
TWOMAN_SSH_USER_KNOWN_HOSTS_FILE="${TWOMAN_SSH_USER_KNOWN_HOSTS_FILE:-}"
TWOMAN_SSH_UPDATE_HOSTKEYS="${TWOMAN_SSH_UPDATE_HOSTKEYS:-}"
TWOMAN_AGENT_SERVICE_NAME="${TWOMAN_AGENT_SERVICE_NAME:-twoman-agent.service}"
TWOMAN_WATCHDOG_SERVICE_NAME="${TWOMAN_WATCHDOG_SERVICE_NAME:-twoman-agent-watchdog.service}"
TWOMAN_WATCHDOG_TIMER_NAME="${TWOMAN_WATCHDOG_TIMER_NAME:-twoman-agent-watchdog.timer}"
TWOMAN_VERIFY_TLS="${TWOMAN_VERIFY_TLS:-true}"
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
TWOMAN_MAX_FRAME_PAYLOAD_BYTES="${TWOMAN_MAX_FRAME_PAYLOAD_BYTES:-2097152}"
TWOMAN_SEND_QUEUE_TIMEOUT_SECONDS="${TWOMAN_SEND_QUEUE_TIMEOUT_SECONDS:-5}"
TWOMAN_OPEN_CONNECT_TIMEOUT_SECONDS="${TWOMAN_OPEN_CONNECT_TIMEOUT_SECONDS:-12}"
TWOMAN_PREFER_IPV4="${TWOMAN_PREFER_IPV4:-true}"
TWOMAN_DISABLE_IPV6_ORIGIN="${TWOMAN_DISABLE_IPV6_ORIGIN:-false}"
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
TWOMAN_AGENT_SERVICE_USER="${TWOMAN_AGENT_SERVICE_USER:-twoman}"
TWOMAN_AGENT_SERVICE_GROUP="${TWOMAN_AGENT_SERVICE_GROUP:-twoman}"

TMP_GO_BIN=""
cleanup() {
  if [ -n "${TMP_GO_BIN}" ] && [ -f "${TMP_GO_BIN}" ]; then
    rm -f "${TMP_GO_BIN}"
  fi
}
trap cleanup EXIT

STREAMING_UP_JSON="[]"
if [ -n "${TWOMAN_STREAMING_UP_LANES}" ]; then
  STREAMING_UP_JSON="$(python3 - <<'PY'
import json, os
values=[item.strip() for item in os.environ["TWOMAN_STREAMING_UP_LANES"].split(",") if item.strip()]
print(json.dumps(values))
PY
)"
fi

SSH_OPTS=(-p "${TWOMAN_SERVER_PORT}" -o StrictHostKeyChecking=no)
SCP_OPTS=(-P "${TWOMAN_SERVER_PORT}" -o StrictHostKeyChecking=no)
if [ -n "${TWOMAN_SSH_USER_KNOWN_HOSTS_FILE}" ]; then
  SSH_OPTS+=(-o "UserKnownHostsFile=${TWOMAN_SSH_USER_KNOWN_HOSTS_FILE}")
  SCP_OPTS+=(-o "UserKnownHostsFile=${TWOMAN_SSH_USER_KNOWN_HOSTS_FILE}")
fi
if [ -n "${TWOMAN_SSH_UPDATE_HOSTKEYS}" ]; then
  SSH_OPTS+=(-o "UpdateHostKeys=${TWOMAN_SSH_UPDATE_HOSTKEYS}")
  SCP_OPTS+=(-o "UpdateHostKeys=${TWOMAN_SSH_UPDATE_HOSTKEYS}")
fi
if { scp -O 2>&1 || true; } | grep -q '^usage: scp'; then
  SCP_OPTS=(-O "${SCP_OPTS[@]}")
fi
if [ -n "${TWOMAN_SERVER_SSH_KEY}" ]; then
  SSH_OPTS+=(-i "${TWOMAN_SERVER_SSH_KEY}")
  SCP_OPTS+=(-i "${TWOMAN_SERVER_SSH_KEY}")
fi
SCP_CMD=(scp "${SCP_OPTS[@]}")
SSH_CMD=(ssh "${SSH_OPTS[@]}")
if [ -n "${TWOMAN_SERVER_PASSWORD}" ]; then
  SCP_CMD=(sshpass -p "${TWOMAN_SERVER_PASSWORD}" "${SCP_CMD[@]}")
  SSH_CMD=(sshpass -p "${TWOMAN_SERVER_PASSWORD}" "${SSH_CMD[@]}")
fi

remote_wireproxy_port_open() {
  "${SSH_CMD[@]}" "${TWOMAN_SERVER_USER}@${TWOMAN_SERVER_HOST}" "python3 - <<'PY'
import socket
s = socket.socket()
s.settimeout(1.0)
try:
    s.connect(('127.0.0.1', 1280))
except OSError:
    raise SystemExit(1)
finally:
    s.close()
PY
" >/dev/null 2>&1
}

if [ "${TWOMAN_AUTO_WIREPROXY}" = "true" ] && remote_wireproxy_port_open; then
  if [ -z "${TWOMAN_UPSTREAM_PROXY_URL}" ]; then
    TWOMAN_UPSTREAM_PROXY_URL="socks5h://127.0.0.1:1280"
    TWOMAN_UPSTREAM_PROXY_LABEL="wireproxy"
    echo "Detected remote WireProxy on 127.0.0.1:1280; routing broker traffic through WARP."
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

remote_goarch() {
  local machine="$1"
  case "${machine}" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l|armv7*) echo "arm" ;;
    *) echo "unsupported:${machine}" ;;
  esac
}

build_go_agent_binary() {
  if ! command -v go >/dev/null 2>&1; then
    echo "go is required to build the Go hidden-agent runtime" >&2
    exit 1
  fi
  local machine goarch
  machine="$("${SSH_CMD[@]}" "${TWOMAN_SERVER_USER}@${TWOMAN_SERVER_HOST}" "uname -m")"
  goarch="$(remote_goarch "${machine}")"
  if [[ "${goarch}" == unsupported:* ]]; then
    echo "unsupported remote architecture for Go runtime: ${machine}" >&2
    exit 1
  fi
  TMP_GO_BIN="$(mktemp)"
  echo "Building Go hidden-agent runtime for linux/${goarch}..."
  (cd helper-agent && CGO_ENABLED=0 GOOS=linux GOARCH="${goarch}" go build -trimpath -ldflags "-s -w" -o "${TMP_GO_BIN}" .)
}

build_go_agent_binary

echo "Creating remote directory..."
"${SSH_CMD[@]}" "${TWOMAN_SERVER_USER}@${TWOMAN_SERVER_HOST}" "mkdir -p '${TWOMAN_SERVER_DIR}/systemd'"

echo "Uploading agent files..."
"${SCP_CMD[@]}" \
  "${TMP_GO_BIN}" \
  hidden_server/agent_watchdog.py \
  "${TWOMAN_SERVER_USER}@${TWOMAN_SERVER_HOST}:${TWOMAN_SERVER_DIR}/"
"${SSH_CMD[@]}" "${TWOMAN_SERVER_USER}@${TWOMAN_SERVER_HOST}" "mv '${TWOMAN_SERVER_DIR}/$(basename "${TMP_GO_BIN}")' '${TWOMAN_SERVER_DIR}/twoman-helper-agent' && chmod 0755 '${TWOMAN_SERVER_DIR}/twoman-helper-agent'"

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
  "heartbeat_interval_seconds": 15,
  "interval_jitter_ratio": 0.2,
  "down_read_timeout_seconds": ${TWOMAN_DOWN_READ_TIMEOUT_SECONDS},
  "down_stream_max_session_seconds": ${TWOMAN_DOWN_STREAM_MAX_SESSION_SECONDS},
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
)"

SERVICE_CONTENT="$(cat <<EOF
[Unit]
Description=Twoman Go hidden agent
${SYSTEMD_AFTER}
${SYSTEMD_WANTS}

[Service]
Type=simple
WorkingDirectory=${TWOMAN_SERVER_DIR}
User=${TWOMAN_AGENT_SERVICE_USER}
Group=${TWOMAN_AGENT_SERVICE_GROUP}
Environment=TWOMAN_TRACE=${TWOMAN_TRACE}
ExecStart=${TWOMAN_SERVER_DIR}/twoman-helper-agent --config ${TWOMAN_SERVER_DIR}/config.json --mode agent
Restart=always
RestartSec=2
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${TWOMAN_SERVER_DIR}
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
ExecStart=/usr/bin/python3 ${TWOMAN_SERVER_DIR}/agent_watchdog.py --service ${TWOMAN_AGENT_SERVICE_NAME} --fd-threshold 16384 --close-wait-threshold 256
EOF
)"

WATCHDOG_TIMER_CONTENT="$(cat <<EOF
[Unit]
Description=Run Twoman agent watchdog every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
Unit=${TWOMAN_WATCHDOG_SERVICE_NAME}

[Install]
WantedBy=timers.target
EOF
)"

RUNTIME_INSTALL_COMMANDS="$(cat <<EOF
chmod 755 '${TWOMAN_SERVER_DIR}/twoman-helper-agent' '${TWOMAN_SERVER_DIR}/agent_watchdog.py'
/usr/bin/python3 -m py_compile '${TWOMAN_SERVER_DIR}/agent_watchdog.py'
EOF
)"

echo "Installing remote config and services..."
"${SSH_CMD[@]}" "${TWOMAN_SERVER_USER}@${TWOMAN_SERVER_HOST}" "cat > '${TWOMAN_SERVER_DIR}/config.json' <<'EOF'
${CONFIG_JSON}
EOF
getent group '${TWOMAN_AGENT_SERVICE_GROUP}' >/dev/null 2>&1 || groupadd --system '${TWOMAN_AGENT_SERVICE_GROUP}'
id -u '${TWOMAN_AGENT_SERVICE_USER}' >/dev/null 2>&1 || useradd --system --gid '${TWOMAN_AGENT_SERVICE_GROUP}' --home-dir '${TWOMAN_SERVER_DIR}' --shell /usr/sbin/nologin '${TWOMAN_AGENT_SERVICE_USER}'
chown -R '${TWOMAN_AGENT_SERVICE_USER}:${TWOMAN_AGENT_SERVICE_GROUP}' '${TWOMAN_SERVER_DIR}'
cat > '/etc/systemd/system/${TWOMAN_AGENT_SERVICE_NAME}' <<'EOF'
${SERVICE_CONTENT}
EOF
cat > '/etc/systemd/system/${TWOMAN_WATCHDOG_SERVICE_NAME}' <<'EOF'
${WATCHDOG_SERVICE_CONTENT}
EOF
cat > '/etc/systemd/system/${TWOMAN_WATCHDOG_TIMER_NAME}' <<'EOF'
${WATCHDOG_TIMER_CONTENT}
EOF
${RUNTIME_INSTALL_COMMANDS}
systemctl daemon-reload
systemctl enable --now '${TWOMAN_AGENT_SERVICE_NAME}'
systemctl enable --now '${TWOMAN_WATCHDOG_TIMER_NAME}'
systemctl restart '${TWOMAN_AGENT_SERVICE_NAME}'
systemctl start '${TWOMAN_WATCHDOG_SERVICE_NAME}'
systemctl is-active '${TWOMAN_AGENT_SERVICE_NAME}'
systemctl is-active '${TWOMAN_WATCHDOG_TIMER_NAME}'
"

echo "Hidden server deployment complete."

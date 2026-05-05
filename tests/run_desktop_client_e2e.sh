#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$ROOT/tests/tmp-desktop"
STATE_DIR="$TMP_DIR/state"

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR" "$ROOT/tests/certs"

if [ ! -d "$ROOT/host/node_selector/node_modules/ws" ]; then
  (
    cd "$ROOT/host/node_selector"
    npm ci >/dev/null
  )
fi

(
  cd "$ROOT/helper-agent"
  go build -trimpath -ldflags "-s -w" -o "$TMP_DIR/twoman-helper-agent" .
)

cat > "$TMP_DIR/broker-config.json" <<'JSON'
{
  "client_tokens": ["test-client-token"],
  "agent_tokens": ["test-agent-token"],
  "binary_media_type": "image/webp",
  "peer_ttl_seconds": 90,
  "stream_ttl_seconds": 300,
  "max_lane_bytes": 16777216,
  "max_peer_buffered_bytes": 33554432,
  "max_frame_payload_bytes": 2097152,
  "down_wait_ms": { "ctl": 75, "data": 75 },
  "helper_down_combined_data_lane": true,
  "agent_down_combined_data_lane": true,
  "streaming_data_down_helper": true,
  "streaming_data_down_agent": true,
  "base_uri": "/api/v1/telemetry"
}
JSON

cat > "$TMP_DIR/agent.json" <<'JSON'
{
  "broker_base_url": "http://127.0.0.1:18093/api/v1/telemetry",
  "agent_token": "test-agent-token",
  "auth_mode": "bearer",
  "binary_media_type": "image/webp",
  "route_template": "/{lane}/{direction}",
  "health_template": "/health",
  "peer_id": "agent-test",
  "http_timeout_seconds": 10,
  "flush_delay_seconds": 0.01,
  "max_batch_bytes": 131072,
  "http2_enabled": {
    "ctl": false,
    "data": false
  }
}
JSON

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$ROOT/tests/certs/localhost-key.pem" \
  -out "$ROOT/tests/certs/localhost.pem" \
  -subj "/CN=localhost" \
  -days 1 >/dev/null 2>&1

cleanup() {
  python3 - "$STATE_DIR" <<'PY' >/dev/null 2>&1 || true
from pathlib import Path
import sys
from desktop_client.controller import DesktopController
from desktop_client.paths import DesktopPaths

controller = DesktopController(DesktopPaths(Path(sys.argv[1])))
for share in controller.list_shares():
    try:
        controller.stop_share(share.id)
    except Exception:
        pass
try:
    controller.disconnect()
except Exception:
    pass
PY
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP_DIR" "$ROOT/tests/certs"
}
trap cleanup EXIT
PIDS=()

PORT=18093 TWOMAN_TRACE=1 TWOMAN_DEBUG_STATS=1 TWOMAN_CONFIG_PATH="$TMP_DIR/broker-config.json" node "$ROOT/host/node_selector/broker.js" \
  >"$TMP_DIR/broker.log" 2>&1 &
PIDS+=($!)

python3 "$ROOT/tests/origin_server.py" >"$TMP_DIR/origin.log" 2>&1 &
PIDS+=($!)

python3 "$ROOT/tests/tls_origin_server.py" >"$TMP_DIR/tls.log" 2>&1 &
PIDS+=($!)

"$TMP_DIR/twoman-helper-agent" --mode agent --config "$TMP_DIR/agent.json" >"$TMP_DIR/agent.log" 2>&1 &
PIDS+=($!)

wait_for_port() {
  local host="$1"
  local port="$2"
  local label="$3"
  for _ in $(seq 1 50); do
    if python3 - "$host" "$port" <<'PY' >/dev/null 2>&1
import socket
import sys
sock = socket.socket()
sock.settimeout(0.2)
try:
    sock.connect((sys.argv[1], int(sys.argv[2])))
finally:
    sock.close()
PY
    then
      return 0
    fi
    sleep 0.2
  done
  echo "Timed out waiting for $label on $host:$port" >&2
  [ -f "$TMP_DIR/broker.log" ] && cat "$TMP_DIR/broker.log" >&2 || true
  [ -f "$TMP_DIR/agent.log" ] && cat "$TMP_DIR/agent.log" >&2 || true
  [ -f "$TMP_DIR/origin.log" ] && cat "$TMP_DIR/origin.log" >&2 || true
  [ -f "$TMP_DIR/tls.log" ] && cat "$TMP_DIR/tls.log" >&2 || true
  return 1
}

wait_for_port 127.0.0.1 18093 broker
wait_for_port 127.0.0.1 19090 origin
wait_for_port 127.0.0.1 19443 tls-origin

TWOMAN_DESKTOP_STATE_DIR="$STATE_DIR" PYTHONPATH="$ROOT" python3 - <<'PY'
from pathlib import Path
from desktop_client.controller import DesktopController
from desktop_client.models import ClientProfile, SharedSocksProxy
from desktop_client.paths import DesktopPaths

paths = DesktopPaths(Path(Path.cwd() / "tests" / "tmp-desktop" / "state")).ensure()
controller = DesktopController(paths)
profile = ClientProfile(
    name="Desktop test",
    broker_base_url="http://127.0.0.1:18093/api/v1/telemetry",
    client_token="test-client-token",
    http_port=28081,
    socks_port=21081,
    verify_tls=False,
    http2_ctl=False,
    http2_data=False,
)
controller.save_profile(profile)
controller.connect(profile.id)
share = SharedSocksProxy(
    name="Gateway test",
    listen_host="127.0.0.1",
    listen_port=31081,
    target_host="127.0.0.1",
    target_port=profile.socks_port,
    username="desktop-user",
    password="desktop-pass",
)
controller.save_share(share)
controller.start_share(share.id)
print("READY")
PY

wait_for_port 127.0.0.1 28081 desktop-http
wait_for_port 127.0.0.1 21081 desktop-socks
wait_for_port 127.0.0.1 31081 desktop-share

curl --fail --silent --show-error \
  --proxy "socks5h://desktop-user:desktop-pass@127.0.0.1:31081" \
  "http://127.0.0.1:19090/socks-test?via=desktop-share" \
  > "$TMP_DIR/desktop-share.json"

python3 - "$TMP_DIR/desktop-share.json" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
assert payload["path"] == "/socks-test?via=desktop-share", payload
assert payload["method"] == "GET", payload
PY

curl --fail --silent --show-error --insecure \
  --proxy "socks5h://desktop-user:desktop-pass@127.0.0.1:31081" \
  "https://127.0.0.1:19443/secure-test?via=desktop-share" \
  > "$TMP_DIR/desktop-share-secure.txt"

grep -q 'secure:/secure-test?via=desktop-share' "$TMP_DIR/desktop-share-secure.txt"

echo "TWOMAN DESKTOP E2E OK"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$ROOT/tests/tmp-go-node-http"

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
  "broker_base_url": "http://127.0.0.1:18105/api/v1/telemetry",
  "agent_token": "test-agent-token",
  "auth_mode": "bearer",
  "binary_media_type": "image/webp",
  "route_template": "/{lane}/{direction}",
  "health_template": "/health",
  "peer_id": "agent-test",
  "http_timeout_seconds": 10,
  "flush_delay_seconds": 0.01,
  "max_batch_bytes": 131072,
  "verify_tls": true,
  "http2_enabled": { "ctl": false, "data": false }
}
JSON

cat > "$TMP_DIR/helper.json" <<'JSON'
{
  "broker_base_url": "http://127.0.0.1:18105/api/v1/telemetry",
  "client_token": "test-client-token",
  "auth_mode": "bearer",
  "binary_media_type": "image/webp",
  "route_template": "/{lane}/{direction}",
  "health_template": "/health",
  "peer_id": "helper-test",
  "listen_host": "127.0.0.1",
  "http_listen_port": 0,
  "socks_listen_port": 0,
  "listen_state_path": "helper-listen-state.json",
  "http_timeout_seconds": 10,
  "flush_delay_seconds": 0.01,
  "max_batch_bytes": 65536,
  "verify_tls": true,
  "http2_enabled": { "ctl": false, "data": false }
}
JSON

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$ROOT/tests/certs/localhost-key.pem" \
  -out "$ROOT/tests/certs/localhost.pem" \
  -subj "/CN=localhost" \
  -days 1 >/dev/null 2>&1

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  sleep 0.5
  for pid in "${PIDS[@]:-}"; do
    kill -9 "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP_DIR" "$ROOT/tests/certs" >/dev/null 2>&1 || true
}
trap cleanup EXIT
PIDS=()

PORT=18105 TWOMAN_TRACE=1 TWOMAN_DEBUG_STATS=1 TWOMAN_CONFIG_PATH="$TMP_DIR/broker-config.json" node "$ROOT/host/node_selector/broker.js" \
  >"$TMP_DIR/broker.log" 2>&1 &
PIDS+=($!)

python3 "$ROOT/tests/origin_server.py" >"$TMP_DIR/origin.log" 2>&1 &
PIDS+=($!)

python3 "$ROOT/tests/tls_origin_server.py" >"$TMP_DIR/tls.log" 2>&1 &
PIDS+=($!)

"$TMP_DIR/twoman-helper-agent" --mode agent --config "$TMP_DIR/agent.json" >"$TMP_DIR/agent.log" 2>&1 &
PIDS+=($!)

(cd "$TMP_DIR" && "$TMP_DIR/twoman-helper-agent" --mode helper --config "$TMP_DIR/helper.json") >"$TMP_DIR/helper.log" 2>&1 &
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
  for file in broker.log agent.log helper.log origin.log tls.log; do
    [ -f "$TMP_DIR/$file" ] && echo "== $file ==" >&2 && cat "$TMP_DIR/$file" >&2 || true
  done
  return 1
}

wait_for_listen_state() {
  local path="$1"
  for _ in $(seq 1 50); do
    if python3 - "$path" <<'PY' >/dev/null 2>&1
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
assert int(payload["http_port"]) > 0
assert int(payload["socks_port"]) > 0
PY
    then
      return 0
    fi
    sleep 0.2
  done
  echo "Timed out waiting for helper listen state: $path" >&2
  for file in broker.log agent.log helper.log origin.log tls.log; do
    [ -f "$TMP_DIR/$file" ] && echo "== $file ==" >&2 && cat "$TMP_DIR/$file" >&2 || true
  done
  return 1
}

read_listen_port() {
  local path="$1"
  local key="$2"
  python3 - "$path" "$key" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(int(payload[sys.argv[2]]))
PY
}

wait_for_port 127.0.0.1 18105 broker
wait_for_port 127.0.0.1 19090 origin
wait_for_port 127.0.0.1 19443 tls-origin
wait_for_listen_state "$TMP_DIR/helper-listen-state.json"
HELPER_HTTP_PORT="$(read_listen_port "$TMP_DIR/helper-listen-state.json" http_port)"
HELPER_SOCKS_PORT="$(read_listen_port "$TMP_DIR/helper-listen-state.json" socks_port)"
wait_for_port 127.0.0.1 "$HELPER_HTTP_PORT" http-helper
wait_for_port 127.0.0.1 "$HELPER_SOCKS_PORT" socks-helper

curl --fail --silent --show-error \
  -H "Authorization: Bearer test-client-token" \
  "http://127.0.0.1:18105/api/v1/telemetry/health" \
  > "$TMP_DIR/health.json"

python3 - "$TMP_DIR/health.json" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
cap = payload["capabilities"]
assert cap["cipher_suites"] == ["aes-256-ctr-v2", "hmac-sha256-ctr-v1"], payload
assert cap["profiles"]["managed_host_http"]["helper"]["down_lanes"] == ["data"], payload
assert cap["profiles"]["managed_host_http"]["agent"]["down_lanes"] == ["data"], payload
assert cap["profiles"]["managed_host_http"]["agent"]["stream_control_lane"] == "pri", payload
PY

curl --fail --silent --show-error \
  --socks5-hostname "127.0.0.1:${HELPER_SOCKS_PORT}" \
  "http://127.0.0.1:19090/socks-test?via=go-socks" \
  > "$TMP_DIR/socks.json"

python3 - "$TMP_DIR/socks.json" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
assert payload["path"] == "/socks-test?via=go-socks", payload
assert payload["method"] == "GET", payload
PY

curl --fail --silent --show-error --insecure \
  --proxy "http://127.0.0.1:${HELPER_HTTP_PORT}" \
  "https://127.0.0.1:19443/secure-test?via=go-http" \
  > "$TMP_DIR/http.txt"

grep -q 'secure:/secure-test?via=go-http' "$TMP_DIR/http.txt"

echo "TWOMAN GO NODE HTTP E2E OK"

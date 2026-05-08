#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$ROOT/tests/tmp-client-cli"
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

(
  cd "$ROOT/client-cli"
  go build -trimpath -ldflags "-s -w" -o "$TMP_DIR/twoman" .
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
  "streaming_data_down_helper": false,
  "streaming_data_down_agent": false,
  "base_uri": "/api/v1/telemetry"
}
JSON

cat > "$TMP_DIR/agent.json" <<'JSON'
{
  "broker_base_url": "http://127.0.0.1:18115/api/v1/telemetry",
  "agent_token": "test-agent-token",
  "auth_mode": "bearer",
  "binary_media_type": "image/webp",
  "route_template": "/{lane}/{direction}",
  "health_template": "/health",
  "peer_id": "agent-cli-test",
  "http_timeout_seconds": 10,
  "flush_delay_seconds": 0.01,
  "max_batch_bytes": 131072,
  "verify_tls": true,
  "http2_enabled": { "ctl": false, "data": false }
}
JSON

PROFILE_TEXT="$(python3 - <<'PY'
import base64, json
payload = {
    "name": "CLI E2E",
    "brokerBaseUrl": "http://127.0.0.1:18115/api/v1/telemetry",
    "clientToken": "test-client-token",
    "targetAgentPeerLabel": "agent-cli-test",
    "verifyTls": True,
    "http2Ctl": False,
    "http2Data": False,
    "httpPort": 0,
    "socksPort": 0,
    "httpTimeoutSeconds": 10,
    "flushDelaySeconds": 0.01,
    "maxBatchBytes": 65536,
    "dataUploadMaxBatchBytes": 65536,
    "dataUploadFlushDelaySeconds": 0.004,
    "idleRepollCtlSeconds": 0.05,
    "idleRepollDataSeconds": 0.1,
    "traceEnabled": False,
}
encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
print("twoman://profile?data=" + encoded)
PY
)"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$ROOT/tests/certs/localhost-key.pem" \
  -out "$ROOT/tests/certs/localhost.pem" \
  -subj "/CN=localhost" \
  -days 1 >/dev/null 2>&1

cleanup() {
  "$TMP_DIR/twoman" --home "$STATE_DIR" stop >/dev/null 2>&1 || true
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
  rm -rf "$TMP_DIR" "$ROOT/tests/certs"
}
trap cleanup EXIT
PIDS=()

PORT=18115 TWOMAN_TRACE=1 TWOMAN_DEBUG_STATS=1 TWOMAN_CONFIG_PATH="$TMP_DIR/broker-config.json" node "$ROOT/host/node_selector/broker.js" \
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
  for file in broker.log agent.log origin.log tls.log; do
    [ -f "$TMP_DIR/$file" ] && echo "== $file ==" >&2 && cat "$TMP_DIR/$file" >&2 || true
  done
  return 1
}

retry_curl() {
  local output="$1"
  shift
  local curl_error="$TMP_DIR/curl.err"
  for _ in $(seq 1 30); do
    if curl --fail --silent --show-error "$@" >"$output" 2>"$curl_error"; then
      return 0
    fi
    sleep 0.2
  done
  cat "$curl_error" >&2 || true
  for file in broker.log agent.log; do
    [ -f "$TMP_DIR/$file" ] && echo "== $file ==" >&2 && tail -200 "$TMP_DIR/$file" >&2 || true
  done
  [ -f "$STATE_DIR/logs/helper.log" ] && echo "== helper.log ==" >&2 && tail -200 "$STATE_DIR/logs/helper.log" >&2 || true
  return 1
}

wait_for_port 127.0.0.1 18115 broker
wait_for_port 127.0.0.1 19090 origin
wait_for_port 127.0.0.1 19443 tls-origin

for _ in $(seq 1 50); do
  if python3 - <<'PY' >/dev/null 2>&1
import json
import urllib.request

request = urllib.request.Request(
    "http://127.0.0.1:18115/api/v1/telemetry/health",
    headers={"Authorization": "Bearer test-client-token"},
)
with urllib.request.urlopen(request, timeout=1) as response:
    payload = json.loads(response.read())
assert payload.get("agent_peer_label") == "agent-cli-test", payload
PY
  then
    break
  fi
  sleep 0.2
done
python3 - <<'PY'
import json
import urllib.request

request = urllib.request.Request(
    "http://127.0.0.1:18115/api/v1/telemetry/health",
    headers={"Authorization": "Bearer test-client-token"},
)
with urllib.request.urlopen(request, timeout=2) as response:
    payload = json.loads(response.read())
assert payload.get("agent_peer_label") == "agent-cli-test", payload
PY

"$TMP_DIR/twoman" --home "$STATE_DIR" import "$PROFILE_TEXT" > "$TMP_DIR/import.out"
grep -q "Imported profile: CLI E2E" "$TMP_DIR/import.out"

"$TMP_DIR/twoman" --home "$STATE_DIR" connect --http-port 0 --socks-port 0 > "$TMP_DIR/connect.out"
grep -q "Twoman connected" "$TMP_DIR/connect.out"

"$TMP_DIR/twoman" --home "$STATE_DIR" status --json > "$TMP_DIR/status.json"

HELPER_HTTP_PORT="$(python3 - "$TMP_DIR/status.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["running"] is True, payload
print(int(payload["httpPort"]))
PY
)"
HELPER_SOCKS_PORT="$(python3 - "$TMP_DIR/status.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["running"] is True, payload
print(int(payload["socksPort"]))
PY
)"

wait_for_port 127.0.0.1 "$HELPER_HTTP_PORT" cli-http
wait_for_port 127.0.0.1 "$HELPER_SOCKS_PORT" cli-socks

retry_curl "$TMP_DIR/socks.json" \
  --socks5-hostname "127.0.0.1:${HELPER_SOCKS_PORT}" \
  "http://127.0.0.1:19090/socks-test?via=client-cli"

python3 - "$TMP_DIR/socks.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["path"] == "/socks-test?via=client-cli", payload
assert payload["method"] == "GET", payload
PY

retry_curl "$TMP_DIR/http.txt" --insecure \
  --proxy "http://127.0.0.1:${HELPER_HTTP_PORT}" \
  "https://127.0.0.1:19443/secure-test?via=client-cli"

grep -q 'secure:/secure-test?via=client-cli' "$TMP_DIR/http.txt"

"$TMP_DIR/twoman" --home "$STATE_DIR" logs -n 20 > "$TMP_DIR/logs.out"
"$TMP_DIR/twoman" --home "$STATE_DIR" logs export --output "$TMP_DIR/diagnostics" -n 20 > "$TMP_DIR/logs-export.out"
grep -q "Diagnostics exported:" "$TMP_DIR/logs-export.out"
DIAG_DIR="$(find "$TMP_DIR/diagnostics" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
test -n "$DIAG_DIR"
test -f "$DIAG_DIR/helper.log"
test -f "$DIAG_DIR/profiles.redacted.json"
! grep -R 'test-client-token' "$DIAG_DIR"
"$TMP_DIR/twoman" --home "$STATE_DIR" config > "$TMP_DIR/config.out"
grep -q '<redacted>' "$TMP_DIR/config.out"
! grep -q 'test-client-token' "$TMP_DIR/config.out"

"$TMP_DIR/twoman" --home "$STATE_DIR" disconnect > "$TMP_DIR/stop.out"
grep -q "Twoman stopped." "$TMP_DIR/stop.out"
if "$TMP_DIR/twoman" --home "$STATE_DIR" status > "$TMP_DIR/status-after-stop.out" 2>&1; then
  echo "status should fail after stop" >&2
  cat "$TMP_DIR/status-after-stop.out" >&2
  exit 1
fi
grep -q "Twoman disconnected" "$TMP_DIR/status-after-stop.out"

"$TMP_DIR/twoman" --home "$STATE_DIR" profiles delete "CLI E2E" > "$TMP_DIR/profile-delete.out"
grep -q "Deleted profile: CLI E2E" "$TMP_DIR/profile-delete.out"
"$TMP_DIR/twoman" --home "$STATE_DIR" profiles > "$TMP_DIR/profiles-after-delete.out"
grep -q "No profiles imported." "$TMP_DIR/profiles-after-delete.out"

echo "TWOMAN CLIENT CLI E2E OK"

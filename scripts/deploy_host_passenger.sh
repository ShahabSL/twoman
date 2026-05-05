#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 1
  fi
}

api_get() {
  local endpoint="$1"
  shift
  curl "${CPANEL_CURL_ARGS[@]}" "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    --get \
    "$@" \
    "${TWOMAN_CPANEL_BASE_URL}/execute/${endpoint}"
}

api_post() {
  local endpoint="$1"
  shift
  curl "${CPANEL_CURL_ARGS[@]}" "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    "$@" \
    "${TWOMAN_CPANEL_BASE_URL}/execute/${endpoint}"
}

upload_file() {
  local source_path="$1"
  local remote_dir="$2"
  local remote_name="$3"
  curl "${CPANEL_CURL_ARGS[@]}" "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    -F "dir=${remote_dir}" \
    -F "overwrite=1" \
    -F "file-1=@${source_path};filename=${remote_name}" \
    "${TWOMAN_CPANEL_BASE_URL}/execute/Fileman/upload_files" >/dev/null
}

upload_content() {
  local remote_dir="$1"
  local remote_name="$2"
  local content="$3"
  curl "${CPANEL_CURL_ARGS[@]}" "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    --data-urlencode "dir=${remote_dir}" \
    --data-urlencode "file=${remote_name}" \
    --data-urlencode "content=${content}" \
    --data-urlencode "from_charset=UTF-8" \
    --data-urlencode "to_charset=UTF-8" \
    --data-urlencode "fallback=1" \
    "${TWOMAN_CPANEL_BASE_URL}/execute/Fileman/save_file_content" >/dev/null
}

upload_generated_file() {
  local remote_dir="$1"
  local remote_name="$2"
  local content="$3"
  local temp_path
  temp_path="$(mktemp)"
  printf '%s' "${content}" > "${temp_path}"
  upload_file "${temp_path}" "${remote_dir}" "${remote_name}"
  rm -f "${temp_path}"
}

mkdir_api() {
  local parent_path="$1"
  local dir_name="$2"
  curl "${CPANEL_CURL_ARGS[@]}" "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    --get \
    --data-urlencode "cpanel_jsonapi_user=${TWOMAN_CPANEL_USERNAME}" \
    --data-urlencode "cpanel_jsonapi_apiversion=2" \
    --data-urlencode "cpanel_jsonapi_module=Fileman" \
    --data-urlencode "cpanel_jsonapi_func=mkdir" \
    --data-urlencode "path=${parent_path}" \
    --data-urlencode "name=${dir_name}" \
    "${TWOMAN_CPANEL_BASE_URL}/json-api/cpanel" >/dev/null || true
}

ensure_remote_dir() {
  local relative_path="$1"
  local current=""
  local part
  IFS='/' read -r -a parts <<< "${relative_path}"
  for part in "${parts[@]}"; do
    [ -n "${part}" ] || continue
    if [ -z "${current}" ]; then
      current="${part}"
      continue
    fi
    mkdir_api "${current}" "${part}"
    current="${current}/${part}"
  done
}

require_env TWOMAN_CPANEL_BASE_URL
require_env TWOMAN_CPANEL_USERNAME
require_env TWOMAN_CPANEL_PASSWORD
require_env TWOMAN_CPANEL_HOME
require_env TWOMAN_PUBLIC_ORIGIN
require_env TWOMAN_CLIENT_TOKEN
require_env TWOMAN_AGENT_TOKEN
TWOMAN_CPANEL_PROXY_URL="${TWOMAN_CPANEL_PROXY_URL:-${TWOMAN_UPSTREAM_PROXY_URL:-}}"
TWOMAN_PUBLIC_PROXY_URL="${TWOMAN_PUBLIC_PROXY_URL:-${TWOMAN_UPSTREAM_PROXY_URL:-}}"
TWOMAN_CPANEL_CONNECT_TIMEOUT_SECONDS="${TWOMAN_CPANEL_CONNECT_TIMEOUT_SECONDS:-10}"
TWOMAN_CPANEL_MAX_TIME_SECONDS="${TWOMAN_CPANEL_MAX_TIME_SECONDS:-60}"

CPANEL_PROXY_ARGS=()
if [ -n "${TWOMAN_CPANEL_PROXY_URL}" ]; then
  CPANEL_PROXY_ARGS+=(--proxy "${TWOMAN_CPANEL_PROXY_URL}")
fi
PUBLIC_PROXY_ARGS=()
if [ -n "${TWOMAN_PUBLIC_PROXY_URL}" ]; then
  PUBLIC_PROXY_ARGS+=(--proxy "${TWOMAN_PUBLIC_PROXY_URL}")
fi
CPANEL_CURL_ARGS=(
  -sk
  --connect-timeout "${TWOMAN_CPANEL_CONNECT_TIMEOUT_SECONDS}"
  --max-time "${TWOMAN_CPANEL_MAX_TIME_SECONDS}"
)

TWOMAN_CAMOUFLAGE_SITE_ENABLED="${TWOMAN_CAMOUFLAGE_SITE_ENABLED:-true}"
TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID="${TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID:-}"
TWOMAN_CAMOUFLAGE_SITE_NAME="${TWOMAN_CAMOUFLAGE_SITE_NAME:-}"
TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX="${TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX:-true}"
TWOMAN_PUBLIC_BASE_PATH="${TWOMAN_PUBLIC_BASE_PATH:-/rahkar}"
TWOMAN_APP_NAME="${TWOMAN_APP_NAME:-rahkar}"
TWOMAN_APP_ROOT="${TWOMAN_APP_ROOT:-${TWOMAN_CPANEL_HOME}/rahkar}"
TWOMAN_DOWN_WAIT_CTL_MS="${TWOMAN_DOWN_WAIT_CTL_MS:-250}"
TWOMAN_DOWN_WAIT_DATA_MS="${TWOMAN_DOWN_WAIT_DATA_MS:-250}"
TWOMAN_AGENT_DOWN_WAIT_CTL_MS="${TWOMAN_AGENT_DOWN_WAIT_CTL_MS:-10000}"
TWOMAN_AGENT_DOWN_WAIT_DATA_MS="${TWOMAN_AGENT_DOWN_WAIT_DATA_MS:-10000}"
TWOMAN_HELPER_DOWN_COMBINED_DATA_LANE="${TWOMAN_HELPER_DOWN_COMBINED_DATA_LANE:-true}"
TWOMAN_AGENT_DOWN_COMBINED_DATA_LANE="${TWOMAN_AGENT_DOWN_COMBINED_DATA_LANE:-true}"
TWOMAN_STREAMING_CTL_DOWN_AGENT="${TWOMAN_STREAMING_CTL_DOWN_AGENT:-false}"
TWOMAN_STREAMING_DATA_DOWN_AGENT="${TWOMAN_STREAMING_DATA_DOWN_AGENT:-false}"
TWOMAN_STREAMING_DATA_DOWN_HELPER="${TWOMAN_STREAMING_DATA_DOWN_HELPER:-false}"
if [ -z "${TWOMAN_ROUTE_TEMPLATE:-}" ]; then
  TWOMAN_ROUTE_TEMPLATE='/{lane}/{direction}'
fi
TWOMAN_HEALTH_TEMPLATE="${TWOMAN_HEALTH_TEMPLATE:-/health}"

CAMOUFLAGE_MANIFEST_PATH=""
cleanup() {
  if [ -n "${CAMOUFLAGE_MANIFEST_PATH:-}" ] && [ -f "${CAMOUFLAGE_MANIFEST_PATH}" ]; then
    rm -f "${CAMOUFLAGE_MANIFEST_PATH}"
  fi
}
trap cleanup EXIT

json_get() {
  local json_path="$1"
  local field_name="$2"
  python3 - <<'PY' "${json_path}" "${field_name}"
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(payload[sys.argv[2]])
PY
}

if [ "${TWOMAN_CAMOUFLAGE_SITE_ENABLED}" = "true" ]; then
  if [ -z "${TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID}" ]; then
    TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(6))
PY
)"
  fi
  CAMOUFLAGE_MANIFEST_PATH="$(mktemp)"
  if [ -n "${TWOMAN_CAMOUFLAGE_SITE_NAME}" ]; then
    python3 scripts/generate_camouflage_site.py \
      --deployment-id "${TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID}" \
      --site-name "${TWOMAN_CAMOUFLAGE_SITE_NAME}" > "${CAMOUFLAGE_MANIFEST_PATH}"
  else
    python3 scripts/generate_camouflage_site.py \
      --deployment-id "${TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID}" > "${CAMOUFLAGE_MANIFEST_PATH}"
  fi
  if [ -z "${TWOMAN_PUBLIC_BASE_PATH:-}" ] || [ "${TWOMAN_PUBLIC_BASE_PATH}" = "/rahkar" ]; then
    TWOMAN_PUBLIC_BASE_PATH="$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "passenger_base_path")"
  fi
fi

APP_RELATIVE="${TWOMAN_APP_ROOT#${TWOMAN_CPANEL_HOME}/}"
REMOTE_TMP_DIR="${TWOMAN_APP_ROOT}/tmp"
REMOTE_LOG_DIR="${TWOMAN_APP_ROOT}/logs"

CONFIG_JSON="$(cat <<EOF
{
  "backend_family": "passenger_python",
  "client_tokens": ["${TWOMAN_CLIENT_TOKEN}"],
  "agent_tokens": ["${TWOMAN_AGENT_TOKEN}"],
  "base_uri": "${TWOMAN_PUBLIC_BASE_PATH}",
  "binary_media_type": "image/webp",
  "route_template": "${TWOMAN_ROUTE_TEMPLATE}",
  "health_template": "${TWOMAN_HEALTH_TEMPLATE}",
  "down_wait_ms": {
    "ctl": ${TWOMAN_DOWN_WAIT_CTL_MS},
    "data": ${TWOMAN_DOWN_WAIT_DATA_MS}
  },
  "down_wait_ms_by_role": {
    "agent": {
      "ctl": ${TWOMAN_AGENT_DOWN_WAIT_CTL_MS},
      "data": ${TWOMAN_AGENT_DOWN_WAIT_DATA_MS}
    }
  },
  "streaming_ctl_down_helper": false,
  "streaming_data_down_helper": ${TWOMAN_STREAMING_DATA_DOWN_HELPER},
  "helper_down_combined_data_lane": ${TWOMAN_HELPER_DOWN_COMBINED_DATA_LANE},
  "streaming_ctl_down_agent": ${TWOMAN_STREAMING_CTL_DOWN_AGENT},
  "streaming_data_down_agent": ${TWOMAN_STREAMING_DATA_DOWN_AGENT},
  "agent_down_combined_data_lane": ${TWOMAN_AGENT_DOWN_COMBINED_DATA_LANE},
  "lane_profiles": {
    "ctl": { "max_bytes": 4096, "max_frames": 8, "hold_ms": 1, "pad_min": 1024 },
    "pri": { "max_bytes": 32768, "max_frames": 16, "hold_ms": 2, "pad_min": 1024 },
    "bulk": { "max_bytes": 262144, "max_frames": 64, "hold_ms": 4, "pad_min": 0 }
  },
  "peer_ttl_seconds": 90,
  "stream_ttl_seconds": 300,
  "max_lane_bytes": 16777216,
  "max_streams_per_peer_session": 256,
  "max_open_rate_per_peer_session": 120,
  "open_rate_window_seconds": 10,
  "max_peer_buffered_bytes": 33554432
}
EOF
)"

ensure_remote_dir "${APP_RELATIVE}"
ensure_remote_dir "${APP_RELATIVE}/tmp"
ensure_remote_dir "${APP_RELATIVE}/logs"
ensure_remote_dir "${APP_RELATIVE}/runtime"

echo "Uploading Passenger host app files..."
if [ -n "${CAMOUFLAGE_MANIFEST_PATH}" ]; then
  CAMOUFLAGE_SITE_SLUG="$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "site_slug")"
  CAMOUFLAGE_INDEX="$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "landing_html")"
  CAMOUFLAGE_ABOUT="$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "about_html")"
  CAMOUFLAGE_CONTACT="$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "contact_html")"
  CAMOUFLAGE_404="$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "404_html")"
  CAMOUFLAGE_ROBOTS="$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "robots_txt")"
  CAMOUFLAGE_SITEMAP="$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "sitemap_xml")"
  CAMOUFLAGE_SLUG_HTACCESS="$(cat <<EOF
DirectoryIndex index.html
ErrorDocument 404 /${CAMOUFLAGE_SITE_SLUG}/404.html
EOF
)"
  CAMOUFLAGE_ROOT_HTACCESS="$(cat <<'EOF'
DirectoryIndex index.html
ErrorDocument 404 /404.html
EOF
)"
  
  ensure_remote_dir "public_html/${CAMOUFLAGE_SITE_SLUG}"
  upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" "index.html" "${CAMOUFLAGE_INDEX}"
  upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" "about.html" "${CAMOUFLAGE_ABOUT}"
  upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" "contact.html" "${CAMOUFLAGE_CONTACT}"
  upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" "404.html" "${CAMOUFLAGE_404}"
  upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" ".htaccess" "${CAMOUFLAGE_SLUG_HTACCESS}"
  
  if [ "${TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX}" = "true" ]; then
    upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html" "index.html" "${CAMOUFLAGE_INDEX}"
    upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html" "about.html" "${CAMOUFLAGE_ABOUT}"
    upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html" "contact.html" "${CAMOUFLAGE_CONTACT}"
    upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html" "404.html" "${CAMOUFLAGE_404}"
    upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html" "robots.txt" "${CAMOUFLAGE_ROBOTS}"
    upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html" "sitemap.xml" "${CAMOUFLAGE_SITEMAP}"
    upload_generated_file "${TWOMAN_CPANEL_HOME}/public_html" ".htaccess" "${CAMOUFLAGE_ROOT_HTACCESS}"
  fi
  
  # Crucial for proxy camouflage: upload the themed 404 to the passenger runtime root
  upload_generated_file "${TWOMAN_APP_ROOT}/runtime" "camouflage_404.html" "${CAMOUFLAGE_404}"
fi

upload_file "runtime_diagnostics.py" "${TWOMAN_APP_ROOT}" "runtime_diagnostics.py"
upload_file "twoman_http.py" "${TWOMAN_APP_ROOT}" "twoman_http.py"
upload_file "twoman_protocol.py" "${TWOMAN_APP_ROOT}" "twoman_protocol.py"
upload_file "twoman_crypto.py" "${TWOMAN_APP_ROOT}" "twoman_crypto.py"
upload_file "host/runtime/http_broker_daemon.py" "${TWOMAN_APP_ROOT}" "http_broker_daemon.py"
upload_generated_file "${TWOMAN_APP_ROOT}" "broker_app.py" "$(cat host/passenger_python/broker_app.py)"
upload_generated_file "${TWOMAN_APP_ROOT}" "passenger_proxy.py" "$(cat host/passenger_python/passenger_proxy.py)"
upload_generated_file "${TWOMAN_APP_ROOT}" "passenger_wsgi.py" "$(cat host/passenger_python/passenger_wsgi.py)"
upload_generated_file "${TWOMAN_APP_ROOT}" "config.json" "${CONFIG_JSON}"
# Force Passenger to respawn the detached broker daemon on the next request so
# updated broker code actually takes effect.
upload_generated_file "${TWOMAN_APP_ROOT}/runtime" "broker.pid" "0"

HOST_DOMAIN="${TWOMAN_PUBLIC_ORIGIN#https://}"
HOST_DOMAIN="${HOST_DOMAIN#http://}"
HOST_DOMAIN="${HOST_DOMAIN%%/*}"

echo "Refreshing Passenger app registration..."
api_get "PassengerApps/unregister_application" \
  --data-urlencode "name=${TWOMAN_APP_NAME}" \
  --data-urlencode "path=${TWOMAN_APP_ROOT}" \
  --data-urlencode "domain=${HOST_DOMAIN}" \
  --data-urlencode "base_uri=${TWOMAN_PUBLIC_BASE_PATH}" >/dev/null || true

register_result="$(api_get "PassengerApps/register_application" \
  --data-urlencode "name=${TWOMAN_APP_NAME}" \
  --data-urlencode "path=${TWOMAN_APP_ROOT}" \
  --data-urlencode "domain=${HOST_DOMAIN}" \
  --data-urlencode "deployment_mode=production" \
  --data-urlencode "base_uri=${TWOMAN_PUBLIC_BASE_PATH}" \
  --data-urlencode "app_type=python" \
  --data-urlencode "startupfile=passenger_wsgi.py")"
echo "Passenger register response: ${register_result}"

echo "Checking Passenger broker health..."
sleep 3
health_url="${TWOMAN_PUBLIC_ORIGIN}${TWOMAN_PUBLIC_BASE_PATH}${TWOMAN_HEALTH_TEMPLATE}"
health_result=""
health_code=""
health_ok="false"
health_body_path="$(mktemp)"
trap 'rm -f "${health_body_path}"; cleanup' EXIT
for _ in $(seq 1 45); do
  health_code="$(curl -sk "${PUBLIC_PROXY_ARGS[@]}" \
    --connect-timeout 10 \
    --max-time 20 \
    -H "Authorization: Bearer ${TWOMAN_CLIENT_TOKEN}" \
    -o "${health_body_path}" \
    -w "%{http_code}" \
    "${health_url}" || true)"
  health_result="$(cat "${health_body_path}" 2>/dev/null || true)"
  if [ "${health_code}" = "200" ] && python3 - <<'PY' "${health_body_path}" >/dev/null 2>&1
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
assert payload.get("ok")
PY
  then
    health_ok="true"
    break
  fi
  sleep 2
done
if [ "${health_ok}" != "true" ]; then
  echo "Passenger health probe did not become ready." >&2
  echo "  URL: ${health_url}" >&2
  echo "  last HTTP code: ${health_code:-unknown}" >&2
  echo "  last body preview:" >&2
  printf "%s\n" "${health_result}" | sed -n '1,20p' >&2
  exit 1
fi
python3 - <<'PY' "${health_body_path}"
import json,sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    data=json.load(handle)
if not data.get("ok"):
    raise SystemExit("Passenger health failed: %s" % (data,))
stats = data.get("stats") if isinstance(data.get("stats"), dict) else data
print(json.dumps({
    "ok": data.get("ok"),
    "peers": stats.get("peers"),
    "streams": stats.get("streams"),
    "agent_peer_label": stats.get("agent_peer_label"),
    "log_paths": stats.get("log_paths"),
}))
PY
if [ -n "${CAMOUFLAGE_MANIFEST_PATH}" ]; then
  if [ "${TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX}" = "true" ]; then
    echo "Camouflage root page: ${TWOMAN_PUBLIC_ORIGIN}/"
  fi
  echo "Camouflage site: ${TWOMAN_PUBLIC_ORIGIN}/$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "site_slug")/"
fi
echo "Passenger base path: ${TWOMAN_PUBLIC_ORIGIN}${TWOMAN_PUBLIC_BASE_PATH}"
echo
echo "Passenger host deployment complete."

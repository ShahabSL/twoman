#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 1
  fi
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

TWOMAN_PUBLIC_BASE_PATH="${TWOMAN_PUBLIC_BASE_PATH:-/rahkar}"
TWOMAN_BRIDGE_LOCAL_PORT="${TWOMAN_BRIDGE_LOCAL_PORT:-18093}"
TWOMAN_DOWN_WAIT_CTL_MS="${TWOMAN_DOWN_WAIT_CTL_MS:-250}"
TWOMAN_DOWN_WAIT_DATA_MS="${TWOMAN_DOWN_WAIT_DATA_MS:-250}"
TWOMAN_AGENT_DOWN_WAIT_CTL_MS="${TWOMAN_AGENT_DOWN_WAIT_CTL_MS:-250}"
TWOMAN_AGENT_DOWN_WAIT_DATA_MS="${TWOMAN_AGENT_DOWN_WAIT_DATA_MS:-250}"
TWOMAN_HELPER_DOWN_COMBINED_DATA_LANE="${TWOMAN_HELPER_DOWN_COMBINED_DATA_LANE:-true}"
TWOMAN_AGENT_DOWN_COMBINED_DATA_LANE="${TWOMAN_AGENT_DOWN_COMBINED_DATA_LANE:-true}"
TWOMAN_STREAMING_CTL_DOWN_HELPER="${TWOMAN_STREAMING_CTL_DOWN_HELPER:-false}"
TWOMAN_STREAMING_DATA_DOWN_HELPER="${TWOMAN_STREAMING_DATA_DOWN_HELPER:-false}"
TWOMAN_STREAMING_CTL_DOWN_AGENT="${TWOMAN_STREAMING_CTL_DOWN_AGENT:-false}"
TWOMAN_STREAMING_DATA_DOWN_AGENT="${TWOMAN_STREAMING_DATA_DOWN_AGENT:-false}"
TWOMAN_BRIDGE_SESSION_TTL_SECONDS="${TWOMAN_BRIDGE_SESSION_TTL_SECONDS:-300}"
TWOMAN_BRIDGE_MAX_AGENT_IDLE_SECONDS="${TWOMAN_BRIDGE_MAX_AGENT_IDLE_SECONDS:-90}"
TWOMAN_BRIDGE_MAX_STREAMS_PER_PEER_SESSION="${TWOMAN_BRIDGE_MAX_STREAMS_PER_PEER_SESSION:-256}"
TWOMAN_BRIDGE_MAX_OPEN_RATE_PER_PEER_SESSION="${TWOMAN_BRIDGE_MAX_OPEN_RATE_PER_PEER_SESSION:-120}"
TWOMAN_BRIDGE_OPEN_RATE_WINDOW_SECONDS="${TWOMAN_BRIDGE_OPEN_RATE_WINDOW_SECONDS:-10}"
TWOMAN_BRIDGE_MAX_PEER_BUFFERED_BYTES="${TWOMAN_BRIDGE_MAX_PEER_BUFFERED_BYTES:-33554432}"
TWOMAN_CAMOUFLAGE_SITE_ENABLED="${TWOMAN_CAMOUFLAGE_SITE_ENABLED:-true}"
TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID="${TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID:-}"
TWOMAN_CAMOUFLAGE_SITE_NAME="${TWOMAN_CAMOUFLAGE_SITE_NAME:-}"
TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX="${TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX:-true}"
TWOMAN_BRIDGE_USE_UNIX_SOCKET="${TWOMAN_BRIDGE_USE_UNIX_SOCKET:-true}"
TWOMAN_BRIDGE_PUBLIC_BASE_PATH="${TWOMAN_BRIDGE_PUBLIC_BASE_PATH:-}"
if [ -z "${TWOMAN_BRIDGE_ROUTE_TEMPLATE:-}" ]; then
  TWOMAN_BRIDGE_ROUTE_TEMPLATE='/{lane}/{direction}'
fi
TWOMAN_BRIDGE_HEALTH_TEMPLATE="${TWOMAN_BRIDGE_HEALTH_TEMPLATE:-/health}"
TWOMAN_BRIDGE_BINARY_MEDIA_TYPE="${TWOMAN_BRIDGE_BINARY_MEDIA_TYPE:-image/webp}"

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

PUBLIC_BASE_TRIMMED="${TWOMAN_PUBLIC_BASE_PATH#/}"
REMOTE_BASE="${TWOMAN_CPANEL_HOME}/public_html/${PUBLIC_BASE_TRIMMED}"
REMOTE_APP_DIR="${REMOTE_BASE}/app"
REMOTE_RUNTIME_DIR="${REMOTE_BASE}/runtime"
REMOTE_STORAGE_DIR="${REMOTE_BASE}/storage"
REMOTE_OFFLOAD_DIR="${REMOTE_BASE}/offload"
RELATIVE_BASE="public_html/${PUBLIC_BASE_TRIMMED}"
TWOMAN_BRIDGE_LOCAL_SOCKET_PATH="${TWOMAN_BRIDGE_LOCAL_SOCKET_PATH:-${REMOTE_RUNTIME_DIR}/bridge.sock}"

mkdir -p /tmp/twoman_deploy >/dev/null 2>&1 || true

HOST_CONFIG_CONTENT="<?php

return [
    'backend_family' => 'bridge_runtime',
    'storage_path' => '${REMOTE_STORAGE_DIR}',
    'public_base_path' => '${TWOMAN_PUBLIC_BASE_PATH}',
    'offload_relative_path' => 'offload',
    'offload_ttl_seconds' => 3600,
    'client_tokens' => [
        '${TWOMAN_CLIENT_TOKEN}',
    ],
    'agent_tokens' => [
        '${TWOMAN_AGENT_TOKEN}',
    ],
    'reverse_keys' => [
        'unused-public-release-placeholder',
    ],
    'max_request_body_bytes' => 8 * 1024 * 1024,
    'poll_wait_ms' => 20000,
    'reverse_wait_ms' => 45000,
    'poll_sleep_us' => 200000,
    'job_lease_seconds' => 30,
    'down_wait_ms' => [
        'ctl' => ${TWOMAN_DOWN_WAIT_CTL_MS},
        'data' => ${TWOMAN_DOWN_WAIT_DATA_MS},
    ],
    'down_wait_ms_by_role' => [
        'agent' => [
            'ctl' => ${TWOMAN_AGENT_DOWN_WAIT_CTL_MS},
            'data' => ${TWOMAN_AGENT_DOWN_WAIT_DATA_MS},
        ],
    ],
    'streaming_ctl_down_helper' => ${TWOMAN_STREAMING_CTL_DOWN_HELPER},
    'streaming_data_down_helper' => ${TWOMAN_STREAMING_DATA_DOWN_HELPER},
    'helper_down_combined_data_lane' => ${TWOMAN_HELPER_DOWN_COMBINED_DATA_LANE},
    'streaming_ctl_down_agent' => ${TWOMAN_STREAMING_CTL_DOWN_AGENT},
    'streaming_data_down_agent' => ${TWOMAN_STREAMING_DATA_DOWN_AGENT},
    'agent_down_combined_data_lane' => ${TWOMAN_AGENT_DOWN_COMBINED_DATA_LANE},
    'bridge_local_port' => ${TWOMAN_BRIDGE_LOCAL_PORT},
    'bridge_use_unix_socket' => ${TWOMAN_BRIDGE_USE_UNIX_SOCKET},
    'bridge_local_socket_path' => '${TWOMAN_BRIDGE_LOCAL_SOCKET_PATH}',
    'bridge_public_base_path' => '${TWOMAN_BRIDGE_PUBLIC_BASE_PATH}',
    'bridge_route_template' => '${TWOMAN_BRIDGE_ROUTE_TEMPLATE}',
    'bridge_health_template' => '${TWOMAN_BRIDGE_HEALTH_TEMPLATE}',
    'bridge_binary_media_type' => '${TWOMAN_BRIDGE_BINARY_MEDIA_TYPE}',
    'bridge_session_ttl_seconds' => ${TWOMAN_BRIDGE_SESSION_TTL_SECONDS},
    'bridge_max_agent_idle_seconds' => ${TWOMAN_BRIDGE_MAX_AGENT_IDLE_SECONDS},
    'bridge_max_streams_per_peer_session' => ${TWOMAN_BRIDGE_MAX_STREAMS_PER_PEER_SESSION},
    'bridge_max_open_rate_per_peer_session' => ${TWOMAN_BRIDGE_MAX_OPEN_RATE_PER_PEER_SESSION},
    'bridge_open_rate_window_seconds' => ${TWOMAN_BRIDGE_OPEN_RATE_WINDOW_SECONDS},
    'bridge_max_peer_buffered_bytes' => ${TWOMAN_BRIDGE_MAX_PEER_BUFFERED_BYTES},
    'lane_profiles' => [
        'ctl' => ['max_bytes' => 4096, 'max_frames' => 8, 'hold_ms' => 1, 'pad_min' => 1024],
        'pri' => ['max_bytes' => 32768, 'max_frames' => 16, 'hold_ms' => 2, 'pad_min' => 1024],
        'bulk' => ['max_bytes' => 262144, 'max_frames' => 64, 'hold_ms' => 4, 'pad_min' => 0],
    ],
];
"

OPS_RESTART_CONTENT="<?php
require_once __DIR__ . '/app/bridge_runtime.php';
\$pid = bridge_runtime_read_pid(bridge_runtime_daemon_pid_path());
if (\$pid > 1) { bridge_runtime_stop_pid(\$pid); }
bridge_runtime_kill_matching_processes();
bridge_runtime_start();
usleep(1500000);
echo bridge_runtime_ping() ? 'ok' : 'fail';
"

OPS_STUB_CONTENT="<?php http_response_code(404); exit;"

echo "Uploading host files..."
ensure_remote_dir "${RELATIVE_BASE}"
ensure_remote_dir "${RELATIVE_BASE}/app"
ensure_remote_dir "${RELATIVE_BASE}/runtime"
ensure_remote_dir "${RELATIVE_BASE}/storage"
ensure_remote_dir "${RELATIVE_BASE}/offload"
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
  upload_generated_file "${REMOTE_RUNTIME_DIR}" "camouflage_404.html" "${CAMOUFLAGE_404}"
fi
upload_file "runtime_diagnostics.py" "${REMOTE_BASE}" "runtime_diagnostics.py"
upload_file "twoman_http.py" "${REMOTE_BASE}" "twoman_http.py"
upload_file "twoman_protocol.py" "${REMOTE_BASE}" "twoman_protocol.py"
upload_file "twoman_crypto.py" "${REMOTE_BASE}" "twoman_crypto.py"
upload_generated_file "${REMOTE_APP_DIR}" "bootstrap.php" "$(cat host/app/bootstrap.php)"
upload_generated_file "${REMOTE_APP_DIR}" "bridge_runtime.php" "$(cat host/app/bridge_runtime.php)"
upload_file "host/runtime/http_broker_daemon.py" "${REMOTE_RUNTIME_DIR}" "http_broker_daemon.py"
upload_generated_file "${REMOTE_BASE}" "index.php" "$(cat host/public/index.php)"
upload_generated_file "${REMOTE_BASE}" ".htaccess" "$(cat host/public/.htaccess)"
upload_generated_file "${REMOTE_BASE}" "api.php" "$(cat host/public/api.php)"
upload_generated_file "${REMOTE_BASE}" "health.php" "$(cat host/public/health.php)"
upload_generated_file "${REMOTE_APP_DIR}" "config.php" "${HOST_CONFIG_CONTENT}"

echo "Restarting broker..."
upload_generated_file "${REMOTE_BASE}" "ops.php" "${OPS_RESTART_CONTENT}"
restart_result="$(curl -sk "${PUBLIC_PROXY_ARGS[@]}" --connect-timeout 10 --max-time 20 "${TWOMAN_PUBLIC_ORIGIN}/${PUBLIC_BASE_TRIMMED}/ops.php" || true)"
upload_generated_file "${REMOTE_BASE}" "ops.php" "${OPS_STUB_CONTENT}"
if [ "${restart_result}" != "ok" ]; then
  echo "bridge restart endpoint did not return ok; continuing to direct health checks" >&2
fi

echo "Checking health..."
curl -sk "${PUBLIC_PROXY_ARGS[@]}" --connect-timeout 10 --max-time 20 -H "Authorization: Bearer ${TWOMAN_CLIENT_TOKEN}" \
  "${TWOMAN_PUBLIC_ORIGIN}/${PUBLIC_BASE_TRIMMED}/api.php?action=health"
echo
BROKER_BASE_URL="${TWOMAN_PUBLIC_ORIGIN%/}/${PUBLIC_BASE_TRIMMED}"
if [ -n "${TWOMAN_BRIDGE_PUBLIC_BASE_PATH}" ] && [ "${TWOMAN_BRIDGE_PUBLIC_BASE_PATH}" != "/" ]; then
  BROKER_BASE_URL="${BROKER_BASE_URL%/}/$(printf '%s' "${TWOMAN_BRIDGE_PUBLIC_BASE_PATH}" | sed 's#^/##')"
fi
echo "Checking broker health..."
curl -sk "${PUBLIC_PROXY_ARGS[@]}" --connect-timeout 10 --max-time 20 -H "Authorization: Bearer ${TWOMAN_CLIENT_TOKEN}" \
  "${BROKER_BASE_URL%/}${TWOMAN_BRIDGE_HEALTH_TEMPLATE}"
echo
echo "Host deployment complete."

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
  curl -sk "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    -F "dir=${remote_dir}" \
    -F "overwrite=1" \
    -F "file-1=@${source_path};filename=${remote_name}" \
    "${TWOMAN_CPANEL_BASE_URL}/execute/Fileman/upload_files" >/dev/null
}

upload_content() {
  local remote_dir="$1"
  local remote_name="$2"
  local content="$3"
  curl -sk "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    --data-urlencode "dir=${remote_dir}" \
    --data-urlencode "file=${remote_name}" \
    --data-urlencode "content=${content}" \
    --data-urlencode "from_charset=UTF-8" \
    --data-urlencode "to_charset=UTF-8" \
    --data-urlencode "fallback=1" \
    "${TWOMAN_CPANEL_BASE_URL}/execute/Fileman/save_file_content" >/dev/null
}

delete_remote_file() {
  local remote_dir="$1"
  local remote_name="$2"
  curl -sk "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    --data-urlencode "op=trash" \
    --data-urlencode "sourcefiles=${remote_name}" \
    --data-urlencode "metadata=${remote_dir}" \
    "${TWOMAN_CPANEL_BASE_URL}/execute/Fileman/file_op" >/dev/null || true
}

mkdir_api() {
  local parent_path="$1"
  local dir_name="$2"
  curl -sk "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
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

run_admin_mode() {
  local mode="$1"
  curl -sk "${PUBLIC_PROXY_ARGS[@]}" --connect-timeout 10 --max-time 20 "https://${TWOMAN_PUBLIC_HOST}/${TWOMAN_ADMIN_SCRIPT_NAME}?mode=${mode}" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
if payload.get("code", 1) != 0:
    raise SystemExit(json.dumps(payload, indent=2))
print(json.dumps(payload, indent=2))
'
}

require_env TWOMAN_CPANEL_BASE_URL
require_env TWOMAN_CPANEL_USERNAME
require_env TWOMAN_CPANEL_PASSWORD
require_env TWOMAN_CPANEL_HOME
require_env TWOMAN_PUBLIC_HOST
require_env TWOMAN_CLIENT_TOKEN
require_env TWOMAN_AGENT_TOKEN
TWOMAN_CPANEL_PROXY_URL="${TWOMAN_CPANEL_PROXY_URL:-${TWOMAN_UPSTREAM_PROXY_URL:-}}"
TWOMAN_PUBLIC_PROXY_URL="${TWOMAN_PUBLIC_PROXY_URL:-${TWOMAN_UPSTREAM_PROXY_URL:-}}"

CPANEL_PROXY_ARGS=()
if [ -n "${TWOMAN_CPANEL_PROXY_URL}" ]; then
  CPANEL_PROXY_ARGS+=(--proxy "${TWOMAN_CPANEL_PROXY_URL}")
fi
PUBLIC_PROXY_ARGS=()
if [ -n "${TWOMAN_PUBLIC_PROXY_URL}" ]; then
  PUBLIC_PROXY_ARGS+=(--proxy "${TWOMAN_PUBLIC_PROXY_URL}")
fi

TWOMAN_CAMOUFLAGE_SITE_ENABLED="${TWOMAN_CAMOUFLAGE_SITE_ENABLED:-true}"
TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID="${TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID:-}"
TWOMAN_CAMOUFLAGE_SITE_NAME="${TWOMAN_CAMOUFLAGE_SITE_NAME:-}"
TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX="${TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX:-true}"
TWOMAN_NODE_BUNDLE_PATH="$(mktemp)"
cleanup() {
  rm -f "${TWOMAN_NODE_BUNDLE_PATH}"
  if [ -n "${CAMOUFLAGE_MANIFEST_PATH:-}" ] && [ -f "${CAMOUFLAGE_MANIFEST_PATH}" ]; then
    rm -f "${CAMOUFLAGE_MANIFEST_PATH}"
  fi
}
trap cleanup EXIT
if [ -f "host/node_selector/app.js" ]; then
  cp "host/node_selector/app.js" "${TWOMAN_NODE_BUNDLE_PATH}"
elif command -v npx >/dev/null 2>&1; then
  npx --yes esbuild host/node_selector/broker.js \
    --bundle \
    --platform=node \
    --target=node20 \
    --format=cjs \
    --outfile="${TWOMAN_NODE_BUNDLE_PATH}" >/dev/null
else
  echo "missing host/node_selector/app.js and npx is unavailable to build it" >&2
  exit 1
fi

TWOMAN_NODE_APP_ROOT="${TWOMAN_NODE_APP_ROOT:-${TWOMAN_CPANEL_HOME}/rahkar_node}"
TWOMAN_NODE_APP_URI="${TWOMAN_NODE_APP_URI:-/rahkar-node}"
TWOMAN_NODE_VERSION="${TWOMAN_NODE_VERSION:-20}"
TWOMAN_NODE_APP_MODE="${TWOMAN_NODE_APP_MODE:-production}"
TWOMAN_ADMIN_SCRIPT_NAME="${TWOMAN_ADMIN_SCRIPT_NAME:-rahkar_negahban.php}"
TWOMAN_TRACE="${TWOMAN_TRACE:-0}"
TWOMAN_DEBUG_STATS="${TWOMAN_DEBUG_STATS:-0}"
TWOMAN_DOWN_WAIT_CTL_MS="${TWOMAN_DOWN_WAIT_CTL_MS:-75}"
TWOMAN_DOWN_WAIT_DATA_MS="${TWOMAN_DOWN_WAIT_DATA_MS:-75}"
TWOMAN_MAX_FRAME_PAYLOAD_BYTES="${TWOMAN_MAX_FRAME_PAYLOAD_BYTES:-2097152}"
TWOMAN_UPLOAD_PROBE_EVENT_LIMIT="${TWOMAN_UPLOAD_PROBE_EVENT_LIMIT:-4096}"
TWOMAN_AGENT_PEER_ID="${TWOMAN_AGENT_PEER_ID:-agent-main}"
TWOMAN_HELPER_DATA_UP_WORKERS="${TWOMAN_HELPER_DATA_UP_WORKERS:-8}"
TWOMAN_AGENT_DATA_UP_WORKERS="${TWOMAN_AGENT_DATA_UP_WORKERS:-8}"
TWOMAN_HELPER_DATA_UPLOAD_MAX_BATCH_BYTES="${TWOMAN_HELPER_DATA_UPLOAD_MAX_BATCH_BYTES:-524288}"
TWOMAN_AGENT_DATA_UPLOAD_MAX_BATCH_BYTES="${TWOMAN_AGENT_DATA_UPLOAD_MAX_BATCH_BYTES:-524288}"
TWOMAN_HELPER_DATA_UPLOAD_FLUSH_DELAY_SECONDS="${TWOMAN_HELPER_DATA_UPLOAD_FLUSH_DELAY_SECONDS:-0.006}"
TWOMAN_AGENT_DATA_UPLOAD_FLUSH_DELAY_SECONDS="${TWOMAN_AGENT_DATA_UPLOAD_FLUSH_DELAY_SECONDS:-0.006}"
TWOMAN_HELPER_DOWN_COMBINED_DATA_LANE="${TWOMAN_HELPER_DOWN_COMBINED_DATA_LANE:-true}"
TWOMAN_AGENT_DOWN_COMBINED_DATA_LANE="${TWOMAN_AGENT_DOWN_COMBINED_DATA_LANE:-true}"
# Go dataplane defaults to the measured fast cPanel profile: collapsed data
# lanes and short bounded polls. Operators can override these envs for rollback.
TWOMAN_STREAMING_DATA_DOWN_HELPER="${TWOMAN_STREAMING_DATA_DOWN_HELPER:-true}"
TWOMAN_STREAMING_DATA_DOWN_AGENT="${TWOMAN_STREAMING_DATA_DOWN_AGENT:-true}"
TWOMAN_WEBSOCKET_PUBLIC_ENABLED="${TWOMAN_WEBSOCKET_PUBLIC_ENABLED:-false}"

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

CAMOUFLAGE_MANIFEST_PATH=""
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
  if [ -z "${TWOMAN_NODE_APP_URI:-}" ] || [ "${TWOMAN_NODE_APP_URI}" = "/rahkar-node" ]; then
    TWOMAN_NODE_APP_URI="$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "node_base_path")"
  fi
fi

APP_RELATIVE="${TWOMAN_NODE_APP_ROOT#${TWOMAN_CPANEL_HOME}/}"
ensure_remote_dir "${APP_RELATIVE}"
ensure_remote_dir "logs"
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
  upload_content "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" "index.html" "${CAMOUFLAGE_INDEX}"
  upload_content "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" "about.html" "${CAMOUFLAGE_ABOUT}"
  upload_content "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" "contact.html" "${CAMOUFLAGE_CONTACT}"
  upload_content "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" "404.html" "${CAMOUFLAGE_404}"
  upload_content "${TWOMAN_CPANEL_HOME}/public_html/${CAMOUFLAGE_SITE_SLUG}" ".htaccess" "${CAMOUFLAGE_SLUG_HTACCESS}"
  if [ "${TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX}" = "true" ]; then
    upload_content "${TWOMAN_CPANEL_HOME}/public_html" "index.html" "${CAMOUFLAGE_INDEX}"
    upload_content "${TWOMAN_CPANEL_HOME}/public_html" "about.html" "${CAMOUFLAGE_ABOUT}"
    upload_content "${TWOMAN_CPANEL_HOME}/public_html" "contact.html" "${CAMOUFLAGE_CONTACT}"
    upload_content "${TWOMAN_CPANEL_HOME}/public_html" "404.html" "${CAMOUFLAGE_404}"
    upload_content "${TWOMAN_CPANEL_HOME}/public_html" "robots.txt" "${CAMOUFLAGE_ROBOTS}"
    upload_content "${TWOMAN_CPANEL_HOME}/public_html" "sitemap.xml" "${CAMOUFLAGE_SITEMAP}"
    upload_content "${TWOMAN_CPANEL_HOME}/public_html" ".htaccess" "${CAMOUFLAGE_ROOT_HTACCESS}"
  fi
fi

CONFIG_JSON="$(cat <<EOF
{
  "base_uri": "${TWOMAN_NODE_APP_URI}",
  "client_tokens": ["${TWOMAN_CLIENT_TOKEN}"],
  "agent_tokens": ["${TWOMAN_AGENT_TOKEN}"],
  "preferred_agent_peer_label": "${TWOMAN_AGENT_PEER_ID}",
  "peer_ttl_seconds": 90,
  "stream_ttl_seconds": 300,
  "max_lane_bytes": 67108864,
  "max_frame_payload_bytes": ${TWOMAN_MAX_FRAME_PAYLOAD_BYTES},
  "upload_probe_event_limit": ${TWOMAN_UPLOAD_PROBE_EVENT_LIMIT},
  "max_streams_per_peer_session": 256,
  "max_open_rate_per_peer_session": 120,
  "open_rate_window_seconds": 10,
  "max_peer_buffered_bytes": 134217728,
  "flush_backpressure_bytes": 2097152,
  "flush_retry_delay_ms": 5,
  "down_wait_ms": {
    "ctl": ${TWOMAN_DOWN_WAIT_CTL_MS},
    "data": ${TWOMAN_DOWN_WAIT_DATA_MS}
  },
  "helper_down_combined_data_lane": ${TWOMAN_HELPER_DOWN_COMBINED_DATA_LANE},
  "agent_down_combined_data_lane": ${TWOMAN_AGENT_DOWN_COMBINED_DATA_LANE},
  "helper_data_up_workers": ${TWOMAN_HELPER_DATA_UP_WORKERS},
  "agent_data_up_workers": ${TWOMAN_AGENT_DATA_UP_WORKERS},
  "helper_data_upload_max_batch_bytes": ${TWOMAN_HELPER_DATA_UPLOAD_MAX_BATCH_BYTES},
  "agent_data_upload_max_batch_bytes": ${TWOMAN_AGENT_DATA_UPLOAD_MAX_BATCH_BYTES},
  "helper_data_upload_flush_delay_seconds": ${TWOMAN_HELPER_DATA_UPLOAD_FLUSH_DELAY_SECONDS},
  "agent_data_upload_flush_delay_seconds": ${TWOMAN_AGENT_DATA_UPLOAD_FLUSH_DELAY_SECONDS},
  "streaming_data_down_helper": ${TWOMAN_STREAMING_DATA_DOWN_HELPER},
  "streaming_data_down_agent": ${TWOMAN_STREAMING_DATA_DOWN_AGENT},
  "websocket_public_enabled": ${TWOMAN_WEBSOCKET_PUBLIC_ENABLED},
  "lane_profiles": {
    "ctl": { "max_bytes": 4096, "max_frames": 8, "hold_ms": 1, "pad_min": 1024 },
    "pri": { "max_bytes": 32768, "max_frames": 16, "hold_ms": 2, "pad_min": 1024 },
    "bulk": { "max_bytes": 1048576, "max_frames": 128, "hold_ms": 4, "pad_min": 0 }
  },
  "trace_enabled": ${TWOMAN_TRACE},
  "debug_stats_enabled": ${TWOMAN_DEBUG_STATS}
}
EOF
)"

upload_file "${TWOMAN_NODE_BUNDLE_PATH}" "${TWOMAN_NODE_APP_ROOT}" "app.js"
upload_content "${TWOMAN_NODE_APP_ROOT}" "package.json" "$(cat host/node_selector/package.json)"
upload_content "${TWOMAN_NODE_APP_ROOT}" "config.json" "${CONFIG_JSON}"

ADMIN_PHP="$(cat <<EOF
<?php
header('Content-Type: application/json');
function run_cmd(\$command) {
    \$spec = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];
    \$proc = proc_open(\$command, \$spec, \$pipes, '${TWOMAN_CPANEL_HOME}');
    if (!is_resource(\$proc)) {
        return ['code' => 1, 'stdout' => '', 'stderr' => 'proc_open failed'];
    }
    fclose(\$pipes[0]);
    \$stdout = stream_get_contents(\$pipes[1]);
    \$stderr = stream_get_contents(\$pipes[2]);
    fclose(\$pipes[1]);
    fclose(\$pipes[2]);
    \$code = proc_close(\$proc);
    return ['code' => \$code, 'stdout' => \$stdout, 'stderr' => \$stderr];
}

\$appRoot = '$(printf "%s" "${APP_RELATIVE}")';
\$appUri = '$(printf "%s" "${TWOMAN_NODE_APP_URI}")';
\$version = '$(printf "%s" "${TWOMAN_NODE_VERSION}")';
\$appMode = '$(printf "%s" "${TWOMAN_NODE_APP_MODE}")';
\$selector = '/usr/sbin/cloudlinux-selector';
\$commands = [
    'destroy' => escapeshellarg(\$selector) . " destroy --json --interpreter nodejs --app-root " . escapeshellarg(\$appRoot) . " 2>&1 || true",
    'create' => escapeshellarg(\$selector) . " create --json --interpreter nodejs --domain " . escapeshellarg('${TWOMAN_PUBLIC_HOST}') . " --app-root " . escapeshellarg(\$appRoot) . " --app-uri " . escapeshellarg(\$appUri) . " --app-mode " . escapeshellarg(\$appMode) . " --version " . escapeshellarg(\$version) . " --startup-file app.js 2>&1",
    'restart' => escapeshellarg(\$selector) . " restart --json --interpreter nodejs --app-root " . escapeshellarg(\$appRoot) . " 2>&1",
];
\$mode = isset(\$_GET['mode']) ? \$_GET['mode'] : '';
if (!isset(\$commands[\$mode])) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid mode', 'mode' => \$mode, 'modes' => array_keys(\$commands)], JSON_PRETTY_PRINT);
    exit;
}
\$result = run_cmd(\$commands[\$mode]);
\$result['mode'] = \$mode;
echo json_encode(\$result, JSON_PRETTY_PRINT);
EOF
)"

upload_content "${TWOMAN_CPANEL_HOME}/public_html" "${TWOMAN_ADMIN_SCRIPT_NAME}" "${ADMIN_PHP}"

echo "Destroying any previous Node selector app..."
run_admin_mode destroy
echo "Creating Node selector app..."
run_admin_mode create
echo "Restarting Node selector app..."
run_admin_mode restart

echo "Checking Node broker health..."
sleep 3
curl -sk "${PUBLIC_PROXY_ARGS[@]}" --connect-timeout 10 --max-time 20 -H "Authorization: Bearer ${TWOMAN_CLIENT_TOKEN}" "https://${TWOMAN_PUBLIC_HOST}${TWOMAN_NODE_APP_URI}/health" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
if not payload.get("ok"):
    raise SystemExit(json.dumps(payload, indent=2))
print(json.dumps(payload, indent=2))
'
delete_remote_file "${TWOMAN_CPANEL_HOME}/public_html" "${TWOMAN_ADMIN_SCRIPT_NAME}"
if [ -n "${CAMOUFLAGE_MANIFEST_PATH}" ]; then
  if [ "${TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX}" = "true" ]; then
    echo "Camouflage root page: https://${TWOMAN_PUBLIC_HOST}/"
  fi
  echo "Camouflage site: https://${TWOMAN_PUBLIC_HOST}/$(json_get "${CAMOUFLAGE_MANIFEST_PATH}" "site_slug")/"
fi
echo "Node base path: https://${TWOMAN_PUBLIC_HOST}${TWOMAN_NODE_APP_URI}"
echo
echo "Node selector host deployment complete."

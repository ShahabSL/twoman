#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 1
  fi
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

delete_relative_path() {
  local relative_path="$1"
  curl -sk "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    --get \
    --data-urlencode "cpanel_jsonapi_user=${TWOMAN_CPANEL_USERNAME}" \
    --data-urlencode "cpanel_jsonapi_apiversion=2" \
    --data-urlencode "cpanel_jsonapi_module=Fileman" \
    --data-urlencode "cpanel_jsonapi_func=fileop" \
    --data-urlencode "op=trash" \
    --data-urlencode "sourcefiles=${relative_path}" \
    --data-urlencode "doubledecode=1" \
    "${TWOMAN_CPANEL_BASE_URL}/json-api/cpanel" >/dev/null || true
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
require_env TWOMAN_NODE_APP_ROOT
require_env TWOMAN_ADMIN_SCRIPT_NAME
TWOMAN_NODE_APP_URI="${TWOMAN_NODE_APP_URI:-}"
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

APP_RELATIVE="${TWOMAN_NODE_APP_ROOT#"${TWOMAN_CPANEL_HOME}"/}"
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
\$selector = '/usr/sbin/cloudlinux-selector';
\$command = escapeshellarg(\$selector) . " destroy --json --interpreter nodejs --app-root " . escapeshellarg(\$appRoot) . " 2>&1 || true";
\$result = run_cmd(\$command);
\$result['mode'] = 'destroy';
echo json_encode(\$result, JSON_PRETTY_PRINT);
EOF
)"

upload_content "${TWOMAN_CPANEL_HOME}/public_html" "${TWOMAN_ADMIN_SCRIPT_NAME}" "${ADMIN_PHP}"
run_admin_mode destroy >/dev/null
delete_relative_path "public_html/${TWOMAN_ADMIN_SCRIPT_NAME}"
delete_relative_path "${APP_RELATIVE}"
NODE_PATH_TRIMMED="${TWOMAN_NODE_APP_URI#/}"
if [ -n "${NODE_PATH_TRIMMED}" ]; then
  delete_relative_path "public_html/${NODE_PATH_TRIMMED}"
fi

echo "Purged node app ${TWOMAN_NODE_APP_ROOT}"

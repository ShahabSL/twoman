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
  curl -sk "${CPANEL_PROXY_ARGS[@]}" --user "${TWOMAN_CPANEL_USERNAME}:${TWOMAN_CPANEL_PASSWORD}" \
    --get \
    "$@" \
    "${TWOMAN_CPANEL_BASE_URL}/execute/${endpoint}"
}

trash_relative_path() {
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

require_env TWOMAN_CPANEL_BASE_URL
require_env TWOMAN_CPANEL_USERNAME
require_env TWOMAN_CPANEL_PASSWORD
require_env TWOMAN_CPANEL_HOME
require_env TWOMAN_PUBLIC_ORIGIN
require_env TWOMAN_PUBLIC_BASE_PATH
require_env TWOMAN_APP_NAME
require_env TWOMAN_APP_ROOT
TWOMAN_CPANEL_PROXY_URL="${TWOMAN_CPANEL_PROXY_URL:-${TWOMAN_UPSTREAM_PROXY_URL:-}}"

CPANEL_PROXY_ARGS=()
if [ -n "${TWOMAN_CPANEL_PROXY_URL}" ]; then
  CPANEL_PROXY_ARGS+=(--proxy "${TWOMAN_CPANEL_PROXY_URL}")
fi

HOST_DOMAIN="${TWOMAN_PUBLIC_ORIGIN#https://}"
HOST_DOMAIN="${HOST_DOMAIN#http://}"
HOST_DOMAIN="${HOST_DOMAIN%%/*}"
APP_RELATIVE="${TWOMAN_APP_ROOT#"${TWOMAN_CPANEL_HOME}"/}"

api_get "PassengerApps/unregister_application" \
  --data-urlencode "name=${TWOMAN_APP_NAME}" \
  --data-urlencode "path=${TWOMAN_APP_ROOT}" \
  --data-urlencode "domain=${HOST_DOMAIN}" \
  --data-urlencode "base_uri=${TWOMAN_PUBLIC_BASE_PATH}" >/dev/null || true

if [ -n "${APP_RELATIVE}" ] && [ "${APP_RELATIVE}" != "${TWOMAN_APP_ROOT}" ]; then
  trash_relative_path "${APP_RELATIVE}"
fi

echo "Purged Passenger app ${TWOMAN_APP_NAME}"

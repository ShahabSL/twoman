#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 1
  fi
}

TWOMAN_SERVER_HOST="${TWOMAN_SERVER_HOST:-}"
TWOMAN_SERVER_USER="${TWOMAN_SERVER_USER:-}"
require_env TWOMAN_SERVER_HOST
require_env TWOMAN_SERVER_USER
require_env TWOMAN_INSTALL_ROOT
require_env TWOMAN_AGENT_SERVICE_NAME
require_env TWOMAN_WATCHDOG_SERVICE_NAME
require_env TWOMAN_WATCHDOG_TIMER_NAME

TWOMAN_SERVER_PORT="${TWOMAN_SERVER_PORT:-22}"
TWOMAN_SERVER_PASSWORD="${TWOMAN_SERVER_PASSWORD:-}"
TWOMAN_SERVER_SSH_KEY="${TWOMAN_SERVER_SSH_KEY:-}"
TWOMAN_SSH_USER_KNOWN_HOSTS_FILE="${TWOMAN_SSH_USER_KNOWN_HOSTS_FILE:-}"
TWOMAN_SSH_UPDATE_HOSTKEYS="${TWOMAN_SSH_UPDATE_HOSTKEYS:-}"

SSH_OPTS=(-p "${TWOMAN_SERVER_PORT}" -o StrictHostKeyChecking=no)
if [ -n "${TWOMAN_SSH_USER_KNOWN_HOSTS_FILE}" ]; then
  SSH_OPTS+=(-o "UserKnownHostsFile=${TWOMAN_SSH_USER_KNOWN_HOSTS_FILE}")
fi
if [ -n "${TWOMAN_SSH_UPDATE_HOSTKEYS}" ]; then
  SSH_OPTS+=(-o "UpdateHostKeys=${TWOMAN_SSH_UPDATE_HOSTKEYS}")
fi
if [ -n "${TWOMAN_SERVER_SSH_KEY}" ]; then
  SSH_OPTS+=(-i "${TWOMAN_SERVER_SSH_KEY}")
fi
SSH_CMD=(ssh "${SSH_OPTS[@]}")
if [ -n "${TWOMAN_SERVER_PASSWORD}" ]; then
  export SSHPASS="${TWOMAN_SERVER_PASSWORD}"
  SSH_CMD=(sshpass -e "${SSH_CMD[@]}")
fi

"${SSH_CMD[@]}" "${TWOMAN_SERVER_USER}@${TWOMAN_SERVER_HOST}" "\
TWOMAN_INSTALL_ROOT='${TWOMAN_INSTALL_ROOT}' \
TWOMAN_AGENT_SERVICE_NAME='${TWOMAN_AGENT_SERVICE_NAME}' \
TWOMAN_WATCHDOG_SERVICE_NAME='${TWOMAN_WATCHDOG_SERVICE_NAME}' \
TWOMAN_WATCHDOG_TIMER_NAME='${TWOMAN_WATCHDOG_TIMER_NAME}' \
bash -s" <<'EOF'
set -euo pipefail

stop_disable_unit() {
  local unit_name="$1"
  systemctl stop "${unit_name}" >/dev/null 2>&1 || true
  systemctl disable "${unit_name}" >/dev/null 2>&1 || true
}

remove_unit_file() {
  local unit_name="$1"
  rm -f "/etc/systemd/system/${unit_name}"
}

stop_disable_unit "${TWOMAN_WATCHDOG_TIMER_NAME}"
stop_disable_unit "${TWOMAN_WATCHDOG_SERVICE_NAME}"
stop_disable_unit "${TWOMAN_AGENT_SERVICE_NAME}"

remove_unit_file "${TWOMAN_WATCHDOG_TIMER_NAME}"
remove_unit_file "${TWOMAN_WATCHDOG_SERVICE_NAME}"
remove_unit_file "${TWOMAN_AGENT_SERVICE_NAME}"

systemctl daemon-reload
systemctl reset-failed "${TWOMAN_AGENT_SERVICE_NAME}" >/dev/null 2>&1 || true
systemctl reset-failed "${TWOMAN_WATCHDOG_SERVICE_NAME}" >/dev/null 2>&1 || true
systemctl reset-failed "${TWOMAN_WATCHDOG_TIMER_NAME}" >/dev/null 2>&1 || true

rm -rf "${TWOMAN_INSTALL_ROOT}"

echo "Purged hidden install ${TWOMAN_INSTALL_ROOT}"
EOF

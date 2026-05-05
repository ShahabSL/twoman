#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_PATH="/etc/systemd/system/twoman-agent-watchdog.service"
TIMER_PATH="/etc/systemd/system/twoman-agent-watchdog.timer"
TARGET_DIR="/opt/twoman"

install -m 0755 "${SCRIPT_DIR}/agent_watchdog.py" "${TARGET_DIR}/agent_watchdog.py"
install -m 0644 "${SCRIPT_DIR}/systemd/twoman-agent-watchdog.service" "${SERVICE_PATH}"
install -m 0644 "${SCRIPT_DIR}/systemd/twoman-agent-watchdog.timer" "${TIMER_PATH}"

systemctl daemon-reload
systemctl enable --now twoman-agent-watchdog.timer
systemctl start twoman-agent-watchdog.service
systemctl status --no-pager twoman-agent-watchdog.timer

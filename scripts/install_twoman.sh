#!/usr/bin/env bash
set -euo pipefail

TWOMAN_REPO_URL="${TWOMAN_REPO_URL:-https://github.com/ShahabSL/twoman}"
TWOMAN_REPO_REF="${TWOMAN_REPO_REF:-main}"
TWOMAN_REPO_ARCHIVE_URL="${TWOMAN_REPO_ARCHIVE_URL:-${TWOMAN_REPO_URL}/archive/refs/heads/${TWOMAN_REPO_REF}.tar.gz}"

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

BOOTSTRAP_ROOT="$(mktemp -d /tmp/twoman-install.XXXXXX)"
REPO_ROOT=""

cleanup() {
  rm -rf "${BOOTSTRAP_ROOT}"
}
trap cleanup EXIT

ensure_python_venv_support() {
  local probe_dir
  probe_dir="$(mktemp -d)"
  if python3 -m venv "${probe_dir}/venv" >/dev/null 2>&1; then
    rm -rf "${probe_dir}"
    return 0
  fi
  rm -rf "${probe_dir}"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv
    return 0
  fi
  echo "python3-venv is required to bootstrap Twoman." >&2
  exit 1
}

create_bootstrap_venv() {
  local venv_root="${BOOTSTRAP_ROOT}/bootstrap-venv"
  python3 -m venv "${venv_root}"
  "${venv_root}/bin/python" -m pip install --upgrade pip >&2
  "${venv_root}/bin/python" -m pip install -r "${REPO_ROOT}/requirements.txt" >&2
  printf '%s\n' "${venv_root}"
}

if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/../twoman_control/cli.py" ]; then
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
  mkdir -p "${BOOTSTRAP_ROOT}/repo"
  curl -fsSL "${TWOMAN_REPO_ARCHIVE_URL}" | tar -xz --strip-components=1 -C "${BOOTSTRAP_ROOT}/repo"
  REPO_ROOT="${BOOTSTRAP_ROOT}/repo"
fi

ensure_python_venv_support
BOOTSTRAP_VENV="$(create_bootstrap_venv)"

export PYTHONPATH="${REPO_ROOT}:${PYTHONPATH:-}"
if [ -z "${TWOMAN_SERVER_LAUNCHER_PATH:-}" ] && [ -n "${TWOMAN_LAUNCHER_PATH:-}" ]; then
  export TWOMAN_SERVER_LAUNCHER_PATH="${TWOMAN_LAUNCHER_PATH}"
fi
export TWOMAN_SERVER_LAUNCHER_PATH="${TWOMAN_SERVER_LAUNCHER_PATH:-/usr/local/bin/twoman-server}"
"${BOOTSTRAP_VENV}/bin/python" -m twoman_control.cli install --repo-root "${REPO_ROOT}" "$@"

#!/usr/bin/env bash
set -euo pipefail

TWOMAN_REPO_URL="${TWOMAN_REPO_URL:-https://github.com/ShahabSL/twoman}"
TWOMAN_REPO_REF_FROM_ENV="${TWOMAN_REPO_REF:-}"
TWOMAN_REPO_REF="${TWOMAN_REPO_REF_FROM_ENV:-main}"
TWOMAN_INSTALL_VERSION="${TWOMAN_INSTALL_VERSION:-}"
TWOMAN_REPO_REF_EXPLICIT=0
if [ -n "${TWOMAN_REPO_REF_FROM_ENV}" ]; then
  TWOMAN_REPO_REF_EXPLICIT=1
fi
TWOMAN_REPO_ARCHIVE_URL_FROM_ENV="${TWOMAN_REPO_ARCHIVE_URL:-}"
PASSTHROUGH_ARGS=()

usage() {
  cat <<'EOF'
Twoman server installer

Usage:
  sudo bash scripts/install_twoman.sh [--version VERSION] [installer options]
  curl -fsSL https://raw.githubusercontent.com/ShahabSL/twoman/main/scripts/install_twoman.sh | sudo bash -s -- --version 1.0.7

Options handled by bootstrap:
  --version VERSION  Install from a specific GitHub release tag, for example 1.0.7 or v1.0.7.
  --ref REF          Install from a specific repository branch/ref name.
  --help            Show this bootstrap help.

Other options are passed through to twoman-server install.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "--version requires a value" >&2
        exit 2
      fi
      TWOMAN_INSTALL_VERSION="$2"
      shift 2
      ;;
    --version=*)
      TWOMAN_INSTALL_VERSION="${1#--version=}"
      shift
      ;;
    --ref)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "--ref requires a value" >&2
        exit 2
      fi
      TWOMAN_REPO_REF="$2"
      TWOMAN_REPO_REF_EXPLICIT=1
      shift 2
      ;;
    --ref=*)
      TWOMAN_REPO_REF="${1#--ref=}"
      TWOMAN_REPO_REF_EXPLICIT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ -n "${TWOMAN_REPO_ARCHIVE_URL_FROM_ENV}" ]; then
  TWOMAN_REPO_ARCHIVE_URL="${TWOMAN_REPO_ARCHIVE_URL_FROM_ENV}"
elif [ -n "${TWOMAN_INSTALL_VERSION}" ]; then
  if [[ "${TWOMAN_INSTALL_VERSION}" == v* ]]; then
    TWOMAN_REPO_REF="${TWOMAN_INSTALL_VERSION}"
  else
    TWOMAN_REPO_REF="v${TWOMAN_INSTALL_VERSION}"
  fi
  TWOMAN_REPO_ARCHIVE_URL="${TWOMAN_REPO_URL}/archive/refs/tags/${TWOMAN_REPO_REF}.tar.gz"
else
  TWOMAN_REPO_ARCHIVE_URL="${TWOMAN_REPO_URL}/archive/refs/heads/${TWOMAN_REPO_REF}.tar.gz"
fi

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E env \
    "TWOMAN_INSTALL_VERSION=${TWOMAN_INSTALL_VERSION}" \
    "TWOMAN_REPO_REF=${TWOMAN_REPO_REF}" \
    "TWOMAN_REPO_ARCHIVE_URL=${TWOMAN_REPO_ARCHIVE_URL}" \
    bash "$0" "${PASSTHROUGH_ARGS[@]}"
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

if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/../twoman_control/cli.py" ] && [ -z "${TWOMAN_INSTALL_VERSION}" ] && [ "${TWOMAN_REPO_REF_EXPLICIT}" -eq 0 ] && [ -z "${TWOMAN_REPO_ARCHIVE_URL_FROM_ENV}" ]; then
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
"${BOOTSTRAP_VENV}/bin/python" -m twoman_control.cli install --repo-root "${REPO_ROOT}" "${PASSTHROUGH_ARGS[@]}"

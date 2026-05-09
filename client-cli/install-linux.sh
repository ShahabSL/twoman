#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${TWOMAN_PREFIX:-/usr/local}"
BIN_DIR="${TWOMAN_BIN_DIR:-${PREFIX}/bin}"
LIB_DIR="${TWOMAN_LIB_DIR:-${PREFIX}/lib/twoman}"
REPO="${TWOMAN_REPO:-ShahabSL/twoman}"
REQUESTED_VERSION=""
TEMP_DIR=""

usage() {
  cat <<'EOF'
Twoman Linux client installer

Usage:
  sudo ./install.sh [--version VERSION] [--prefix DIR]
  curl -fsSL https://raw.githubusercontent.com/ShahabSL/twoman/main/client-cli/install-linux.sh | sudo bash -s -- --version 1.0.7

Options:
  --version VERSION  Download and install a specific GitHub release version.
  --prefix DIR       Install under DIR instead of /usr/local.
  --repo OWNER/REPO  GitHub repository, default ShahabSL/twoman.
EOF
}

cleanup() {
  if [ -n "${TEMP_DIR}" ]; then
    rm -rf "${TEMP_DIR}"
  fi
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "--version requires a value" >&2
        exit 2
      fi
      REQUESTED_VERSION="${2:-}"
      shift 2
      ;;
    --version=*)
      REQUESTED_VERSION="${1#--version=}"
      shift
      ;;
    --prefix)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "--prefix requires a value" >&2
        exit 2
      fi
      PREFIX="${2:-}"
      BIN_DIR="${TWOMAN_BIN_DIR:-${PREFIX}/bin}"
      LIB_DIR="${TWOMAN_LIB_DIR:-${PREFIX}/lib/twoman}"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#--prefix=}"
      BIN_DIR="${TWOMAN_BIN_DIR:-${PREFIX}/bin}"
      LIB_DIR="${TWOMAN_LIB_DIR:-${PREFIX}/lib/twoman}"
      shift
      ;;
    --repo)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "--repo requires a value" >&2
        exit 2
      fi
      REPO="${2:-}"
      shift 2
      ;;
    --repo=*)
      REPO="${1#--repo=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

download_release_bundle() {
  local version="$1"
  local tag="$version"
  if [[ "${tag}" != v* ]]; then
    tag="v${tag}"
  fi
  local archive="twoman-cli-linux-amd64-${tag}.tar.gz"
  local url="https://github.com/${REPO}/releases/download/${tag}/${archive}"
  TEMP_DIR="$(mktemp -d)"
  echo "Downloading Twoman ${tag} from ${url}"
  curl -fL --connect-timeout 20 --max-time 300 "${url}" -o "${TEMP_DIR}/${archive}"
  tar -xzf "${TEMP_DIR}/${archive}" -C "${TEMP_DIR}"
  BUNDLE_DIR="${TEMP_DIR}/twoman-linux-amd64"
}

if [ -n "${REQUESTED_VERSION}" ]; then
  download_release_bundle "${REQUESTED_VERSION}"
fi

if [ ! -x "${BUNDLE_DIR}/twoman" ]; then
  echo "missing bundle binary: ${BUNDLE_DIR}/twoman" >&2
  exit 1
fi

if [ ! -x "${BUNDLE_DIR}/twoman-helper-agent" ]; then
  echo "missing bundle helper: ${BUNDLE_DIR}/twoman-helper-agent" >&2
  exit 1
fi

install -d -m 0755 "${BIN_DIR}" "${LIB_DIR}"
install -m 0755 "${BUNDLE_DIR}/twoman" "${BIN_DIR}/twoman"
install -m 0755 "${BUNDLE_DIR}/twoman-helper-agent" "${LIB_DIR}/twoman-helper-agent"

echo "Installed Twoman client:"
echo "  ${BIN_DIR}/twoman"
echo "  ${LIB_DIR}/twoman-helper-agent"
if client_version="$("${BIN_DIR}/twoman" version 2>/dev/null)"; then
  echo "${client_version}"
fi
if helper_version="$("${LIB_DIR}/twoman-helper-agent" --version 2>/dev/null)"; then
  echo "${helper_version}"
fi
echo ""
echo "Next:"
echo "  twoman import 'twoman://profile?data=...'"
echo "  twoman service install"
echo "  twoman status"
echo "  twoman logs export --output ~/twoman-diagnostics"

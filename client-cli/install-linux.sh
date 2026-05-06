#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${TWOMAN_PREFIX:-/usr/local}"
BIN_DIR="${TWOMAN_BIN_DIR:-${PREFIX}/bin}"
LIB_DIR="${TWOMAN_LIB_DIR:-${PREFIX}/lib/twoman}"

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
echo ""
echo "Next:"
echo "  twoman import 'twoman://profile?data=...'"
echo "  twoman connect"

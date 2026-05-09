#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${ROOT}/dist/client-cli/twoman-linux-amd64}"
OUT_DIR="$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "${OUT_DIR}")"
TWOMAN_VERSION="${TWOMAN_VERSION:-$(cat "${ROOT}/VERSION")}"
TWOMAN_BUILD_COMMIT="${TWOMAN_BUILD_COMMIT:-$(git -C "${ROOT}" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)}"
TWOMAN_BUILD_TIME="${TWOMAN_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
GO_LDFLAGS="-s -w -X main.version=${TWOMAN_VERSION} -X main.commit=${TWOMAN_BUILD_COMMIT} -X main.buildTime=${TWOMAN_BUILD_TIME}"
ARCHIVE_PATH="${TWOMAN_CLIENT_ARCHIVE_PATH:-$(dirname "${OUT_DIR}")/twoman-cli-linux-amd64-v${TWOMAN_VERSION}.tar.gz}"

mkdir -p "${OUT_DIR}"
(
  cd "${ROOT}/helper-agent"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "${GO_LDFLAGS}" -o "${OUT_DIR}/twoman-helper-agent" .
)
(
  cd "${ROOT}/client-cli"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "${GO_LDFLAGS}" -o "${OUT_DIR}/twoman" .
)

cp "${OUT_DIR}/twoman" "${OUT_DIR}/twoman-client"
install -m 0755 "${ROOT}/client-cli/install-linux.sh" "${OUT_DIR}/install.sh"

cat > "${OUT_DIR}/README.txt" <<EOF
Twoman headless Linux client

Version:
  ${TWOMAN_VERSION}

Install:
  sudo ./install.sh

Use:
  twoman import 'twoman://profile?data=...'
  twoman service install
  twoman status
  twoman service logs
  twoman logs export --output ~/twoman-diagnostics
  twoman profiles delete NAME
  twoman service stop

Imported profiles use stable local ports by default. The helper sidecar is
installed automatically; do not pass --helper-bin unless you are developing or
testing a custom helper binary.
EOF

tar -C "$(dirname "${OUT_DIR}")" -czf "${ARCHIVE_PATH}" "$(basename "${OUT_DIR}")"

echo "Built ${OUT_DIR}/twoman"
echo "Built ${OUT_DIR}/twoman-helper-agent"
echo "Built ${OUT_DIR}/install.sh"
echo "Built ${ARCHIVE_PATH}"

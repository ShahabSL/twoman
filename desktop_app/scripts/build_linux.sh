#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "This build script requires x86_64 Linux." >&2
  exit 1
fi

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${APP_ROOT}/.." && pwd)"
BUILD_ROOT="${APP_ROOT}/build/linux-sidecars"
SIDECAR_DIR="${APP_ROOT}/src-tauri/resources/sidecars/linux"
OUT_DIR="${REPO_ROOT}/dist/desktop-linux"
export CARGO_TARGET_DIR="$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "${CARGO_TARGET_DIR:-${APP_ROOT}/src-tauri/target}")"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"

VERSION="$(python3 - "${REPO_ROOT}" <<'PY'
import json
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
version = (root / 'VERSION').read_text().strip()
files = {
    'package.json': json.loads((root / 'desktop_app/package.json').read_text())['version'],
    'package-lock.json': json.loads((root / 'desktop_app/package-lock.json').read_text())['version'],
    'tauri.conf.json': json.loads((root / 'desktop_app/src-tauri/tauri.conf.json').read_text())['version'],
    'Cargo.toml': tomllib.loads((root / 'desktop_app/src-tauri/Cargo.toml').read_text())['package']['version'],
}
lock = tomllib.loads((root / 'desktop_app/src-tauri/Cargo.lock').read_text())
files['Cargo.lock'] = next(package['version'] for package in lock['package'] if package['name'] == 'desktop_app')
for name, actual in files.items():
    if actual != version:
        raise SystemExit(f'{name}: version {actual} does not match VERSION ({version})')
print(version)
PY
)"
COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PORTABLE_NAME="twoman-desktop-linux-amd64-v${VERSION}"
PORTABLE_DIR="${OUT_DIR}/${PORTABLE_NAME}"

mkdir -p "${BUILD_ROOT}" "${SIDECAR_DIR}" "${PORTABLE_DIR}/sidecars/linux"
python3 -m venv "${BUILD_ROOT}/venv"
"${BUILD_ROOT}/venv/bin/python" -m pip --disable-pip-version-check install 'PyInstaller>=6,<7'

(
  cd "${REPO_ROOT}/helper-agent"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
    -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT:0:12} -X main.buildTime=${BUILD_TIME}" \
    -o "${SIDECAR_DIR}/twoman-helper" .
)
"${SIDECAR_DIR}/twoman-helper" --version

"${BUILD_ROOT}/venv/bin/python" -m PyInstaller \
  --noconfirm --clean --onefile \
  --name twoman-gateway \
  --distpath "${SIDECAR_DIR}" \
  --workpath "${BUILD_ROOT}/work-gateway" \
  --specpath "${BUILD_ROOT}" \
  "${REPO_ROOT}/desktop_client/socks_gateway.py"

cd "${APP_ROOT}"
npm ci --no-audit --no-fund
npm run tauri -- build --config src-tauri/tauri.linux.release.conf.json --bundles deb -- --locked

install -m 0755 "${CARGO_TARGET_DIR}/release/twoman-desktop" "${PORTABLE_DIR}/Twoman"
install -m 0755 "${SIDECAR_DIR}/twoman-helper" "${PORTABLE_DIR}/sidecars/linux/twoman-helper"
install -m 0755 "${SIDECAR_DIR}/twoman-gateway" "${PORTABLE_DIR}/sidecars/linux/twoman-gateway"
cp "${REPO_ROOT}/LICENSE" "${PORTABLE_DIR}/LICENSE"
cp "${CARGO_TARGET_DIR}/release/bundle/deb/Twoman_${VERSION}_amd64.deb" "${OUT_DIR}/"

cat > "${PORTABLE_DIR}/README.txt" <<EOF
Twoman desktop client ${VERSION} for x86_64 Linux

Run ./Twoman from this folder. Keep sidecars/linux beside the executable.
The Go helper and Python gateway are bundled; Go, Node, Rust and Python
are not needed on the destination computer.

The interface and client runtime come from the same source as the Windows
desktop client. Linux supports local HTTP/SOCKS proxy mode and authenticated
proxy sharing. System proxy and TUN modes are Windows-only in this version.

Native dependencies: GTK 3 and WebKitGTK 4.1. The Debian package declares
these dependencies for installation with apt. This build targets the
distribution on which it was compiled; it is not an AppImage.
EOF
cat > "${PORTABLE_DIR}/BUILD-INFO.txt" <<EOF
Version: ${VERSION}
Source commit: ${COMMIT}
Built at (UTC): ${BUILD_TIME}
Architecture: x86_64
Kernel: $(uname -sr)
Distribution: $(python3 -c 'import platform; print(platform.freedesktop_os_release()["PRETTY_NAME"])')
EOF
cp "${PORTABLE_DIR}/BUILD-INFO.txt" "${OUT_DIR}/${PORTABLE_NAME}.build-info.txt"
# Only package release files, even if someone has run this portable folder.
tar -C "${OUT_DIR}" -czf "${OUT_DIR}/${PORTABLE_NAME}.tar.gz" \
  "${PORTABLE_NAME}/Twoman" \
  "${PORTABLE_NAME}/sidecars/linux/twoman-helper" \
  "${PORTABLE_NAME}/sidecars/linux/twoman-gateway" \
  "${PORTABLE_NAME}/LICENSE" \
  "${PORTABLE_NAME}/README.txt" \
  "${PORTABLE_NAME}/BUILD-INFO.txt"
(
  cd "${OUT_DIR}"
  sha256sum "Twoman_${VERSION}_amd64.deb" "${PORTABLE_NAME}.tar.gz" "${PORTABLE_NAME}.build-info.txt" > "${PORTABLE_NAME}.sha256"
)
echo "Built ${OUT_DIR}/Twoman_${VERSION}_amd64.deb"
echo "Built ${OUT_DIR}/${PORTABLE_NAME}.tar.gz"

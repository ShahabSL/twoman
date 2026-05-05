#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_ROOT="$ROOT/desktop_app"
BUILD_ROOT="$APP_ROOT/build/linux-sidecars"
VENV_DIR="$BUILD_ROOT/venv"
DIST_DIR="$APP_ROOT/src-tauri/resources/sidecars/linux"
HELPER_NAME="${TWOMAN_HELPER_BINARY_BASENAME:-twoman-helper}"
GATEWAY_NAME="${TWOMAN_GATEWAY_BINARY_BASENAME:-twoman-gateway}"

rm -rf "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT" "$DIST_DIR"

if ! command -v go >/dev/null 2>&1; then
  echo "go is required to build the Twoman Go helper sidecar" >&2
  exit 1
fi

(cd "$ROOT/helper-agent" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$DIST_DIR/$HELPER_NAME" .)

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip wheel >/dev/null
"$VENV_DIR/bin/pip" install -r "$ROOT/requirements.txt" pyinstaller >/dev/null

"$VENV_DIR/bin/pyinstaller" \
  --noconfirm \
  --clean \
  --onefile \
  --strip \
  --name "$GATEWAY_NAME" \
  --paths "$ROOT" \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_ROOT/work-gateway" \
  --specpath "$BUILD_ROOT/spec-gateway" \
  "$ROOT/desktop_client/socks_gateway.py"

echo "Built Linux sidecars in $DIST_DIR"

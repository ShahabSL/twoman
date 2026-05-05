#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$ROOT/desktop_client/build/linux"
VENV_DIR="$BUILD_ROOT/venv"
DIST_DIR="$ROOT/desktop_client/dist/linux"
GO_HELPER_BIN="$DIST_DIR/twoman-helper-agent"

rm -rf "$BUILD_ROOT" "$DIST_DIR"
mkdir -p "$BUILD_ROOT" "$DIST_DIR"

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip wheel >/dev/null
"$VENV_DIR/bin/pip" install \
  -r "$ROOT/requirements.txt" \
  -r "$ROOT/desktop_client/requirements.txt" \
  pyinstaller >/dev/null

(cd "$ROOT/helper-agent" && go build -trimpath -ldflags "-s -w" -o "$GO_HELPER_BIN" .)

"$VENV_DIR/bin/pyinstaller" \
  --noconfirm \
  --clean \
  --onefile \
  --strip \
  --name twoman-desktop \
  --paths "$ROOT" \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_ROOT/work" \
  --specpath "$BUILD_ROOT/spec" \
  "$ROOT/desktop_client/__main__.py"

echo "Built $DIST_DIR/twoman-desktop and $GO_HELPER_BIN"

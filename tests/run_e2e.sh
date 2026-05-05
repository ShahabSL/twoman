#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/tests/run_e2e_go_node_http.sh"

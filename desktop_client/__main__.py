from __future__ import annotations

import argparse
import subprocess
from pathlib import Path
from typing import Sequence

from desktop_client.runtime import _helper_command
from desktop_client.socks_gateway import run_gateway_from_config


def _run_helper(config_path: str) -> int:
    command, cwd = _helper_command(Path(config_path))
    return subprocess.call(command, cwd=str(cwd))


def _run_tui() -> int:
    from desktop_client.tui import DesktopClientApp

    app = DesktopClientApp()
    app.run()
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Twoman desktop client")
    subparsers = parser.add_subparsers(dest="command")

    helper_run = subparsers.add_parser("helper-run", help="Run the embedded helper subprocess")
    helper_run.add_argument("--config", required=True)

    gateway_run = subparsers.add_parser("gateway-run", help="Run an authenticated SOCKS gateway subprocess")
    gateway_run.add_argument("--config", required=True)

    args = parser.parse_args(list(argv) if argv is not None else None)
    if args.command == "helper-run":
        return _run_helper(args.config)
    if args.command == "gateway-run":
        run_gateway_from_config(args.config)
        return 0
    return _run_tui()


if __name__ == "__main__":
    raise SystemExit(main())

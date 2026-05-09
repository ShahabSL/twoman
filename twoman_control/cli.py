from __future__ import annotations

import argparse
import os
from pathlib import Path

from twoman_control.installer import install, purge_installation
from twoman_control.registry import load_registry, resolve_instance_name, set_default_instance


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="twoman-server")
    parser.add_argument("--instance", dest="global_instance", default="", help="managed instance name")
    parser.add_argument("--version", action="store_true", help="print version and exit")
    subparsers = parser.add_subparsers(dest="command")

    install_parser = subparsers.add_parser("install", help="Run the Twoman deployment wizard")
    install_parser.add_argument("--instance", default="")
    install_parser.add_argument("--repo-root", type=Path)
    install_parser.add_argument("--control-root", type=Path, default=Path("/opt/twoman/control"))
    install_parser.add_argument("--install-root", type=Path, default=None)
    install_parser.add_argument("--public-origin", default="")
    install_parser.add_argument("--cpanel-base-url", default="")
    install_parser.add_argument("--cpanel-username", default="")
    install_parser.add_argument("--cpanel-password", default="")
    install_parser.add_argument("--cpanel-home", default="")
    install_parser.add_argument("--cpanel-proxy-url", default="")
    install_parser.add_argument("--public-proxy-url", default="")
    install_parser.add_argument("--server-host", default="")
    install_parser.add_argument("--server-port", type=int, default=22)
    install_parser.add_argument("--server-user", default="")
    install_parser.add_argument("--server-password", default="")
    install_parser.add_argument("--server-ssh-key", default="")
    install_parser.add_argument("--site-name", default="")
    install_parser.add_argument("--backend", default="")
    install_parser.add_argument("--public-base-path", default="")
    install_parser.add_argument("--bridge-public-base-path", default="")
    install_parser.add_argument("--passenger-app-name", default="")
    install_parser.add_argument("--passenger-app-root", default="")
    install_parser.add_argument("--node-app-root", default="")
    install_parser.add_argument("--node-app-uri", default="")
    install_parser.add_argument("--admin-script-name", default="")
    install_parser.add_argument("--hidden-service-name", default="")
    install_parser.add_argument("--hidden-service-user", default="")
    install_parser.add_argument("--hidden-service-group", default="")
    install_parser.add_argument("--watchdog-service-name", default="")
    install_parser.add_argument("--watchdog-timer-name", default="")
    install_parser.add_argument("--hidden-upstream-proxy-url", default="")
    install_parser.add_argument("--hidden-upstream-proxy-label", default="")
    install_parser.add_argument("--hidden-outbound-proxy-url", default="")
    install_parser.add_argument("--hidden-outbound-proxy-label", default="")
    install_parser.add_argument("--non-interactive", action="store_true")
    install_parser.add_argument("--customize", action="store_true")
    install_parser.add_argument("--skip-helper-probe", action="store_true")
    tls_group = install_parser.add_mutually_exclusive_group()
    tls_group.add_argument("--verify-tls", dest="verify_tls", action="store_true")
    tls_group.add_argument("--no-verify-tls", dest="verify_tls", action="store_false")
    install_parser.set_defaults(verify_tls=None)

    for name, aliases, help_text in [
        ("verify", ["status"], "Run a non-interactive health check"),
        ("logs", [], "Print the hidden-agent journal tail"),
        ("show-config", ["config"], "Print the Twoman client import text"),
        ("restart-agent", ["restart"], "Restart the hidden-agent service"),
        ("restart-upstream-proxy", [], "Restart the managed hidden-server route proxy"),
        ("run-watchdog", [], "Run the watchdog service immediately"),
        ("redeploy-host", [], "Redeploy the public host backend with the saved state"),
    ]:
        action_parser = subparsers.add_parser(name, aliases=aliases, help=help_text)
        action_parser.add_argument("--instance", default="")
    purge_parser = subparsers.add_parser("purge", help="Purge an installed Twoman instance")
    purge_parser.add_argument("--instance", default="")
    purge_parser.add_argument("--host-only", action="store_true")
    purge_parser.add_argument("--hidden-only", action="store_true")
    purge_parser.add_argument("--keep-state", action="store_true")
    list_parser = subparsers.add_parser("list", help="List installed Twoman instances")
    list_parser.add_argument("--instance", default="")
    default_parser = subparsers.add_parser("set-default", help="Set the default Twoman instance")
    default_parser.add_argument("instance_name")
    subparsers.add_parser("version", help="Print the Twoman server-control version")
    return parser


def _product_version() -> str:
    env_version = os.environ.get("TWOMAN_PRODUCT_VERSION", "").strip()
    if env_version:
        return env_version
    version_file = Path(__file__).resolve().parents[1] / "VERSION"
    try:
        return version_file.read_text(encoding="utf-8").strip() or "dev"
    except OSError:
        return "dev"


def _control_root() -> Path:
    return Path(os.environ.get("TWOMAN_CONTROL_ROOT", "/opt/twoman/control"))


def _selected_instance(args: argparse.Namespace) -> str:
    return str(getattr(args, "instance", "") or getattr(args, "global_instance", "")).strip()


def _run_action(controller: ManagerController, command: str) -> int:
    command = {
        "status": "verify",
        "config": "show-config",
        "restart": "restart-agent",
    }.get(command, command)
    if command == "verify":
        result = controller.verify()
    elif command == "logs":
        print(controller.journal_tail())
        return 0
    elif command == "show-config":
        print(controller.state.profile_share_text)
        return 0
    elif command == "restart-agent":
        result = controller.restart_agent()
    elif command == "restart-upstream-proxy":
        result = controller.restart_upstream_proxy()
    elif command == "run-watchdog":
        result = controller.restart_watchdog()
    elif command == "redeploy-host":
        result = controller.redeploy_host()
    else:
        raise ValueError(f"unknown command: {command}")
    print(result.details or result.summary)
    return 0 if result.ok else 1


def _run_list(control_root: Path) -> int:
    registry = load_registry(control_root)
    if not registry.instances:
        print("No Twoman instances are installed.")
        return 0
    for instance in registry.instances:
        marker = "*" if instance.name == registry.default_instance else " "
        print(
            f"{marker} {instance.name}\t{instance.backend}\t{instance.broker_base_url}\t"
            f"{instance.hidden_service_name}\t{instance.hidden_install_root}"
        )
    return 0


def _run_overview(control_root: Path, instance_name: str) -> int:
    from twoman_control.manager import ManagerController

    registry = load_registry(control_root)
    if not registry.instances:
        print("Twoman server control")
        print("No managed instances are installed.")
        print("")
        print("Start here:")
        print("  sudo twoman-server install")
        print("")
        print("Other commands:")
        print("  twoman-server --help")
        return 0

    controller = ManagerController(control_root, instance_name or None)
    state = controller.state
    default_marker = "default" if state.instance_name == registry.default_instance else f"default={registry.default_instance}"
    print("Twoman server control")
    print(f"Instance:       {state.instance_name} ({default_marker})")
    print(f"Backend:        {state.backend}")
    print(f"Broker:         {state.broker_base_url}")
    print(f"Hidden service: {state.hidden_service_name}")
    print(f"Hidden route:   {controller.hidden_route_text()}")
    print(f"Outbound route: {controller.outbound_route_text()}")
    print("")
    print("Common commands:")
    print("  twoman-server status       Run health checks")
    print("  twoman-server logs         Show hidden-agent logs")
    print("  twoman-server config       Print client import text")
    print("  twoman-server list         List managed instances")
    print("")
    print("Use --instance <name> before the command to target another instance.")
    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.version:
        print(f"twoman-server {_product_version()}")
        return 0
    command = args.command or "overview"
    if command == "version":
        print(f"twoman-server {_product_version()}")
        return 0
    if command == "install":
        install(args)
        return 0
    if command == "purge":
        purge_host = not bool(args.hidden_only)
        purge_hidden = not bool(args.host_only)
        if not purge_host and not purge_hidden:
            raise SystemExit("purge requires at least one of host or hidden removal")
        state = purge_installation(
            _control_root(),
            _selected_instance(args) or None,
            purge_host=purge_host,
            purge_hidden=purge_hidden,
            remove_state_files=not bool(args.keep_state),
        )
        print(
            f"purged instance {state.instance_name}: "
            f"{'host ' if purge_host else ''}{'hidden ' if purge_hidden else ''}".strip()
        )
        return 0
    from twoman_control.manager import ManagerController

    control_root = _control_root()
    instance_name = _selected_instance(args)
    if command == "list":
        return _run_list(control_root)
    if command == "set-default":
        set_default_instance(control_root, args.instance_name)
        print(f"default instance set to {resolve_instance_name(control_root, args.instance_name)}")
        return 0
    if command == "overview":
        return _run_overview(control_root, instance_name)
    controller = ManagerController(control_root, instance_name or None)
    return _run_action(controller, command)


if __name__ == "__main__":
    raise SystemExit(main())

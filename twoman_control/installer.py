from __future__ import annotations

import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from getpass import getpass
from pathlib import Path
from typing import Iterable

from twoman_http import httpx_request
from twoman_control.cpanel import CpanelClient
from twoman_control.defaults import build_generated_defaults, build_profile_share_text
from twoman_control.models import (
    BACKEND_BRIDGE,
    BACKEND_NODE,
    BACKEND_PASSENGER,
    BackendCapability,
    InstallState,
)
from twoman_control.registry import (
    DEFAULT_INSTANCE_NAME,
    legacy_state_path,
    load_instance_state,
    remove_instance,
    normalize_instance_name,
    profile_share_path,
    save_instance_state,
    state_path,
)

DEFAULT_BRIDGE_PUBLIC_BASE_PATH = ""
SERVER_LAUNCHER_PATH = Path(
    os.environ.get(
        "TWOMAN_SERVER_LAUNCHER_PATH",
        os.environ.get("TWOMAN_LAUNCHER_PATH", "/usr/local/bin/twoman-server"),
    )
)


@dataclass(slots=True)
class InstallArgs:
    repo_root: Path
    control_root: Path
    instance_name: str
    install_root: Path
    public_origin: str
    cpanel_base_url: str
    cpanel_username: str
    cpanel_password: str
    cpanel_home: str
    cpanel_proxy_url: str
    public_proxy_url: str
    hidden_server_host: str
    hidden_server_port: int
    hidden_server_user: str
    hidden_server_password: str
    hidden_server_ssh_key: str
    site_name: str
    backend: str
    non_interactive: bool
    customize: bool
    public_base_path: str
    bridge_public_base_path: str
    passenger_app_name: str
    passenger_app_root: str
    node_app_root: str
    node_app_uri: str
    admin_script_name: str
    hidden_service_name: str
    hidden_service_user: str
    hidden_service_group: str
    watchdog_service_name: str
    watchdog_timer_name: str
    hidden_upstream_proxy_url: str
    hidden_upstream_proxy_label: str
    hidden_outbound_proxy_url: str
    hidden_outbound_proxy_label: str
    verify_tls: bool | None
    skip_helper_probe: bool

def _prompt_text(label: str, default: str = "", *, secret: bool = False, allow_blank: bool = False) -> str:
    while True:
        prompt = f"{label}"
        if default:
            prompt += f" [{default}]"
        prompt += ": "
        value = getpass(prompt) if secret else input(prompt)
        if value.strip():
            return value.strip()
        if default:
            return default
        if allow_blank:
            return ""
        print("Value required.")


def _prompt_bool(label: str, default: bool) -> bool:
    suffix = "Y/n" if default else "y/N"
    while True:
        value = input(f"{label} [{suffix}]: ").strip().lower()
        if not value:
            return default
        if value in {"y", "yes"}:
            return True
        if value in {"n", "no"}:
            return False
        print("Enter y or n.")


def _prompt_choice(label: str, options: list[tuple[str, str]], default_key: str) -> str:
    print(label)
    for index, (_, description) in enumerate(options, start=1):
        print(f"  {index}. {description}")
    default_index = 1
    for index, (key, _) in enumerate(options, start=1):
        if key == default_key:
            default_index = index
            break
    while True:
        value = input(f"Choose an option [{default_index}]: ").strip()
        if not value:
            return options[default_index - 1][0]
        if value.isdigit():
            numeric = int(value)
            if 1 <= numeric <= len(options):
                return options[numeric - 1][0]
        print("Choose one of the listed numbers.")


def _copy_selected_paths(source_root: Path, bundle_root: Path) -> None:
    if source_root.resolve() == bundle_root.resolve():
        return
    if bundle_root.exists():
        shutil.rmtree(bundle_root)
    bundle_root.mkdir(parents=True, exist_ok=True)
    ignore = shutil.ignore_patterns(
        "__pycache__",
        "*.pyc",
        ".pytest_cache",
        ".mypy_cache",
        "node_modules",
        "target",
        "build",
        "dist",
        ".git",
        "private_handoff",
        "output",
    )
    for relative in [
        "scripts",
        "host",
        "helper-agent",
        "hidden_server",
        "twoman_control",
    ]:
        shutil.copytree(source_root / relative, bundle_root / relative, ignore=ignore)
    for filename in [
        "VERSION",
        "requirements.txt",
        "runtime_diagnostics.py",
        "twoman_crypto.py",
        "twoman_dns.py",
        "twoman_http.py",
        "twoman_proxy.py",
        "twoman_protocol.py",
    ]:
        shutil.copy2(source_root / filename, bundle_root / filename)


def _create_control_venv(control_root: Path, bundle_root: Path) -> None:
    builder_python = _venv_builder_python()
    with tempfile.TemporaryDirectory(prefix="twoman-control-venv-") as temp_dir:
        probe_root = Path(temp_dir) / "probe"
        if subprocess.run([builder_python, "-m", "venv", str(probe_root)], capture_output=True, text=True, check=False).returncode != 0:
            if os.geteuid() != 0 or shutil.which("apt-get") is None:
                raise RuntimeError("python3-venv is required to build the Twoman control environment")
            subprocess.run(["apt-get", "update"], check=True)
            subprocess.run(["apt-get", "install", "-y", "python3-venv"], check=True)
    venv_root = control_root / ".venv"
    if not venv_root.exists():
        subprocess.run([builder_python, "-m", "venv", str(venv_root)], check=True)
    python_bin = venv_root / "bin" / "python"
    subprocess.run([str(python_bin), "-m", "pip", "install", "--upgrade", "pip", "wheel"], check=True)
    subprocess.run([str(python_bin), "-m", "pip", "install", "-r", str(bundle_root / "requirements.txt")], check=True)

def _install_launcher(control_root: Path) -> None:
    launcher_path = SERVER_LAUNCHER_PATH
    launcher_path.parent.mkdir(parents=True, exist_ok=True)
    control_root_quoted = shlex.quote(str(control_root))
    bundle_root_quoted = shlex.quote(str(control_root / "bundle"))
    launcher_path_quoted = shlex.quote(str(launcher_path))
    python_bin_quoted = shlex.quote(str(control_root / ".venv" / "bin" / "python"))
    launcher = f"""#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E "$0" "$@"
fi
export TWOMAN_CONTROL_ROOT={control_root_quoted}
export TWOMAN_SERVER_LAUNCHER_PATH={launcher_path_quoted}
export PYTHONPATH={bundle_root_quoted}:${{PYTHONPATH:-}}
exec {python_bin_quoted} -m twoman_control.cli "$@"
"""
    launcher_path.write_text(launcher, encoding="utf-8")
    launcher_path.chmod(0o755)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _local_tcp_port_open(host: str, port: int, *, timeout: float = 0.25) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect((host, port))
        except OSError:
            return False
    return True


def _proxy_label_for_url(proxy_url: str) -> str:
    normalized = str(proxy_url or "").strip().lower().replace("socks5h://", "socks5://")
    if not normalized:
        return ""
    if normalized == "socks5://127.0.0.1:1280":
        return "wireproxy"
    return "custom"


def _proxy_display_name(proxy_label: str, proxy_url: str) -> str:
    if not proxy_url:
        return "direct"
    if proxy_label == "wireproxy":
        return f"WARP WireProxy via {proxy_url}"
    return f"custom upstream proxy via {proxy_url}"


def _normalize_proxy_url(proxy_url: str) -> str:
    normalized = str(proxy_url or "").strip()
    if not normalized:
        return ""
    lowered = normalized.lower()
    if lowered == "socks5://127.0.0.1:1280":
        return "socks5h://127.0.0.1:1280"
    if lowered == "socks5://localhost:1280":
        return "socks5h://localhost:1280"
    return normalized


def _normalize_base_path(value: str) -> str:
    parts = [part for part in str(value or "").strip().split("/") if part]
    if not parts:
        return "/"
    return "/" + "/".join(parts)


def _normalize_optional_base_path(value: str) -> str:
    text = str(value or "").strip()
    if text == "":
        return ""
    return _normalize_base_path(text)


def _profile_label(site_name: str, backend: str, instance_name: str) -> str:
    backend_label = {
        BACKEND_NODE: "Node",
        BACKEND_BRIDGE: "Bridge",
        BACKEND_PASSENGER: "Passenger",
    }.get(backend, instance_name.title())
    if instance_name == DEFAULT_INSTANCE_NAME:
        return f"{site_name} Host"
    return f"{site_name} {backend_label}"


def _venv_builder_python() -> str:
    return str(Path(getattr(sys, "_base_executable", sys.executable)).resolve())


def _run_script(script_path: Path, env: dict[str, str], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    merged_env.update(env)
    return subprocess.run(
        ["bash", str(script_path)],
        cwd=cwd,
        env=merged_env,
        text=True,
        capture_output=True,
        check=False,
    )


def _load_existing_state(control_root: Path, instance_name: str) -> InstallState | None:
    try:
        return load_instance_state(control_root, instance_name)
    except Exception:
        return None


def build_broker_base_url(
    public_origin: str,
    backend: str,
    public_base_path: str,
    *,
    bridge_public_base_path: str = DEFAULT_BRIDGE_PUBLIC_BASE_PATH,
) -> str:
    origin = public_origin.rstrip("/")
    public_path = "/" + public_base_path.strip().lstrip("/")
    if backend != BACKEND_BRIDGE:
        return f"{origin}{public_path}"
    bridge_path = str(bridge_public_base_path or "").strip()
    if not bridge_path or bridge_path == "/":
        return f"{origin}{public_path}"
    bridge_path = "/" + bridge_path.lstrip("/")
    return f"{origin}{public_path.rstrip('/')}{bridge_path}"


def _helper_probe(
    bundle_root: Path,
    broker_base_url: str,
    client_token: str,
    verify_tls: bool,
    http2_ctl: bool,
    http2_data: bool,
    upstream_proxy_url: str,
) -> None:
    http_port = _free_port()
    socks_port = _free_port()
    with tempfile.TemporaryDirectory(prefix="twoman-install-probe-") as temp_dir:
        temp_path = Path(temp_dir)
        config_path = temp_path / "helper.json"
        listen_state_path = temp_path / "listen-state.json"
        log_path = temp_path / "helper.log"
        go_helper = temp_path / "twoman-helper-agent"
        config = {
            "transport": "http",
            "broker_base_url": broker_base_url,
            "upstream_proxy_url": upstream_proxy_url,
            "client_token": client_token,
            "listen_host": "127.0.0.1",
            "http_listen_port": http_port,
            "socks_listen_port": socks_port,
            "listen_state_path": str(listen_state_path),
            "log_path": str(log_path),
            "http_timeout_seconds": 30,
            "verify_tls": verify_tls,
            "streaming_up_lanes": [],
            "idle_repoll_delay_seconds": {"ctl": 0.05, "data": 0.1},
            "http2_enabled": {"ctl": http2_ctl, "data": http2_data},
        }
        config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
        if not shutil.which("go"):
            raise RuntimeError("go is required to probe the Twoman Go helper runtime")
        build = subprocess.run(
            ["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", str(go_helper), "."],
            cwd=bundle_root / "helper-agent",
            text=True,
            capture_output=True,
            check=False,
        )
        if build.returncode != 0:
            raise RuntimeError(f"failed to build Go helper probe: {build.stderr.strip()}")
        helper_command = [str(go_helper), "--config", str(config_path), "--mode", "helper"]
        process = subprocess.Popen(
            helper_command,
            cwd=bundle_root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.time() + 45.0
            while time.time() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("temporary helper exited before opening listeners")
                if listen_state_path.exists():
                    break
                time.sleep(0.25)
            if not listen_state_path.exists():
                raise RuntimeError("temporary helper did not publish listener state")
            last_error = "helper probe never ran"
            for _ in range(6):
                probe = subprocess.run(
                    [
                        "curl",
                        "-sS",
                        "--connect-timeout",
                        "10",
                        "-m",
                        "20",
                        "-x",
                        f"http://127.0.0.1:{http_port}",
                        "-o",
                        "/dev/null",
                        "-w",
                        "%{http_code}",
                        "https://www.google.com/generate_204",
                    ],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                status_code = probe.stdout.strip()
                if status_code in {"200", "204", "301", "302"}:
                    return
                last_error = status_code or probe.stderr.strip() or "unknown helper probe failure"
                time.sleep(2.0)
            helper_log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
            helper_tail = "\n".join(helper_log.strip().splitlines()[-20:]).strip()
            detail = last_error
            if helper_tail:
                detail = f"{detail}\nHelper log tail:\n{helper_tail}"
            raise RuntimeError(f"helper probe failed\n{detail}")
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def _deploy_host(bundle_root: Path, state: InstallState) -> None:
    if state.backend == BACKEND_PASSENGER:
        env = {
            "TWOMAN_CPANEL_BASE_URL": state.cpanel_base_url,
            "TWOMAN_CPANEL_USERNAME": state.cpanel_username,
            "TWOMAN_CPANEL_PASSWORD": state.cpanel_password,
            "TWOMAN_CPANEL_HOME": state.cpanel_home,
            "TWOMAN_PUBLIC_ORIGIN": state.public_origin,
            "TWOMAN_PUBLIC_BASE_PATH": state.public_base_path,
            "TWOMAN_APP_NAME": state.passenger_app_name,
            "TWOMAN_APP_ROOT": state.passenger_app_root,
            "TWOMAN_CLIENT_TOKEN": state.client_token,
            "TWOMAN_AGENT_TOKEN": state.agent_token,
            "TWOMAN_CAMOUFLAGE_SITE_ENABLED": "true",
            "TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID": state.deployment_id,
            "TWOMAN_CAMOUFLAGE_SITE_NAME": state.site_name,
            "TWOMAN_CPANEL_PROXY_URL": state.cpanel_proxy_url,
            "TWOMAN_PUBLIC_PROXY_URL": state.public_proxy_url,
        }
        script = bundle_root / "scripts" / "deploy_host_passenger.sh"
    elif state.backend == BACKEND_NODE:
        public_host = state.public_origin.replace("https://", "").replace("http://", "").strip("/")
        env = {
            "TWOMAN_CPANEL_BASE_URL": state.cpanel_base_url,
            "TWOMAN_CPANEL_USERNAME": state.cpanel_username,
            "TWOMAN_CPANEL_PASSWORD": state.cpanel_password,
            "TWOMAN_CPANEL_HOME": state.cpanel_home,
            "TWOMAN_PUBLIC_HOST": public_host,
            "TWOMAN_NODE_APP_ROOT": state.node_app_root,
            "TWOMAN_NODE_APP_URI": state.node_app_uri,
            "TWOMAN_ADMIN_SCRIPT_NAME": state.admin_script_name,
            "TWOMAN_CLIENT_TOKEN": state.client_token,
            "TWOMAN_AGENT_TOKEN": state.agent_token,
            "TWOMAN_CAMOUFLAGE_SITE_ENABLED": "true",
            "TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID": state.deployment_id,
            "TWOMAN_CAMOUFLAGE_SITE_NAME": state.site_name,
            "TWOMAN_CPANEL_PROXY_URL": state.cpanel_proxy_url,
            "TWOMAN_PUBLIC_PROXY_URL": state.public_proxy_url,
        }
        script = bundle_root / "scripts" / "deploy_host_node_selector.sh"
    else:
        env = {
            "TWOMAN_CPANEL_BASE_URL": state.cpanel_base_url,
            "TWOMAN_CPANEL_USERNAME": state.cpanel_username,
            "TWOMAN_CPANEL_PASSWORD": state.cpanel_password,
            "TWOMAN_CPANEL_HOME": state.cpanel_home,
            "TWOMAN_PUBLIC_ORIGIN": state.public_origin,
            "TWOMAN_PUBLIC_BASE_PATH": state.public_base_path,
            "TWOMAN_BRIDGE_PUBLIC_BASE_PATH": state.bridge_public_base_path,
            "TWOMAN_CLIENT_TOKEN": state.client_token,
            "TWOMAN_AGENT_TOKEN": state.agent_token,
            "TWOMAN_CPANEL_PROXY_URL": state.cpanel_proxy_url,
            "TWOMAN_PUBLIC_PROXY_URL": state.public_proxy_url,
            "TWOMAN_CAMOUFLAGE_SITE_ENABLED": "true",
            "TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID": state.deployment_id,
            "TWOMAN_CAMOUFLAGE_SITE_NAME": state.site_name,
        }
        script = bundle_root / "scripts" / "deploy_host.sh"
    result = _run_script(script, env, cwd=bundle_root)
    if result.returncode != 0:
        raise RuntimeError(f"host deploy failed\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}")


def _install_local_hidden_server(bundle_root: Path, state: InstallState) -> None:
    env = {
        "TWOMAN_REPO_ROOT": str(bundle_root),
        "TWOMAN_INSTALL_ROOT": state.hidden_install_root,
        "TWOMAN_BROKER_BASE_URL": state.broker_base_url,
        "TWOMAN_AGENT_TOKEN": state.agent_token,
        "TWOMAN_AGENT_PEER_ID": state.agent_peer_id,
        "TWOMAN_AGENT_SERVICE_NAME": state.hidden_service_name,
        "TWOMAN_AGENT_SERVICE_USER": state.hidden_service_user,
        "TWOMAN_AGENT_SERVICE_GROUP": state.hidden_service_group,
        "TWOMAN_WATCHDOG_SERVICE_NAME": state.watchdog_service_name,
        "TWOMAN_WATCHDOG_TIMER_NAME": state.watchdog_timer_name,
        "TWOMAN_VERIFY_TLS": "true" if state.verify_tls else "false",
        "TWOMAN_HTTP2_CTL": "false",
        "TWOMAN_HTTP2_DATA": "false",
        "TWOMAN_DISABLE_IPV6_ORIGIN": "true",
        "TWOMAN_PREFER_IPV4": "true",
        "TWOMAN_UPSTREAM_PROXY_URL": state.hidden_upstream_proxy_url,
        "TWOMAN_UPSTREAM_PROXY_LABEL": state.hidden_upstream_proxy_label,
        "TWOMAN_OUTBOUND_PROXY_URL": state.hidden_outbound_proxy_url,
        "TWOMAN_OUTBOUND_PROXY_LABEL": state.hidden_outbound_proxy_label,
    }
    result = _run_script(bundle_root / "scripts" / "install_hidden_server_local.sh", env, cwd=bundle_root)
    if result.returncode != 0:
        raise RuntimeError(
            f"local hidden-server install failed\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )


def _install_remote_hidden_server(bundle_root: Path, state: InstallState) -> None:
    env = {
        "TWOMAN_SERVER_HOST": state.hidden_server_host,
        "TWOMAN_SERVER_PORT": str(state.hidden_server_port),
        "TWOMAN_SERVER_USER": state.hidden_server_user,
        "TWOMAN_SERVER_PASSWORD": state.hidden_server_password,
        "TWOMAN_SERVER_SSH_KEY": state.hidden_server_ssh_key,
        "TWOMAN_SERVER_DIR": state.hidden_install_root,
        "TWOMAN_BROKER_BASE_URL": state.broker_base_url,
        "TWOMAN_AGENT_TOKEN": state.agent_token,
        "TWOMAN_AGENT_PEER_ID": state.agent_peer_id,
        "TWOMAN_AGENT_SERVICE_NAME": state.hidden_service_name,
        "TWOMAN_AGENT_SERVICE_USER": state.hidden_service_user,
        "TWOMAN_AGENT_SERVICE_GROUP": state.hidden_service_group,
        "TWOMAN_WATCHDOG_SERVICE_NAME": state.watchdog_service_name,
        "TWOMAN_WATCHDOG_TIMER_NAME": state.watchdog_timer_name,
        "TWOMAN_VERIFY_TLS": "true" if state.verify_tls else "false",
        "TWOMAN_HTTP2_CTL": "false",
        "TWOMAN_HTTP2_DATA": "false",
        "TWOMAN_DISABLE_IPV6_ORIGIN": "true",
        "TWOMAN_PREFER_IPV4": "true",
        "TWOMAN_UPSTREAM_PROXY_URL": state.hidden_upstream_proxy_url,
        "TWOMAN_UPSTREAM_PROXY_LABEL": state.hidden_upstream_proxy_label,
        "TWOMAN_OUTBOUND_PROXY_URL": state.hidden_outbound_proxy_url,
        "TWOMAN_OUTBOUND_PROXY_LABEL": state.hidden_outbound_proxy_label,
    }
    result = _run_script(bundle_root / "scripts" / "deploy_hidden_server.sh", env, cwd=bundle_root)
    if result.returncode != 0:
        raise RuntimeError(
            f"remote hidden-server install failed\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )


def _install_hidden_server(bundle_root: Path, state: InstallState) -> None:
    if state.hidden_server_host:
        _install_remote_hidden_server(bundle_root, state)
        return
    _install_local_hidden_server(bundle_root, state)


def _purge_local_hidden_server(bundle_root: Path, state: InstallState) -> None:
    env = {
        "TWOMAN_INSTALL_ROOT": state.hidden_install_root,
        "TWOMAN_AGENT_SERVICE_NAME": state.hidden_service_name,
        "TWOMAN_WATCHDOG_SERVICE_NAME": state.watchdog_service_name,
        "TWOMAN_WATCHDOG_TIMER_NAME": state.watchdog_timer_name,
    }
    result = _run_script(bundle_root / "scripts" / "purge_hidden_server_local.sh", env, cwd=bundle_root)
    if result.returncode != 0:
        raise RuntimeError(
            f"local hidden-server purge failed\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )


def _purge_remote_hidden_server(bundle_root: Path, state: InstallState) -> None:
    env = {
        "TWOMAN_SERVER_HOST": state.hidden_server_host,
        "TWOMAN_SERVER_PORT": str(state.hidden_server_port),
        "TWOMAN_SERVER_USER": state.hidden_server_user,
        "TWOMAN_SERVER_PASSWORD": state.hidden_server_password,
        "TWOMAN_SERVER_SSH_KEY": state.hidden_server_ssh_key,
        "TWOMAN_INSTALL_ROOT": state.hidden_install_root,
        "TWOMAN_AGENT_SERVICE_NAME": state.hidden_service_name,
        "TWOMAN_WATCHDOG_SERVICE_NAME": state.watchdog_service_name,
        "TWOMAN_WATCHDOG_TIMER_NAME": state.watchdog_timer_name,
    }
    result = _run_script(bundle_root / "scripts" / "purge_hidden_server.sh", env, cwd=bundle_root)
    if result.returncode != 0:
        raise RuntimeError(
            f"remote hidden-server purge failed\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )


def _purge_hidden_server(bundle_root: Path, state: InstallState) -> None:
    if state.hidden_server_host:
        _purge_remote_hidden_server(bundle_root, state)
        return
    _purge_local_hidden_server(bundle_root, state)


def _purge_host(bundle_root: Path, state: InstallState) -> None:
    if state.backend == BACKEND_NODE:
        env = {
            "TWOMAN_CPANEL_BASE_URL": state.cpanel_base_url,
            "TWOMAN_CPANEL_USERNAME": state.cpanel_username,
            "TWOMAN_CPANEL_PASSWORD": state.cpanel_password,
            "TWOMAN_CPANEL_HOME": state.cpanel_home,
            "TWOMAN_PUBLIC_HOST": state.public_origin.replace("https://", "").replace("http://", "").strip("/"),
            "TWOMAN_NODE_APP_ROOT": state.node_app_root,
            "TWOMAN_ADMIN_SCRIPT_NAME": state.admin_script_name,
            "TWOMAN_CPANEL_PROXY_URL": state.cpanel_proxy_url,
            "TWOMAN_PUBLIC_PROXY_URL": state.public_proxy_url,
        }
        script = bundle_root / "scripts" / "purge_host_node_selector.sh"
    elif state.backend == BACKEND_BRIDGE:
        env = {
            "TWOMAN_CPANEL_BASE_URL": state.cpanel_base_url,
            "TWOMAN_CPANEL_USERNAME": state.cpanel_username,
            "TWOMAN_CPANEL_PASSWORD": state.cpanel_password,
            "TWOMAN_CPANEL_HOME": state.cpanel_home,
            "TWOMAN_PUBLIC_BASE_PATH": state.public_base_path,
            "TWOMAN_CPANEL_PROXY_URL": state.cpanel_proxy_url,
            "TWOMAN_PUBLIC_PROXY_URL": state.public_proxy_url,
        }
        script = bundle_root / "scripts" / "purge_host_bridge.sh"
    else:
        raise RuntimeError(f"purge is not implemented for backend {state.backend}")
    result = _run_script(script, env, cwd=bundle_root)
    if result.returncode != 0:
        raise RuntimeError(f"host purge failed\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}")


def purge_installation(
    control_root: Path,
    instance_name: str | None,
    *,
    purge_host: bool = True,
    purge_hidden: bool = True,
    remove_state_files: bool = True,
) -> InstallState:
    state = load_instance_state(control_root, instance_name)
    bundle_root = Path(state.bundle_root)
    if purge_host:
        _purge_host(bundle_root, state)
    if purge_hidden:
        _purge_hidden_server(bundle_root, state)
    if remove_state_files:
        remove_instance(control_root, state.instance_name)
    return state


def _verify_final_health(state: InstallState) -> None:
    deadline = time.time() + 60.0
    last_payload: dict[str, object] | None = None
    while time.time() < deadline:
        response = httpx_request(
            "GET",
            f"{state.broker_base_url.rstrip('/')}/health",
            headers={"Authorization": f"Bearer {state.client_token}"},
            timeout=20.0,
            verify=state.verify_tls,
            proxy_url=state.public_proxy_url or None,
            follow_redirects=True,
        )
        response.raise_for_status()
        payload = response.json()
        last_payload = payload
        peers = int(payload.get("stats", {}).get("peers", 0) or 0)
        if payload.get("ok") and peers >= 1:
            return
        time.sleep(2.0)
    raise RuntimeError(f"broker health failed to reach a live peer: {last_payload}")


def _print_capabilities(capabilities: Iterable[BackendCapability]) -> None:
    print("\nDetected host backends:")
    for capability in capabilities:
        marker = "recommended" if capability.recommended else "available" if capability.available else "unavailable"
        print(f"  - {capability.label}: {marker}")
        if capability.reason:
            print(f"    {capability.reason}")


def _infer_repo_root(args_repo_root: Path | None) -> Path:
    if args_repo_root is not None:
        return args_repo_root
    control_root_env = os.environ.get("TWOMAN_CONTROL_ROOT", "").strip()
    if control_root_env:
        return Path(control_root_env) / "bundle"
    return Path(__file__).resolve().parents[1]


def collect_install_args(namespace: object) -> InstallArgs:
    repo_root = _infer_repo_root(getattr(namespace, "repo_root", None))
    default_control_root = Path(getattr(namespace, "control_root", "") or "/opt/twoman/control")
    instance_name = normalize_instance_name(getattr(namespace, "instance", "") or DEFAULT_INSTANCE_NAME)
    existing_state = _load_existing_state(default_control_root, instance_name)
    explicit_install_root = str(getattr(namespace, "install_root", "") or "").strip()
    if explicit_install_root:
        default_install_root = Path(explicit_install_root)
    elif existing_state is not None and existing_state.hidden_install_root:
        default_install_root = Path(existing_state.hidden_install_root)
    elif instance_name != DEFAULT_INSTANCE_NAME:
        default_install_root = Path(f"/opt/twoman-{instance_name}")
    else:
        default_install_root = Path("/opt/twoman")
    non_interactive = bool(getattr(namespace, "non_interactive", False))

    public_origin = str(
        getattr(namespace, "public_origin", "") or (existing_state.public_origin if existing_state else "")
    ).strip()
    if not public_origin and not non_interactive:
        domain_default = ""
        if existing_state is not None and existing_state.public_origin:
            domain_default = existing_state.public_origin.replace("https://", "").replace("http://", "").strip("/")
        domain = _prompt_text("Public host domain", domain_default)
        public_origin = f"https://{domain}"

    cpanel_username = str(
        getattr(namespace, "cpanel_username", "") or (existing_state.cpanel_username if existing_state else "")
    ).strip()
    if not cpanel_username and not non_interactive:
        cpanel_username = _prompt_text("cPanel username")

    cpanel_base_url = str(
        getattr(namespace, "cpanel_base_url", "") or (existing_state.cpanel_base_url if existing_state else "")
    ).strip()
    if not cpanel_base_url and public_origin:
        cpanel_base_url = CpanelClient.default_cpanel_base_url(public_origin)
    if not cpanel_base_url and not non_interactive:
        cpanel_base_url = _prompt_text("cPanel API base URL", "https://example.com:2083")

    cpanel_password = str(
        getattr(namespace, "cpanel_password", "") or (existing_state.cpanel_password if existing_state else "")
    ).strip()
    if not cpanel_password and not non_interactive:
        cpanel_password = _prompt_text("cPanel password", secret=True)

    cpanel_home = str(getattr(namespace, "cpanel_home", "") or (existing_state.cpanel_home if existing_state else "")).strip()
    if not cpanel_home and cpanel_username:
        cpanel_home = f"/home/{cpanel_username}"
    if not cpanel_home and not non_interactive:
        cpanel_home = _prompt_text("cPanel home directory", "/home/cpanel-user")
    public_proxy_url = _normalize_proxy_url(
        getattr(namespace, "public_proxy_url", "") or (existing_state.public_proxy_url if existing_state else "")
    )

    hidden_server_host = str(
        getattr(namespace, "server_host", "") or (existing_state.hidden_server_host if existing_state else "")
    ).strip()
    hidden_server_port = int(
        getattr(namespace, "server_port", 0) or (existing_state.hidden_server_port if existing_state else 22) or 22
    )
    hidden_server_user = str(
        getattr(namespace, "server_user", "") or (existing_state.hidden_server_user if existing_state else "")
    ).strip()
    if hidden_server_host and not hidden_server_user:
        hidden_server_user = "root"
    hidden_server_password = str(
        getattr(namespace, "server_password", "") or (existing_state.hidden_server_password if existing_state else "")
    ).strip()
    hidden_server_ssh_key = str(
        getattr(namespace, "server_ssh_key", "") or (existing_state.hidden_server_ssh_key if existing_state else "")
    ).strip()

    site_name = str(getattr(namespace, "site_name", "") or (existing_state.site_name if existing_state else "")).strip()
    if not site_name and not non_interactive:
        site_name = _prompt_text("Optional camouflage site name", allow_blank=True)

    hidden_upstream_proxy_url = _normalize_proxy_url(
        getattr(namespace, "hidden_upstream_proxy_url", "")
        or (existing_state.hidden_upstream_proxy_url if existing_state else "")
    )
    hidden_upstream_proxy_label = str(
        getattr(namespace, "hidden_upstream_proxy_label", "")
        or (existing_state.hidden_upstream_proxy_label if existing_state else "")
    ).strip()
    detected_proxy_url = ""
    detected_proxy_label = ""
    if not hidden_upstream_proxy_url and _local_tcp_port_open("127.0.0.1", 1280):
        detected_proxy_url = "socks5h://127.0.0.1:1280"
        detected_proxy_label = "wireproxy"
    if not non_interactive:
        default_enabled = bool(hidden_upstream_proxy_url or detected_proxy_url)
        use_hidden_upstream_proxy = _prompt_bool(
            "Route hidden-server traffic through a local WARP / upstream proxy?",
            default_enabled,
        )
        if use_hidden_upstream_proxy:
            proxy_default = hidden_upstream_proxy_url or detected_proxy_url or "socks5h://127.0.0.1:1280"
            hidden_upstream_proxy_url = _normalize_proxy_url(_prompt_text(
                "Hidden upstream proxy URL",
                proxy_default,
            ))
            hidden_upstream_proxy_label = (
                hidden_upstream_proxy_label
                or detected_proxy_label
                or _proxy_label_for_url(hidden_upstream_proxy_url)
            )
        else:
            hidden_upstream_proxy_url = ""
            hidden_upstream_proxy_label = ""
    elif hidden_upstream_proxy_url and not hidden_upstream_proxy_label:
        hidden_upstream_proxy_label = _proxy_label_for_url(hidden_upstream_proxy_url)

    hidden_outbound_proxy_url = _normalize_proxy_url(
        getattr(namespace, "hidden_outbound_proxy_url", "")
        or (existing_state.hidden_outbound_proxy_url if existing_state else "")
    )
    hidden_outbound_proxy_label = str(
        getattr(namespace, "hidden_outbound_proxy_label", "")
        or (existing_state.hidden_outbound_proxy_label if existing_state else "")
    ).strip()
    if not non_interactive:
        default_enabled = bool(
            hidden_outbound_proxy_url
            or (
                hidden_upstream_proxy_label == "wireproxy"
                and (hidden_upstream_proxy_url or detected_proxy_url)
            )
        )
        use_hidden_outbound_proxy = _prompt_bool(
            "Route hidden-server outbound internet traffic through a local WARP / outbound proxy too?",
            default_enabled,
        )
        if use_hidden_outbound_proxy:
            proxy_default = (
                hidden_outbound_proxy_url
                or hidden_upstream_proxy_url
                or detected_proxy_url
                or "socks5h://127.0.0.1:1280"
            )
            hidden_outbound_proxy_url = _normalize_proxy_url(
                _prompt_text("Hidden outbound proxy URL", proxy_default)
            )
            hidden_outbound_proxy_label = (
                hidden_outbound_proxy_label
                or (
                    hidden_upstream_proxy_label
                    if hidden_upstream_proxy_url and hidden_outbound_proxy_url == hidden_upstream_proxy_url
                    else ""
                )
                or detected_proxy_label
                or _proxy_label_for_url(hidden_outbound_proxy_url)
            )
        else:
            hidden_outbound_proxy_url = ""
            hidden_outbound_proxy_label = ""
    elif hidden_outbound_proxy_url and not hidden_outbound_proxy_label:
        hidden_outbound_proxy_label = _proxy_label_for_url(hidden_outbound_proxy_url)

    backend = str(getattr(namespace, "backend", "") or (existing_state.backend if existing_state else "")).strip()
    verify_tls = getattr(namespace, "verify_tls", None)
    if verify_tls is None and existing_state is not None:
        verify_tls = existing_state.verify_tls
    bridge_public_base_path = str(
        getattr(namespace, "bridge_public_base_path", "")
        or (existing_state.bridge_public_base_path if existing_state else DEFAULT_BRIDGE_PUBLIC_BASE_PATH)
    ).strip()
    return InstallArgs(
        repo_root=repo_root,
        control_root=default_control_root,
        instance_name=instance_name,
        install_root=default_install_root,
        public_origin=public_origin,
        cpanel_base_url=cpanel_base_url,
        cpanel_username=cpanel_username,
        cpanel_password=cpanel_password,
        cpanel_home=cpanel_home,
        cpanel_proxy_url=str(
            getattr(namespace, "cpanel_proxy_url", "") or (existing_state.cpanel_proxy_url if existing_state else "")
        ).strip(),
        public_proxy_url=public_proxy_url,
        hidden_server_host=hidden_server_host,
        hidden_server_port=hidden_server_port,
        hidden_server_user=hidden_server_user,
        hidden_server_password=hidden_server_password,
        hidden_server_ssh_key=hidden_server_ssh_key,
        site_name=site_name,
        backend=backend,
        non_interactive=non_interactive,
        customize=bool(getattr(namespace, "customize", False)),
        public_base_path=str(
            getattr(namespace, "public_base_path", "") or (existing_state.public_base_path if existing_state else "")
        ).strip(),
        bridge_public_base_path=bridge_public_base_path,
        passenger_app_name=str(
            getattr(namespace, "passenger_app_name", "") or (existing_state.passenger_app_name if existing_state else "")
        ).strip(),
        passenger_app_root=str(
            getattr(namespace, "passenger_app_root", "") or (existing_state.passenger_app_root if existing_state else "")
        ).strip(),
        node_app_root=str(
            getattr(namespace, "node_app_root", "") or (existing_state.node_app_root if existing_state else "")
        ).strip(),
        node_app_uri=str(
            getattr(namespace, "node_app_uri", "") or (existing_state.node_app_uri if existing_state else "")
        ).strip(),
        admin_script_name=str(
            getattr(namespace, "admin_script_name", "") or (existing_state.admin_script_name if existing_state else "")
        ).strip(),
        hidden_service_name=str(
            getattr(namespace, "hidden_service_name", "") or (existing_state.hidden_service_name if existing_state else "")
        ).strip(),
        hidden_service_user=str(
            getattr(namespace, "hidden_service_user", "") or (existing_state.hidden_service_user if existing_state else "")
        ).strip(),
        hidden_service_group=str(
            getattr(namespace, "hidden_service_group", "") or (existing_state.hidden_service_group if existing_state else "")
        ).strip(),
        watchdog_service_name=str(
            getattr(namespace, "watchdog_service_name", "") or (existing_state.watchdog_service_name if existing_state else "")
        ).strip(),
        watchdog_timer_name=str(
            getattr(namespace, "watchdog_timer_name", "") or (existing_state.watchdog_timer_name if existing_state else "")
        ).strip(),
        hidden_upstream_proxy_url=hidden_upstream_proxy_url,
        hidden_upstream_proxy_label=hidden_upstream_proxy_label,
        hidden_outbound_proxy_url=hidden_outbound_proxy_url,
        hidden_outbound_proxy_label=hidden_outbound_proxy_label,
        verify_tls=verify_tls,
        skip_helper_probe=bool(getattr(namespace, "skip_helper_probe", False)),
    )


def install(namespace: object) -> InstallState:
    args = collect_install_args(namespace)
    missing = [
        name
        for name, value in [
            ("public_origin", args.public_origin),
            ("cpanel_base_url", args.cpanel_base_url),
            ("cpanel_username", args.cpanel_username),
            ("cpanel_password", args.cpanel_password),
            ("cpanel_home", args.cpanel_home),
        ]
        if not value
    ]
    if missing:
        raise SystemExit(f"missing required values: {', '.join(missing)}")

    bundle_root = args.control_root / "bundle"
    _copy_selected_paths(args.repo_root, bundle_root)

    cpanel = CpanelClient(
        base_url=args.cpanel_base_url,
        username=args.cpanel_username,
        password=args.cpanel_password,
        cpanel_home=args.cpanel_home,
        proxy_url=args.cpanel_proxy_url,
        public_proxy_url=args.public_proxy_url,
    )
    tls_verify_supported = cpanel.verify_public_tls(args.public_origin)
    verify_tls = tls_verify_supported if args.verify_tls is None else bool(args.verify_tls)
    capabilities = cpanel.detect_capabilities(args.public_origin, verify_tls)
    _print_capabilities(capabilities)

    available = [capability for capability in capabilities if capability.available]
    if not available:
        raise SystemExit("No supported public-host backend was detected for this account.")
    recommended = next((capability.key for capability in capabilities if capability.recommended), available[0].key)
    backend = args.backend or recommended
    if not any(item.key == backend and item.available for item in available):
        available_labels = ", ".join(item.key for item in available)
        raise SystemExit(f"backend '{backend}' is not available. Available backends: {available_labels}")
    if not args.non_interactive and not args.backend:
        backend = _prompt_choice(
            "Select the backend to deploy",
            [(item.key, f"{item.label} ({'recommended' if item.recommended else item.reason})") for item in available],
            backend,
        )

    defaults = build_generated_defaults(
        bundle_root,
        args.cpanel_home,
        args.site_name,
        instance_name=args.instance_name,
    )

    customize = args.customize or (not args.non_interactive and _prompt_bool("Customize generated paths and names?", False))
    public_base_path = args.public_base_path or (
        defaults.node_base_path if backend == BACKEND_NODE else defaults.passenger_base_path
    )
    passenger_app_name = args.passenger_app_name or defaults.passenger_app_name
    passenger_app_root = args.passenger_app_root or defaults.passenger_app_root
    node_app_root = args.node_app_root or defaults.node_app_root
    node_app_uri = args.node_app_uri or defaults.node_base_path
    admin_script_name = args.admin_script_name or defaults.admin_script_name
    bridge_public_base_path = args.bridge_public_base_path or DEFAULT_BRIDGE_PUBLIC_BASE_PATH
    hidden_service_name = args.hidden_service_name or defaults.hidden_service_name
    hidden_service_user = args.hidden_service_user or defaults.hidden_service_user
    hidden_service_group = args.hidden_service_group or defaults.hidden_service_group
    watchdog_service_name = args.watchdog_service_name or defaults.watchdog_service_name
    watchdog_timer_name = args.watchdog_timer_name or defaults.watchdog_timer_name

    if customize and not args.non_interactive:
        if backend == BACKEND_NODE:
            node_app_uri = _prompt_text("Node public base URI", node_app_uri)
            node_app_root = _prompt_text("Node app root", node_app_root)
            admin_script_name = _prompt_text("Node admin helper script", admin_script_name)
            public_base_path = node_app_uri
        elif backend == BACKEND_BRIDGE:
            public_base_path = _prompt_text("Bridge public site path", public_base_path)
            bridge_public_base_path = _prompt_text("Bridge broker subpath", bridge_public_base_path, allow_blank=True)
        else:
            public_base_path = _prompt_text("Public base URI", public_base_path)
            if backend == BACKEND_PASSENGER:
                passenger_app_name = _prompt_text("Passenger app name", passenger_app_name)
                passenger_app_root = _prompt_text("Passenger app root", passenger_app_root)
        hidden_service_name = _prompt_text("Hidden agent service name", hidden_service_name)
        hidden_service_user = _prompt_text("Hidden agent system user", hidden_service_user)
        hidden_service_group = _prompt_text("Hidden agent system group", hidden_service_group)
        watchdog_service_name = _prompt_text("Watchdog service name", watchdog_service_name)
        watchdog_timer_name = _prompt_text("Watchdog timer name", watchdog_timer_name)
        verify_tls = _prompt_bool("Verify TLS for helper and hidden-agent traffic?", verify_tls)

    public_base_path = _normalize_base_path(public_base_path)
    bridge_public_base_path = _normalize_optional_base_path(bridge_public_base_path)
    node_app_uri = _normalize_base_path(node_app_uri)

    broker_base_url = build_broker_base_url(
        args.public_origin,
        backend,
        public_base_path,
        bridge_public_base_path=bridge_public_base_path,
    )
    client_profile_name = _profile_label(defaults.site_name, backend, args.instance_name)
    profile_share_text = build_profile_share_text(
        name=client_profile_name,
        broker_base_url=broker_base_url,
        client_token=defaults.client_token,
        verify_tls=verify_tls,
        http2_ctl=defaults.client_http2_ctl,
        http2_data=defaults.client_http2_data,
        http_port=defaults.client_http_port,
        socks_port=defaults.client_socks_port,
        target_agent_peer_label=defaults.agent_peer_id,
    )

    state = InstallState(
        version=1,
        instance_name=args.instance_name,
        backend=backend,
        public_origin=args.public_origin,
        public_base_path=public_base_path,
        broker_base_url=broker_base_url,
        client_token=defaults.client_token,
        agent_token=defaults.agent_token,
        client_profile_name=client_profile_name,
        profile_share_text=profile_share_text,
        cpanel_base_url=args.cpanel_base_url,
        cpanel_username=args.cpanel_username,
        cpanel_password=args.cpanel_password,
        cpanel_home=args.cpanel_home,
        cpanel_proxy_url=args.cpanel_proxy_url,
        public_proxy_url=args.public_proxy_url,
        hidden_server_host=args.hidden_server_host,
        hidden_server_port=args.hidden_server_port,
        hidden_server_user=args.hidden_server_user,
        hidden_server_password=args.hidden_server_password,
        hidden_server_ssh_key=args.hidden_server_ssh_key,
        control_root=str(args.control_root),
        bundle_root=str(bundle_root),
        hidden_install_root=str(args.install_root),
        hidden_service_name=hidden_service_name,
        hidden_service_user=hidden_service_user,
        hidden_service_group=hidden_service_group,
        watchdog_service_name=watchdog_service_name,
        watchdog_timer_name=watchdog_timer_name,
        agent_peer_id=defaults.agent_peer_id,
        verify_tls=verify_tls,
        client_http2_ctl=defaults.client_http2_ctl,
        client_http2_data=defaults.client_http2_data,
        client_http_port=defaults.client_http_port,
        client_socks_port=defaults.client_socks_port,
        deployment_id=defaults.deployment_id,
        site_name=defaults.site_name,
        site_slug=defaults.site_slug,
        bridge_public_base_path=bridge_public_base_path,
        passenger_app_name=passenger_app_name,
        passenger_app_root=passenger_app_root,
        node_app_root=node_app_root,
        node_app_uri=node_app_uri,
        admin_script_name=admin_script_name,
        hidden_upstream_proxy_url=args.hidden_upstream_proxy_url,
        hidden_upstream_proxy_label=args.hidden_upstream_proxy_label,
        hidden_outbound_proxy_url=args.hidden_outbound_proxy_url,
        hidden_outbound_proxy_label=args.hidden_outbound_proxy_label,
        host_capabilities=capabilities,
        notes=[
            "TLS verification defaulted from a live public-origin probe."
            if args.verify_tls is None
            else "TLS verification was chosen explicitly.",
            f"Hidden route: {_proxy_display_name(args.hidden_upstream_proxy_label, args.hidden_upstream_proxy_url)}",
            f"Outbound route: {_proxy_display_name(args.hidden_outbound_proxy_label, args.hidden_outbound_proxy_url)}",
        ],
    )

    print("\nDeploy summary:")
    print(f"  instance: {state.instance_name}")
    print(f"  backend: {backend}")
    print(f"  public origin: {state.public_origin}")
    print(f"  broker URL: {state.broker_base_url}")
    print(f"  hidden install root: {state.hidden_install_root}")
    print(f"  public route: {state.public_proxy_url or 'direct'}")
    hidden_target = (
        f"{state.hidden_server_user}@{state.hidden_server_host}:{state.hidden_server_port}"
        if state.hidden_server_host
        else "local machine"
    )
    print(f"  hidden target: {hidden_target}")
    print(f"  hidden service: {state.hidden_service_name}")
    print(f"  hidden route: {_proxy_display_name(state.hidden_upstream_proxy_label, state.hidden_upstream_proxy_url)}")
    print(f"  outbound route: {_proxy_display_name(state.hidden_outbound_proxy_label, state.hidden_outbound_proxy_url)}")
    if not args.non_interactive and not _prompt_bool("Proceed with deployment?", True):
        raise SystemExit("Cancelled.")

    args.control_root.mkdir(parents=True, exist_ok=True)
    print("\nDeploying public host backend...")
    _deploy_host(bundle_root, state)
    print("Installing hidden agent...")
    _install_hidden_server(bundle_root, state)
    print("Verifying live broker health...")
    _verify_final_health(state)
    if not args.skip_helper_probe:
        print("Running local helper probe through the deployed broker...")
        _helper_probe(
            bundle_root,
            state.broker_base_url,
            state.client_token,
            state.verify_tls,
            state.client_http2_ctl,
            state.client_http2_data,
            state.public_proxy_url,
        )
    print("Bootstrapping the local twoman-server management command...")
    save_instance_state(args.control_root, state)
    _create_control_venv(args.control_root, bundle_root)
    _install_launcher(args.control_root)

    print("\nTwoman deployment complete.")
    print(f"  Management command: {SERVER_LAUNCHER_PATH}")
    print(f"  Instance: {state.instance_name}")
    print(f"  State file: {state_path(args.control_root, state.instance_name)}")
    print(f"  Client config: {profile_share_path(args.control_root, state.instance_name)}")
    print("\nImport text:")
    print(state.profile_share_text)
    return state

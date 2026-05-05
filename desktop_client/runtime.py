from __future__ import annotations

import json
import os
import signal
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from desktop_client.models import ClientProfile, SharedSocksProxy
from desktop_client.paths import DesktopPaths


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _port_ready(host: str, port: int, timeout: float = 0.25) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _wait_for_port(host: str, port: int, ready: bool, timeout_seconds: float) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if _port_ready(host, port) == ready:
            return True
        time.sleep(0.2)
    return False


def _command_for(subcommand: str, *extra: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, subcommand, *extra]
    return [sys.executable, "-m", "desktop_client", subcommand, *extra]


def _helper_command(config_path: Path) -> tuple[list[str], Path]:
    configured = os.environ.get("TWOMAN_HELPER_AGENT_BINARY")
    if configured:
        helper_binary = Path(configured)
        if not helper_binary.exists():
            raise RuntimeError(f"TWOMAN_HELPER_AGENT_BINARY does not exist: {helper_binary}")
        return [str(helper_binary), "--mode", "helper", "--config", str(config_path)], helper_binary.parent

    if getattr(sys, "frozen", False):
        suffix = ".exe" if sys.platform == "win32" else ""
        helper_binary = Path(sys.executable).with_name(f"twoman-helper-agent{suffix}")
        if not helper_binary.exists():
            raise RuntimeError(f"Missing packaged Go helper sidecar: {helper_binary}")
        return [str(helper_binary), "--mode", "helper", "--config", str(config_path)], helper_binary.parent

    go_binary = shutil.which("go")
    if not go_binary:
        raise RuntimeError("Go is required to run the source desktop TUI helper")
    repo_root = Path(__file__).resolve().parents[1]
    helper_agent_dir = repo_root / "helper-agent"
    if not (helper_agent_dir / "go.mod").exists():
        raise RuntimeError(f"Missing Go helper-agent source: {helper_agent_dir}")
    return [go_binary, "run", ".", "--mode", "helper", "--config", str(config_path)], helper_agent_dir


def _read_tail(path: Path, limit: int = 20) -> str:
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-limit:])


def discover_share_addresses(listen_host: str, listen_port: int) -> list[str]:
    if listen_host not in {"0.0.0.0", "::", ""}:
        return [f"{listen_host}:{listen_port}"]
    addresses = {f"127.0.0.1:{listen_port}"}
    udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        udp_sock.connect(("8.8.8.8", 53))
        primary_ip = udp_sock.getsockname()[0]
        if primary_ip:
            addresses.add(f"{primary_ip}:{listen_port}")
    except OSError:
        pass
    finally:
        udp_sock.close()
    return sorted(addresses)


@dataclass(slots=True)
class HelperStatus:
    running: bool
    pid: int | None
    profile_id: str | None
    profile_name: str | None
    http_port: int
    socks_port: int
    log_path: str
    message: str = ""


@dataclass(slots=True)
class ShareStatus:
    share_id: str
    running: bool
    pid: int | None
    log_path: str
    addresses: list[str]
    message: str = ""


class HelperProcessManager:
    """Starts and stops the local Twoman helper as a managed subprocess."""

    def __init__(self, paths: DesktopPaths) -> None:
        self.paths = paths.ensure()

    def status(self) -> HelperStatus:
        state = _read_json(self.paths.helper_state_file)
        pid = int(state.get("pid", 0) or 0)
        running = _pid_alive(pid) and _port_ready("127.0.0.1", int(state.get("socks_port", 0) or 0))
        if not running and state:
            self.paths.helper_state_file.unlink(missing_ok=True)
        return HelperStatus(
            running=running,
            pid=pid or None,
            profile_id=state.get("profile_id"),
            profile_name=state.get("profile_name"),
            http_port=int(state.get("http_port", 0) or 0),
            socks_port=int(state.get("socks_port", 0) or 0),
            log_path=str(self.paths.helper_log_file),
            message="" if running else _read_tail(self.paths.helper_log_file, limit=8),
        )

    def start(self, profile: ClientProfile) -> HelperStatus:
        current = self.status()
        if current.running:
            if current.profile_id == profile.id:
                return current
            self.stop()
        config = profile.to_runtime_config(str(self.paths.helper_log_file))
        _write_json(self.paths.helper_config_file, config)
        command, cwd = _helper_command(self.paths.helper_config_file)
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _write_json(
            self.paths.helper_state_file,
            {
                "pid": process.pid,
                "profile_id": profile.id,
                "profile_name": profile.name,
                "http_port": profile.http_port,
                "socks_port": profile.socks_port,
            },
        )
        if not _wait_for_port("127.0.0.1", profile.socks_port, True, 15):
            raise RuntimeError(f"Helper did not bind SOCKS port {profile.socks_port}\n{_read_tail(self.paths.helper_log_file)}")
        if not _wait_for_port("127.0.0.1", profile.http_port, True, 15):
            raise RuntimeError(f"Helper did not bind HTTP port {profile.http_port}\n{_read_tail(self.paths.helper_log_file)}")
        return self.status()

    def stop(self) -> HelperStatus:
        state = _read_json(self.paths.helper_state_file)
        pid = int(state.get("pid", 0) or 0)
        http_port = int(state.get("http_port", 0) or 0)
        socks_port = int(state.get("socks_port", 0) or 0)
        if pid and _pid_alive(pid):
            os.kill(pid, signal.SIGTERM)
            deadline = time.time() + 8
            while time.time() < deadline and _pid_alive(pid):
                time.sleep(0.2)
            if _pid_alive(pid):
                os.kill(pid, signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)
        if http_port:
            _wait_for_port("127.0.0.1", http_port, False, 5)
        if socks_port:
            _wait_for_port("127.0.0.1", socks_port, False, 5)
        self.paths.helper_state_file.unlink(missing_ok=True)
        return self.status()


class ShareProcessManager:
    """Manages one or more authenticated SOCKS shares as subprocesses."""

    def __init__(self, paths: DesktopPaths) -> None:
        self.paths = paths.ensure()

    def status(self, share: SharedSocksProxy) -> ShareStatus:
        state = _read_json(self.paths.share_state_file(share.id))
        pid = int(state.get("pid", 0) or 0)
        running = _pid_alive(pid) and _port_ready(share.listen_host if share.listen_host != "0.0.0.0" else "127.0.0.1", share.listen_port)
        if not running and state:
            self.paths.share_state_file(share.id).unlink(missing_ok=True)
        return ShareStatus(
            share_id=share.id,
            running=running,
            pid=pid or None,
            log_path=str(self.paths.share_log_file(share.id)),
            addresses=discover_share_addresses(share.listen_host, share.listen_port),
            message="" if running else _read_tail(self.paths.share_log_file(share.id), limit=8),
        )

    def start(self, share: SharedSocksProxy) -> ShareStatus:
        current = self.status(share)
        if current.running:
            return current
        config = share.to_runtime_config(str(self.paths.share_log_file(share.id)))
        config_path = self.paths.share_config_file(share.id)
        _write_json(config_path, config)
        command = _command_for("gateway-run", "--config", str(config_path))
        process = subprocess.Popen(
            command,
            cwd=str(Path(__file__).resolve().parents[1]),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _write_json(self.paths.share_state_file(share.id), {"pid": process.pid})
        probe_host = share.listen_host if share.listen_host != "0.0.0.0" else "127.0.0.1"
        if not _wait_for_port(probe_host, share.listen_port, True, 10):
            raise RuntimeError(f"Share did not bind {share.listen_host}:{share.listen_port}\n{_read_tail(self.paths.share_log_file(share.id))}")
        return self.status(share)

    def stop(self, share: SharedSocksProxy) -> ShareStatus:
        state = _read_json(self.paths.share_state_file(share.id))
        pid = int(state.get("pid", 0) or 0)
        if pid and _pid_alive(pid):
            os.kill(pid, signal.SIGTERM)
            deadline = time.time() + 8
            while time.time() < deadline and _pid_alive(pid):
                time.sleep(0.2)
            if _pid_alive(pid):
                os.kill(pid, signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)
        probe_host = share.listen_host if share.listen_host != "0.0.0.0" else "127.0.0.1"
        _wait_for_port(probe_host, share.listen_port, False, 5)
        self.paths.share_state_file(share.id).unlink(missing_ok=True)
        return self.status(share)

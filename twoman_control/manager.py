from __future__ import annotations

import json
import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

from twoman_http import httpx_request
from twoman_control.installer import SERVER_LAUNCHER_PATH
from twoman_control.models import BACKEND_BRIDGE, BACKEND_NODE, BACKEND_PASSENGER, InstanceRegistry, InstallState
from twoman_control.registry import (
    load_instance_state,
    load_registry,
    resolve_instance_name,
    set_default_instance as registry_set_default_instance,
)


@dataclass(slots=True)
class ActionResult:
    ok: bool
    summary: str
    details: str = ""


class ManagerController:
    def __init__(self, control_root: Path, instance_name: str | None = None) -> None:
        self.control_root = control_root
        self.instance_name = ""
        self.state: InstallState
        self.switch_instance(instance_name)

    def registry(self) -> InstanceRegistry:
        return load_registry(self.control_root)

    def switch_instance(self, instance_name: str | None) -> None:
        self.instance_name = resolve_instance_name(self.control_root, instance_name)
        self.state = load_instance_state(self.control_root, self.instance_name)

    def set_default_instance(self, instance_name: str | None = None) -> None:
        resolved = resolve_instance_name(self.control_root, instance_name or self.instance_name)
        registry_set_default_instance(self.control_root, resolved)
        self.switch_instance(resolved)

    def list_instances_text(self) -> str:
        registry = self.registry()
        lines = []
        for instance in registry.instances:
            marker = "*" if instance.name == registry.default_instance else " "
            lines.append(f"{marker} {instance.name}: {instance.backend} -> {instance.broker_base_url}")
        return "\n".join(lines) or "No Twoman instances are installed."

    @property
    def bundle_root(self) -> Path:
        return Path(self.state.bundle_root)

    def _run(self, command: list[str], *, env: dict[str, str] | None = None) -> ActionResult:
        try:
            result = subprocess.run(command, text=True, capture_output=True, check=False, env=env)
        except OSError as error:
            return ActionResult(False, "command failed to start", str(error))
        details = result.stdout.strip()
        if result.stderr.strip():
            details = f"{details}\n{result.stderr.strip()}".strip()
        return ActionResult(result.returncode == 0, details.splitlines()[0] if details else "ok", details)

    def _hidden_command(self, command: list[str]) -> tuple[list[str], dict[str, str] | None]:
        if not self.state.hidden_server_host:
            return command, None

        ssh_command = [
            "ssh",
            "-p",
            str(self.state.hidden_server_port or 22),
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ConnectTimeout=10",
        ]
        if self.state.hidden_server_ssh_key:
            ssh_command.extend(["-i", self.state.hidden_server_ssh_key])

        command_env = None
        if self.state.hidden_server_password:
            command_env = os.environ.copy()
            command_env["SSHPASS"] = self.state.hidden_server_password
            ssh_command = ["sshpass", "-e", *ssh_command]
        else:
            ssh_command.extend(["-o", "BatchMode=yes"])

        ssh_command.extend(
            [
                f"{self.state.hidden_server_user}@{self.state.hidden_server_host}",
                shlex.join(command),
            ]
        )
        return ssh_command, command_env

    def _run_hidden(self, command: list[str]) -> ActionResult:
        hidden_command, command_env = self._hidden_command(command)
        return self._run(hidden_command, env=command_env)

    def hidden_route_text(self) -> str:
        if not self.state.hidden_upstream_proxy_url:
            return "direct"
        if self.state.hidden_upstream_proxy_label == "wireproxy":
            return f"WARP WireProxy via {self.state.hidden_upstream_proxy_url}"
        return f"custom upstream proxy via {self.state.hidden_upstream_proxy_url}"

    def outbound_route_text(self) -> str:
        if not self.state.hidden_outbound_proxy_url:
            return "direct"
        if self.state.hidden_outbound_proxy_label == "wireproxy":
            return f"WARP WireProxy via {self.state.hidden_outbound_proxy_url}"
        return f"custom outbound proxy via {self.state.hidden_outbound_proxy_url}"

    def verify(self) -> ActionResult:
        service_state = self._run_hidden(["systemctl", "is-active", self.state.hidden_service_name])
        timer_state = self._run_hidden(["systemctl", "is-active", self.state.watchdog_timer_name])
        route_state = None
        if "wireproxy" in {self.state.hidden_upstream_proxy_label, self.state.hidden_outbound_proxy_label}:
            route_state = self._run_hidden(["systemctl", "is-active", "wireproxy.service"])
        try:
            response = httpx_request(
                "GET",
                f"{self.state.broker_base_url.rstrip('/')}/health",
                headers={"Authorization": f"Bearer {self.state.client_token}"},
                timeout=20.0,
                verify=self.state.verify_tls,
                proxy_url=self.state.public_proxy_url or None,
                follow_redirects=True,
            )
            response.raise_for_status()
            payload = response.json()
            ok = bool(payload.get("ok")) and service_state.ok and timer_state.ok
            if route_state is not None:
                ok = ok and route_state.ok
            details_payload = {
                "service": service_state.summary,
                "watchdog": timer_state.summary,
                "host_route": self.hidden_route_text(),
                "outbound_route": self.outbound_route_text(),
                "broker_ok": payload.get("ok"),
                "peers": payload.get("stats", {}).get("peers"),
                "streams": payload.get("stats", {}).get("streams"),
            }
            if route_state is not None:
                details_payload["route_proxy_service"] = route_state.summary
            summary = "healthy" if ok else "degraded"
            return ActionResult(ok, summary, json.dumps(details_payload, indent=2))
        except Exception as error:
            return ActionResult(False, "health check failed", str(error))

    def restart_agent(self) -> ActionResult:
        return self._run_hidden(["systemctl", "restart", self.state.hidden_service_name])

    def restart_watchdog(self) -> ActionResult:
        return self._run_hidden(["systemctl", "start", self.state.watchdog_service_name])

    def restart_upstream_proxy(self) -> ActionResult:
        if "wireproxy" not in {self.state.hidden_upstream_proxy_label, self.state.hidden_outbound_proxy_label}:
            return ActionResult(False, "no managed WARP proxy", "This deployment is not using managed WARP WireProxy.")
        return self._run_hidden(["systemctl", "restart", "wireproxy.service"])

    def journal_tail(self, lines: int = 120) -> str:
        command, command_env = self._hidden_command(
            ["journalctl", "-u", self.state.hidden_service_name, "-n", str(lines), "--no-pager"]
        )
        try:
            result = subprocess.run(
                command,
                text=True,
                capture_output=True,
                check=False,
                env=command_env,
            )
        except OSError as error:
            return f"Failed to load hidden-agent logs: {error}"
        return (result.stdout or result.stderr or "No logs available.").strip()

    def capabilities_text(self) -> str:
        if not self.state.host_capabilities:
            return "No capability data was recorded during installation."
        lines = []
        for capability in self.state.host_capabilities:
            status = "recommended" if capability.recommended else "available" if capability.available else "unavailable"
            lines.append(f"{capability.label}: {status}")
            if capability.reason:
                lines.append(f"  {capability.reason}")
        return "\n".join(lines)

    def redeploy_host(self) -> ActionResult:
        state = self.state
        if state.backend == BACKEND_PASSENGER:
            env = {
                "TWOMAN_CPANEL_BASE_URL": state.cpanel_base_url,
                "TWOMAN_CPANEL_USERNAME": state.cpanel_username,
                "TWOMAN_CPANEL_PASSWORD": state.cpanel_password,
                "TWOMAN_CPANEL_HOME": state.cpanel_home,
                "TWOMAN_CPANEL_PROXY_URL": state.cpanel_proxy_url,
                "TWOMAN_PUBLIC_ORIGIN": state.public_origin,
                "TWOMAN_PUBLIC_BASE_PATH": state.public_base_path,
                "TWOMAN_APP_NAME": state.passenger_app_name,
                "TWOMAN_APP_ROOT": state.passenger_app_root,
                "TWOMAN_CLIENT_TOKEN": state.client_token,
                "TWOMAN_AGENT_TOKEN": state.agent_token,
                "TWOMAN_CAMOUFLAGE_SITE_ENABLED": "true",
                "TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID": state.deployment_id,
                "TWOMAN_CAMOUFLAGE_SITE_NAME": state.site_name,
                "TWOMAN_PUBLIC_PROXY_URL": state.public_proxy_url,
            }
            script = self.bundle_root / "scripts" / "deploy_host_passenger.sh"
        elif state.backend == BACKEND_NODE:
            env = {
                "TWOMAN_CPANEL_BASE_URL": state.cpanel_base_url,
                "TWOMAN_CPANEL_USERNAME": state.cpanel_username,
                "TWOMAN_CPANEL_PASSWORD": state.cpanel_password,
                "TWOMAN_CPANEL_HOME": state.cpanel_home,
                "TWOMAN_CPANEL_PROXY_URL": state.cpanel_proxy_url,
                "TWOMAN_PUBLIC_HOST": state.public_origin.replace("https://", "").replace("http://", "").strip("/"),
                "TWOMAN_NODE_APP_ROOT": state.node_app_root,
                "TWOMAN_NODE_APP_URI": state.node_app_uri,
                "TWOMAN_ADMIN_SCRIPT_NAME": state.admin_script_name,
                "TWOMAN_CLIENT_TOKEN": state.client_token,
                "TWOMAN_AGENT_TOKEN": state.agent_token,
                "TWOMAN_CAMOUFLAGE_SITE_ENABLED": "true",
                "TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID": state.deployment_id,
                "TWOMAN_CAMOUFLAGE_SITE_NAME": state.site_name,
                "TWOMAN_PUBLIC_PROXY_URL": state.public_proxy_url,
            }
            script = self.bundle_root / "scripts" / "deploy_host_node_selector.sh"
        else:
            env = {
                "TWOMAN_CPANEL_BASE_URL": state.cpanel_base_url,
                "TWOMAN_CPANEL_USERNAME": state.cpanel_username,
                "TWOMAN_CPANEL_PASSWORD": state.cpanel_password,
                "TWOMAN_CPANEL_HOME": state.cpanel_home,
                "TWOMAN_CPANEL_PROXY_URL": state.cpanel_proxy_url,
                "TWOMAN_PUBLIC_ORIGIN": state.public_origin,
                "TWOMAN_PUBLIC_BASE_PATH": state.public_base_path,
                "TWOMAN_BRIDGE_PUBLIC_BASE_PATH": state.bridge_public_base_path,
                "TWOMAN_CLIENT_TOKEN": state.client_token,
                "TWOMAN_AGENT_TOKEN": state.agent_token,
                "TWOMAN_PUBLIC_PROXY_URL": state.public_proxy_url,
                "TWOMAN_CAMOUFLAGE_SITE_ENABLED": "true",
                "TWOMAN_CAMOUFLAGE_DEPLOYMENT_ID": state.deployment_id,
                "TWOMAN_CAMOUFLAGE_SITE_NAME": state.site_name,
            }
            script = self.bundle_root / "scripts" / "deploy_host.sh"
        merged_env = os.environ.copy()
        merged_env.update(env)
        result = subprocess.run(
            ["bash", str(script)],
            cwd=self.bundle_root,
            env=merged_env,
            text=True,
            capture_output=True,
            check=False,
        )
        details = f"{result.stdout}\n{result.stderr}".strip()
        summary = "host redeployed" if result.returncode == 0 else "host redeploy failed"
        return ActionResult(result.returncode == 0, summary, details)

    def install_command(self) -> list[str]:
        return [str(SERVER_LAUNCHER_PATH), "install", "--instance", self.state.instance_name]

    def purge_command(self) -> list[str]:
        return [str(SERVER_LAUNCHER_PATH), "purge", "--instance", self.state.instance_name]

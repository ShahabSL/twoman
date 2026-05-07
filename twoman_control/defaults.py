from __future__ import annotations

import base64
import json
import secrets
import subprocess
from pathlib import Path

from twoman_control.models import GeneratedDefaults
from twoman_control.registry import DEFAULT_INSTANCE_NAME, normalize_instance_name


def _safe_handle(value: str, suffix: str = "") -> str:
    cleaned = "".join(character if character.isalnum() else "_" for character in value.lower())
    cleaned = "_".join(part for part in cleaned.split("_") if part)
    if not cleaned:
        cleaned = "twoman"
    if suffix:
        cleaned = f"{cleaned}_{suffix}"
    return cleaned[:48].rstrip("_")


def _token(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(8)}"


def build_generated_defaults(
    bundle_root: Path,
    cpanel_home: str,
    site_name: str = "",
    *,
    instance_name: str = DEFAULT_INSTANCE_NAME,
) -> GeneratedDefaults:
    instance_handle = normalize_instance_name(instance_name)
    hidden_install_root = "/opt/twoman" if instance_handle == DEFAULT_INSTANCE_NAME else f"/opt/twoman-{instance_handle}"
    hidden_service_name = (
        "twoman-agent.service" if instance_handle == DEFAULT_INSTANCE_NAME else f"twoman-{instance_handle}.service"
    )
    watchdog_service_name = (
        "twoman-agent-watchdog.service"
        if instance_handle == DEFAULT_INSTANCE_NAME
        else f"twoman-{instance_handle}-watchdog.service"
    )
    watchdog_timer_name = (
        "twoman-agent-watchdog.timer"
        if instance_handle == DEFAULT_INSTANCE_NAME
        else f"twoman-{instance_handle}-watchdog.timer"
    )
    deployment_id = secrets.token_hex(6)
    manifest_path = bundle_root / "scripts" / "generate_camouflage_site.py"
    command = ["python3", str(manifest_path), "--deployment-id", deployment_id]
    if site_name.strip():
        command.extend(["--site-name", site_name.strip()])
    manifest = json.loads(subprocess.check_output(command, text=True, cwd=bundle_root))
    site_slug = str(manifest["site_slug"]).strip()
    passenger_handle = _safe_handle(site_slug)
    return GeneratedDefaults(
        deployment_id=deployment_id,
        site_name=str(manifest["site_name"]).strip(),
        site_slug=site_slug,
        passenger_base_path=str(manifest["passenger_base_path"]).strip(),
        node_base_path=str(manifest["node_base_path"]).strip(),
        passenger_app_name=passenger_handle,
        passenger_app_root=f"{cpanel_home.rstrip('/')}/{passenger_handle}",
        node_app_root=f"{cpanel_home.rstrip('/')}/{passenger_handle}_node",
        admin_script_name=f"{passenger_handle}_negahban.php",
        client_token=_token("twoman-client"),
        agent_token=_token("twoman-agent"),
        agent_peer_id="agent-main" if instance_handle == DEFAULT_INSTANCE_NAME else f"agent-{instance_handle}",
        hidden_install_root=hidden_install_root,
        hidden_service_name=hidden_service_name,
        hidden_service_user="twoman",
        hidden_service_group="twoman",
        watchdog_service_name=watchdog_service_name,
        watchdog_timer_name=watchdog_timer_name,
    )


def build_profile_share_text(
    *,
    name: str,
    broker_base_url: str,
    client_token: str,
    verify_tls: bool,
    http2_ctl: bool,
    http2_data: bool,
    http_port: int,
    socks_port: int,
    target_agent_peer_label: str = "",
) -> str:
    payload = {
        "name": name,
        "brokerBaseUrl": broker_base_url,
        "clientToken": client_token,
        "targetAgentPeerLabel": target_agent_peer_label,
        "verifyTls": verify_tls,
        "http2Ctl": http2_ctl,
        "http2Data": http2_data,
        "shareLanSocks": False,
        "httpPort": http_port,
        "socksPort": socks_port,
        "httpTimeoutSeconds": 30,
        "vpnDnsServers": ["1.1.1.1", "8.8.8.8"],
        "idleRepollCtlSeconds": 0.05,
        "idleRepollDataSeconds": 0.1,
        "traceEnabled": False,
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    return f"twoman://profile?data={encoded}"

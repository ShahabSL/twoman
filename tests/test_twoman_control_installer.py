from __future__ import annotations

import argparse
import base64
import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from twoman_control.installer import (
    _normalize_base_path,
    _normalize_optional_base_path,
    _install_local_hidden_server,
    _purge_host,
    _purge_local_hidden_server,
    purge_installation,
    build_broker_base_url,
    collect_install_args,
)
from twoman_control.defaults import build_profile_share_text
from twoman_control.cli import _run_overview, build_parser
from twoman_control.models import BACKEND_BRIDGE, BACKEND_NODE, BACKEND_PASSENGER, InstallState
from twoman_control.registry import (
    DEFAULT_INSTANCE_NAME,
    load_registry,
    managed_instance_from_state,
    load_instance_state,
    state_path,
)


def _sample_state(control_root: Path) -> InstallState:
    return InstallState(
        version=1,
        instance_name=DEFAULT_INSTANCE_NAME,
        backend=BACKEND_PASSENGER,
        public_origin="https://host.example.com",
        public_base_path="/sahar-honar-221b/payesh-asnad",
        broker_base_url="https://host.example.com/sahar-honar-221b/payesh-asnad",
        client_token="client-token",
        agent_token="agent-token",
        client_profile_name="Primary Host",
        profile_share_text="twoman://profile?data=abc",
        cpanel_base_url="https://host.example.com:2083",
        cpanel_username="cpanel-user",
        cpanel_password="cpanel-pass",
        cpanel_home="/home/cpanel-user",
        cpanel_proxy_url="",
        public_proxy_url="",
        hidden_server_host="",
        hidden_server_port=22,
        hidden_server_user="",
        hidden_server_password="",
        hidden_server_ssh_key="",
        control_root=str(control_root),
        bundle_root=str(control_root / "bundle"),
        hidden_install_root="/opt/twoman-existing",
        hidden_service_name="twoman-agent.service",
        hidden_service_user="twoman",
        hidden_service_group="twoman",
        watchdog_service_name="twoman-agent-watchdog.service",
        watchdog_timer_name="twoman-agent-watchdog.timer",
        agent_peer_id="agent-main",
        verify_tls=False,
        client_http2_ctl=True,
        client_http2_data=False,
        client_http_port=18092,
        client_socks_port=11092,
        deployment_id="deadbeefcafe",
        site_name="سحر هنر",
        site_slug="sahar-honar-221b",
        bridge_public_base_path="",
        passenger_app_name="sahar_honar_221b",
        passenger_app_root="/home/cpanel-user/sahar_honar_221b",
        node_app_root="/home/cpanel-user/sahar_honar_221b_node",
        node_app_uri="/sahar-honar-221b/ertebat-negah",
        admin_script_name="sahar_honar_221b_negahban.php",
        hidden_upstream_proxy_url="socks5h://127.0.0.1:1280",
        hidden_upstream_proxy_label="wireproxy",
        hidden_outbound_proxy_url="socks5h://127.0.0.1:1280",
        hidden_outbound_proxy_label="wireproxy",
    )


class TwomanInstallerTests(unittest.TestCase):
    def test_server_cli_has_clean_default_and_aliases(self) -> None:
        parser = build_parser()
        self.assertIsNone(parser.parse_args([]).command)
        self.assertEqual(parser.parse_args(["status"]).command, "status")
        self.assertEqual(parser.parse_args(["config"]).command, "config")
        self.assertEqual(parser.parse_args(["restart"]).command, "restart")
        self.assertEqual(parser.parse_args(["list"]).command, "list")

    def test_server_cli_overview_is_useful_without_tui(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            control_root = Path(temp_dir)
            state = _sample_state(control_root)
            state.save(state_path(control_root, DEFAULT_INSTANCE_NAME))
            registry = load_registry(control_root)
            registry.default_instance = DEFAULT_INSTANCE_NAME
            registry.upsert(managed_instance_from_state(control_root, state))
            registry.save(control_root / "instances.json")

            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                exit_code = _run_overview(control_root, "")

        self.assertEqual(exit_code, 0)
        text = output.getvalue()
        self.assertIn("Twoman server control", text)
        self.assertIn("twoman-server status", text)
        self.assertIn("twoman-server config", text)
        self.assertNotIn("twoman tui", text)

    def test_profile_share_text_can_pin_target_agent(self) -> None:
        text = build_profile_share_text(
            name="Parvaneh",
            broker_base_url="https://host.example.com/parvaneh",
            client_token="client-token",
            verify_tls=True,
            http2_ctl=False,
            http2_data=False,
            http_port=18092,
            socks_port=11092,
            target_agent_peer_label="agent-node",
        )
        encoded = text.split("data=", 1)[1]
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * ((4 - len(encoded) % 4) % 4)))
        self.assertEqual(payload["targetAgentPeerLabel"], "agent-node")

    def test_normalize_base_path_adds_leading_slash_and_removes_trailing_slash(self) -> None:
        self.assertEqual(_normalize_base_path("darvazeh"), "/darvazeh")
        self.assertEqual(_normalize_base_path("/api/v1/telemetry/"), "/api/v1/telemetry")
        self.assertEqual(_normalize_base_path(""), "/")

    def test_normalize_optional_base_path_preserves_blank_value(self) -> None:
        self.assertEqual(_normalize_optional_base_path(""), "")
        self.assertEqual(_normalize_optional_base_path("/api/v1/telemetry/"), "/api/v1/telemetry")

    def test_build_broker_base_url_uses_backend_specific_shape(self) -> None:
        self.assertEqual(
            build_broker_base_url("https://host.example.com", BACKEND_PASSENGER, "/darvazeh"),
            "https://host.example.com/darvazeh",
        )
        self.assertEqual(
            build_broker_base_url("https://host.example.com", BACKEND_NODE, "/darvazeh-node"),
            "https://host.example.com/darvazeh-node",
        )
        self.assertEqual(
            build_broker_base_url(
                "https://host.example.com",
                BACKEND_BRIDGE,
                "/rahkar",
                bridge_public_base_path="",
            ),
            "https://host.example.com/rahkar",
        )

    def test_collect_install_args_reuses_existing_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            control_root = Path(temp_dir)
            state = _sample_state(control_root)
            state.save(state_path(control_root, DEFAULT_INSTANCE_NAME))
            registry = load_registry(control_root)
            registry.default_instance = DEFAULT_INSTANCE_NAME
            registry.upsert(managed_instance_from_state(control_root, state))
            registry.save(control_root / "instances.json")
            args = collect_install_args(
                argparse.Namespace(
                    instance=DEFAULT_INSTANCE_NAME,
                    repo_root=Path("/tmp/repo"),
                    control_root=control_root,
                    install_root=None,
                    public_origin="",
                    cpanel_base_url="",
                    cpanel_username="",
                    cpanel_password="",
                    cpanel_home="",
                    cpanel_proxy_url="",
                    public_proxy_url="",
                    server_host="",
                    server_port=22,
                    server_user="",
                    server_password="",
                    server_ssh_key="",
                    site_name="",
                    backend="",
                    public_base_path="",
                    bridge_public_base_path="",
                    passenger_app_name="",
                    passenger_app_root="",
                    node_app_root="",
                    node_app_uri="",
                    admin_script_name="",
                    hidden_service_name="",
                    hidden_service_user="",
                    hidden_service_group="",
                    watchdog_service_name="",
                    watchdog_timer_name="",
                    hidden_upstream_proxy_url="",
                    hidden_upstream_proxy_label="",
                    hidden_outbound_proxy_url="",
                    hidden_outbound_proxy_label="",
                    non_interactive=True,
                    customize=False,
                    skip_helper_probe=False,
                    verify_tls=None,
                )
            )

        self.assertEqual(args.public_origin, "https://host.example.com")
        self.assertEqual(args.cpanel_base_url, "https://host.example.com:2083")
        self.assertEqual(args.cpanel_username, "cpanel-user")
        self.assertEqual(args.cpanel_password, "cpanel-pass")
        self.assertEqual(args.cpanel_home, "/home/cpanel-user")
        self.assertEqual(args.backend, BACKEND_PASSENGER)
        self.assertEqual(args.public_base_path, "/sahar-honar-221b/payesh-asnad")
        self.assertEqual(args.bridge_public_base_path, "")
        self.assertEqual(args.install_root, Path("/opt/twoman-existing"))
        self.assertFalse(args.verify_tls)
        self.assertEqual(args.hidden_upstream_proxy_url, "socks5h://127.0.0.1:1280")
        self.assertEqual(args.hidden_upstream_proxy_label, "wireproxy")
        self.assertEqual(args.hidden_outbound_proxy_url, "socks5h://127.0.0.1:1280")
        self.assertEqual(args.hidden_outbound_proxy_label, "wireproxy")

    def test_collect_install_args_keeps_explicit_noninteractive_values_without_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = collect_install_args(
                argparse.Namespace(
                    instance="bridge",
                    repo_root=Path("/tmp/repo"),
                    control_root=Path(temp_dir) / "control",
                    install_root=None,
                    public_origin="https://host.example.com",
                    cpanel_base_url="https://host.example.com:2083",
                    cpanel_username="cpanel-user",
                    cpanel_password="cpanel-pass",
                    cpanel_home="/home/cpanel-user",
                    cpanel_proxy_url="",
                    public_proxy_url="",
                    server_host="",
                    server_port=22,
                    server_user="",
                    server_password="",
                    server_ssh_key="",
                    site_name="سحر هنر",
                    backend=BACKEND_PASSENGER,
                    public_base_path="/darvazeh",
                    bridge_public_base_path="",
                    passenger_app_name="darvazeh_app",
                    passenger_app_root="/home/cpanel-user/darvazeh_app",
                    node_app_root="",
                    node_app_uri="",
                    admin_script_name="",
                    hidden_service_name="twoman-agent.service",
                    hidden_service_user="twoman",
                    hidden_service_group="twoman",
                    watchdog_service_name="twoman-agent-watchdog.service",
                    watchdog_timer_name="twoman-agent-watchdog.timer",
                    hidden_upstream_proxy_url="",
                    hidden_upstream_proxy_label="",
                    hidden_outbound_proxy_url="",
                    hidden_outbound_proxy_label="",
                    non_interactive=True,
                    customize=False,
                    skip_helper_probe=False,
                    verify_tls=True,
                )
            )

        self.assertEqual(args.public_origin, "https://host.example.com")
        self.assertEqual(args.instance_name, "bridge")
        self.assertEqual(args.cpanel_base_url, "https://host.example.com:2083")
        self.assertEqual(args.cpanel_username, "cpanel-user")
        self.assertEqual(args.cpanel_password, "cpanel-pass")
        self.assertEqual(args.cpanel_home, "/home/cpanel-user")
        self.assertEqual(args.backend, BACKEND_PASSENGER)
        self.assertEqual(args.public_base_path, "/darvazeh")
        self.assertTrue(args.verify_tls)
        self.assertEqual(args.hidden_upstream_proxy_url, "")
        self.assertEqual(args.hidden_outbound_proxy_url, "")
        self.assertEqual(args.install_root, Path("/opt/twoman-bridge"))

    def test_collect_install_args_keeps_remote_hidden_server_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = collect_install_args(
                argparse.Namespace(
                    instance="node",
                    repo_root=Path("/tmp/repo"),
                    control_root=Path(temp_dir) / "control",
                    install_root=None,
                    public_origin="https://host.example.com",
                    cpanel_base_url="https://host.example.com:2083",
                    cpanel_username="cpanel-user",
                    cpanel_password="cpanel-pass",
                    cpanel_home="/home/cpanel-user",
                    cpanel_proxy_url="",
                    public_proxy_url="",
                    server_host="198.51.100.25",
                    server_port=5522,
                    server_user="root",
                    server_password="secret",
                    server_ssh_key="",
                    site_name="دروازه",
                    backend=BACKEND_NODE,
                    public_base_path="/parvaneh",
                    bridge_public_base_path="",
                    passenger_app_name="",
                    passenger_app_root="",
                    node_app_root="/home/cpanel-user/parvaneh_node",
                    node_app_uri="/parvaneh",
                    admin_script_name="parvaneh_negahban.php",
                    hidden_service_name="twoman-node.service",
                    hidden_service_user="twoman",
                    hidden_service_group="twoman",
                    watchdog_service_name="twoman-node-watchdog.service",
                    watchdog_timer_name="twoman-node-watchdog.timer",
                    hidden_upstream_proxy_url="socks5h://127.0.0.1:1280",
                    hidden_upstream_proxy_label="wireproxy",
                    hidden_outbound_proxy_url="socks5h://127.0.0.1:1280",
                    hidden_outbound_proxy_label="wireproxy",
                    non_interactive=True,
                    customize=False,
                    skip_helper_probe=False,
                    verify_tls=True,
                )
            )

        self.assertEqual(args.hidden_server_host, "198.51.100.25")
        self.assertEqual(args.hidden_server_port, 5522)
        self.assertEqual(args.hidden_server_user, "root")
        self.assertEqual(args.hidden_server_password, "secret")

    @patch("twoman_control.installer._run_script")
    def test_install_local_hidden_server_passes_hidden_proxy_env(self, run_script_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = _sample_state(Path(temp_dir))
            run_script_mock.return_value = subprocess.CompletedProcess(
                args=["bash", "scripts/install_hidden_server_local.sh"],
                returncode=0,
                stdout="ok",
                stderr="",
            )

            _install_local_hidden_server(Path("/tmp/repo"), state)

        env = run_script_mock.call_args.args[1]
        self.assertEqual(env["TWOMAN_UPSTREAM_PROXY_URL"], "socks5h://127.0.0.1:1280")
        self.assertEqual(env["TWOMAN_UPSTREAM_PROXY_LABEL"], "wireproxy")
        self.assertEqual(env["TWOMAN_OUTBOUND_PROXY_URL"], "socks5h://127.0.0.1:1280")
        self.assertEqual(env["TWOMAN_OUTBOUND_PROXY_LABEL"], "wireproxy")

    @patch("twoman_control.installer._run_script")
    def test_install_remote_hidden_server_passes_ssh_env(self, run_script_mock) -> None:
        from twoman_control.installer import _install_hidden_server

        with tempfile.TemporaryDirectory() as temp_dir:
            state = _sample_state(Path(temp_dir))
            state.hidden_server_host = "198.51.100.25"
            state.hidden_server_port = 5522
            state.hidden_server_user = "root"
            state.hidden_server_password = "secret"
            state.hidden_service_name = "twoman-node.service"
            state.watchdog_service_name = "twoman-node-watchdog.service"
            state.watchdog_timer_name = "twoman-node-watchdog.timer"
            run_script_mock.return_value = subprocess.CompletedProcess(
                args=["bash", "scripts/deploy_hidden_server.sh"],
                returncode=0,
                stdout="ok",
                stderr="",
            )

            _install_hidden_server(Path("/tmp/repo"), state)

        env = run_script_mock.call_args.args[1]
        self.assertEqual(env["TWOMAN_SERVER_HOST"], "198.51.100.25")
        self.assertEqual(env["TWOMAN_SERVER_PORT"], "5522")
        self.assertEqual(env["TWOMAN_AGENT_SERVICE_NAME"], "twoman-node.service")
        self.assertEqual(env["TWOMAN_WATCHDOG_SERVICE_NAME"], "twoman-node-watchdog.service")
        self.assertEqual(env["TWOMAN_WATCHDOG_TIMER_NAME"], "twoman-node-watchdog.timer")

    @patch("twoman_control.installer._run_script")
    def test_purge_host_bridge_uses_bridge_script(self, run_script_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = _sample_state(Path(temp_dir))
            state.backend = BACKEND_BRIDGE
            run_script_mock.return_value = subprocess.CompletedProcess(
                args=["bash", "scripts/purge_host_bridge.sh"],
                returncode=0,
                stdout="ok",
                stderr="",
            )

            _purge_host(Path("/tmp/repo"), state)

        script_path = run_script_mock.call_args.args[0]
        env = run_script_mock.call_args.args[1]
        self.assertEqual(script_path, Path("/tmp/repo/scripts/purge_host_bridge.sh"))
        self.assertEqual(env["TWOMAN_PUBLIC_BASE_PATH"], "/sahar-honar-221b/payesh-asnad")

    @patch("twoman_control.installer._run_script")
    def test_purge_hidden_server_passes_service_names(self, run_script_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = _sample_state(Path(temp_dir))
            run_script_mock.return_value = subprocess.CompletedProcess(
                args=["bash", "scripts/purge_hidden_server_local.sh"],
                returncode=0,
                stdout="ok",
                stderr="",
            )

            _purge_local_hidden_server(Path("/tmp/repo"), state)

        script_path = run_script_mock.call_args.args[0]
        env = run_script_mock.call_args.args[1]
        self.assertEqual(script_path, Path("/tmp/repo/scripts/purge_hidden_server_local.sh"))
        self.assertEqual(env["TWOMAN_AGENT_SERVICE_NAME"], "twoman-agent.service")
        self.assertEqual(env["TWOMAN_WATCHDOG_SERVICE_NAME"], "twoman-agent-watchdog.service")
        self.assertEqual(env["TWOMAN_WATCHDOG_TIMER_NAME"], "twoman-agent-watchdog.timer")

    @patch("twoman_control.installer._purge_local_hidden_server")
    @patch("twoman_control.installer._purge_host")
    def test_purge_installation_removes_state_by_default(self, purge_host_mock, purge_hidden_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            control_root = Path(temp_dir)
            state = _sample_state(control_root)
            state.instance_name = "bridge"
            state.backend = BACKEND_BRIDGE
            state.save(state_path(control_root, "bridge"))
            registry = load_registry(control_root)
            registry.default_instance = "bridge"
            registry.upsert(managed_instance_from_state(control_root, state))
            registry.save(control_root / "instances.json")

            purged = purge_installation(control_root, "bridge")

            self.assertEqual(purged.instance_name, "bridge")
            with self.assertRaises(Exception):
                load_instance_state(control_root, "bridge")
            purge_host_mock.assert_called_once()
            purge_hidden_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from twoman_control.manager import ManagerController


class TwomanServerManagerTests(unittest.TestCase):
    @staticmethod
    def _controller(
        *,
        host: str = "",
        password: str = "",
        ssh_key: str = "",
    ) -> ManagerController:
        controller = ManagerController.__new__(ManagerController)
        controller.state = SimpleNamespace(
            instance_name="node",
            hidden_server_host=host,
            hidden_server_port=5522,
            hidden_server_user="root",
            hidden_server_password=password,
            hidden_server_ssh_key=ssh_key,
            hidden_service_name="twoman-agent-node.service",
            watchdog_service_name="twoman-agent-node-watchdog.service",
            watchdog_timer_name="twoman-agent-node-watchdog.timer",
        )
        return controller

    def test_reconfigure_and_purge_commands_use_server_launcher(self) -> None:
        controller = self._controller()

        self.assertEqual(controller.install_command(), ["/usr/local/bin/twoman-server", "install", "--instance", "node"])
        self.assertEqual(controller.purge_command(), ["/usr/local/bin/twoman-server", "purge", "--instance", "node"])

    def test_local_hidden_command_is_not_wrapped_in_ssh(self) -> None:
        controller = self._controller()

        command, command_env = controller._hidden_command(["systemctl", "is-active", "twoman-agent.service"])

        self.assertEqual(command, ["systemctl", "is-active", "twoman-agent.service"])
        self.assertIsNone(command_env)

    def test_remote_hidden_command_uses_password_environment(self) -> None:
        controller = self._controller(host="198.51.100.25", password="server-secret")

        command, command_env = controller._hidden_command(
            ["systemctl", "is-active", "twoman-agent-node.service"]
        )

        self.assertEqual(command[:4], ["sshpass", "-e", "ssh", "-p"])
        self.assertIn("5522", command)
        self.assertIn("ConnectTimeout=10", command)
        self.assertEqual(command[-2], "root@198.51.100.25")
        self.assertEqual(command[-1], "systemctl is-active twoman-agent-node.service")
        self.assertNotIn("server-secret", command)
        self.assertEqual(command_env["SSHPASS"], "server-secret")

    def test_remote_hidden_command_uses_key_and_batch_mode(self) -> None:
        controller = self._controller(host="hidden.example", ssh_key="/keys/twoman_ed25519")

        command, command_env = controller._hidden_command(
            ["journalctl", "-u", "twoman-agent-node.service", "-n", "120", "--no-pager"]
        )

        self.assertEqual(command[0], "ssh")
        self.assertIn("/keys/twoman_ed25519", command)
        self.assertIn("BatchMode=yes", command)
        self.assertEqual(command[-2], "root@hidden.example")
        self.assertIsNone(command_env)

    @patch.object(ManagerController, "_run")
    def test_restart_agent_runs_on_remote_hidden_server(self, run_mock) -> None:
        controller = self._controller(host="198.51.100.25", password="server-secret")

        controller.restart_agent()

        command = run_mock.call_args.args[0]
        command_env = run_mock.call_args.kwargs["env"]
        self.assertEqual(command[-2], "root@198.51.100.25")
        self.assertEqual(command[-1], "systemctl restart twoman-agent-node.service")
        self.assertEqual(command_env["SSHPASS"], "server-secret")


if __name__ == "__main__":
    unittest.main()

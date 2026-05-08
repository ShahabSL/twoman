from __future__ import annotations

import unittest
from types import SimpleNamespace

from twoman_control.manager import ManagerController


class TwomanServerManagerTests(unittest.TestCase):
    def test_reconfigure_and_purge_commands_use_server_launcher(self) -> None:
        controller = ManagerController.__new__(ManagerController)
        controller.state = SimpleNamespace(instance_name="node")

        self.assertEqual(controller.install_command(), ["/usr/local/bin/twoman-server", "install", "--instance", "node"])
        self.assertEqual(controller.purge_command(), ["/usr/local/bin/twoman-server", "purge", "--instance", "node"])


if __name__ == "__main__":
    unittest.main()

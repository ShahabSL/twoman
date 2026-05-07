import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_watchdog_module():
    module_path = ROOT / "hidden_server" / "agent_watchdog.py"
    spec = importlib.util.spec_from_file_location("agent_watchdog", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_watchdog_restarts_at_default_close_wait_threshold(monkeypatch):
    watchdog = load_watchdog_module()
    restarts = []

    monkeypatch.setattr(sys, "argv", ["agent_watchdog.py", "--service", "twoman-agent.service"])
    monkeypatch.setattr(watchdog, "service_active_state", lambda service: "active")
    monkeypatch.setattr(watchdog, "service_main_pid", lambda service: 1234)
    monkeypatch.setattr(watchdog, "fd_count", lambda pid: 32)
    monkeypatch.setattr(watchdog, "close_wait_count", lambda pid: 256)
    monkeypatch.setattr(
        watchdog,
        "restart_service",
        lambda service, reason, details: restarts.append((service, reason, details)),
    )

    watchdog.main()

    assert restarts == [("twoman-agent.service", "close-wait-threshold", 256)]

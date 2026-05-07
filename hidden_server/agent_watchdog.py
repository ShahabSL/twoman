#!/usr/bin/env python3

import argparse
import os
import subprocess
import sys


def run_output(command):
    return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT).strip()


def service_main_pid(service_name):
    output = run_output(["systemctl", "show", "-p", "MainPID", "--value", service_name])
    pid = int(output or "0")
    return pid if pid > 1 else 0


def service_active_state(service_name):
    return run_output(["systemctl", "is-active", service_name])


def fd_count(pid):
    return len(os.listdir("/proc/%d/fd" % int(pid)))


def close_wait_count(pid):
    try:
        output = run_output(["ss", "-tanp"])
    except subprocess.CalledProcessError as error:
        output = error.output or ""
    target = "pid=%d," % int(pid)
    return sum(1 for line in output.splitlines() if "CLOSE-WAIT" in line and target in line)


def restart_service(service_name, reason, details):
    sys.stderr.write("[watchdog] restart %s reason=%s details=%s\n" % (service_name, reason, details))
    sys.stderr.flush()
    subprocess.check_call(["systemctl", "restart", service_name])


def main():
    parser = argparse.ArgumentParser(description="Twoman agent watchdog")
    parser.add_argument("--service", default="twoman-agent.service")
    parser.add_argument(
        "--fd-threshold",
        type=int,
        default=int(os.environ.get("TWOMAN_WATCHDOG_FD_THRESHOLD", "16384")),
    )
    parser.add_argument(
        "--close-wait-threshold",
        type=int,
        default=int(os.environ.get("TWOMAN_WATCHDOG_CLOSE_WAIT_THRESHOLD", "256")),
    )
    args = parser.parse_args()

    state = service_active_state(args.service)
    if state != "active":
        restart_service(args.service, "inactive", state)
        return

    pid = service_main_pid(args.service)
    if pid < 2:
        restart_service(args.service, "missing-pid", pid)
        return

    current_fd_count = fd_count(pid)
    if current_fd_count >= args.fd_threshold:
        restart_service(args.service, "fd-threshold", current_fd_count)
        return

    current_close_wait_count = close_wait_count(pid)
    if current_close_wait_count >= args.close_wait_threshold:
        restart_service(args.service, "close-wait-threshold", current_close_wait_count)
        return

    sys.stderr.write(
        "[watchdog] ok service=%s pid=%s open_fds=%s close_wait=%s\n"
        % (args.service, pid, current_fd_count, current_close_wait_count)
    )
    sys.stderr.flush()


if __name__ == "__main__":
    main()

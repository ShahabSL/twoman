#!/usr/bin/env python3
"""Benchmark the live Twoman Go path and host ingress ceiling.

The script intentionally keeps secrets out of its output. Credentials are only
used for cPanel config discovery and SSH deployment/restarts.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


def run(args: list[str], *, env: dict[str, str] | None = None, timeout: float | None = None, cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd),
        env=env,
        timeout=timeout,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def sshpass_env(password: str) -> dict[str, str]:
    env = os.environ.copy()
    env["SSHPASS"] = password
    return env


def parse_server_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    positional: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
        else:
            positional.append(line.strip().strip("'\""))
    if positional and not values:
        values["ip"] = positional[0]
        if len(positional) >= 3 and positional[1].isdigit():
            values["port"] = positional[1]
            values["password"] = positional[2]
            values["user"] = "root"
        elif len(positional) >= 3:
            values["user"] = positional[1]
            values["password"] = positional[2]
            values["port"] = "22"
        else:
            raise SystemExit(f"server env positional format must be ip/user/password or ip/port/password: {path}")
    values.setdefault("user", "root")
    values.setdefault("port", "22")
    required = {"ip", "password", "port", "user"}
    missing = required - values.keys()
    if missing:
        raise SystemExit(f"server env missing required keys: {', '.join(sorted(missing))}")
    return values


def cpanel_json(base_url: str, username: str, password: str, endpoint: str, params: dict[str, str]) -> dict[str, Any]:
    args = [
        "curl",
        "-sk",
        "-L",
        "--connect-timeout",
        "15",
        "--max-time",
        "45",
        "--user",
        f"{username}:{password}",
        "--get",
    ]
    for key, value in params.items():
        args.extend(["--data-urlencode", f"{key}={value}"])
    args.append(f"{base_url.rstrip('/')}/execute/{endpoint}")
    proc = run(args, timeout=60)
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"cPanel returned non-JSON for {endpoint}: {proc.stdout[:200]!r}") from exc
    if payload.get("status") not in (1, "1", True):
        raise RuntimeError(f"cPanel {endpoint} failed: {payload.get('errors') or payload}")
    return payload


def load_host_config(base_url: str, username: str, password: str, home: str, node_dir: str) -> dict[str, Any]:
    remote_dir = node_dir if node_dir.startswith("/") else f"{home.rstrip('/')}/{node_dir.strip('/')}"
    payload = cpanel_json(
        base_url,
        username,
        password,
        "Fileman/get_file_content",
        {"dir": remote_dir, "file": "config.json"},
    )
    content = (payload.get("data") or {}).get("content")
    if not content:
        raise RuntimeError(f"empty cPanel config content for {remote_dir}/config.json")
    config = json.loads(content)
    if not config.get("client_tokens") or not config.get("agent_tokens"):
        raise RuntimeError("host config has no client_tokens/agent_tokens")
    return config


class SSH:
    def __init__(self, server: dict[str, str]) -> None:
        self.host = server["ip"]
        self.user = server.get("user") or "root"
        self.password = server["password"]
        self.port = server["port"]
        self.known_hosts_file = os.environ.get("TWOMAN_SSH_USER_KNOWN_HOSTS_FILE", "")

    def run(self, command: str, *, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
        args = [
            "sshpass",
            "-e",
            "ssh",
            "-p",
            self.port,
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ConnectTimeout=15",
        ]
        if self.known_hosts_file:
            args.extend(["-o", f"UserKnownHostsFile={self.known_hosts_file}"])
        args.extend([f"{self.user}@{self.host}", command])
        return run(args, env=sshpass_env(self.password), timeout=timeout)


def adaptive_upload_config(args: argparse.Namespace) -> dict[str, Any] | None:
    if not args.adaptive_upload:
        return None
    config: dict[str, Any] = {"enabled": True, "lanes": ["data"]}
    for key, value in {
        "min_workers": args.adaptive_min_workers,
        "initial_workers": args.adaptive_initial_workers,
        "max_workers": args.adaptive_max_workers,
        "min_batch_bytes": args.adaptive_min_batch_bytes,
        "max_batch_bytes": args.adaptive_max_batch_bytes,
        "increase_after_successes": args.adaptive_increase_after_successes,
        "decrease_after_errors": args.adaptive_decrease_after_errors,
        "backlog_threshold_frames": args.adaptive_backlog_threshold_frames,
    }.items():
        if value > 0:
            config[key] = value
    if args.adaptive_decision_interval_seconds >= 0:
        config["decision_interval_seconds"] = args.adaptive_decision_interval_seconds
    return config


def deploy_go_agent(args: argparse.Namespace, server: dict[str, str], host_config: dict[str, Any]) -> None:
    env = os.environ.copy()
    env.update(
        {
            "TWOMAN_SERVER_HOST": server["ip"],
            "TWOMAN_SERVER_USER": server.get("user") or "root",
            "TWOMAN_SERVER_PORT": server["port"],
            "TWOMAN_SERVER_PASSWORD": server["password"],
            "TWOMAN_BROKER_BASE_URL": args.broker_base_url,
            "TWOMAN_AGENT_TOKEN": host_config["agent_tokens"][0],
            "TWOMAN_AGENT_PEER_ID": host_config.get("preferred_agent_peer_label") or "agent-main",
            "TWOMAN_DATA_UP_WORKERS": "2",
            "TWOMAN_DATA_UP_MAX_BATCH_BYTES": "131072",
            "TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS": "0.006",
            "TWOMAN_ADAPTIVE_UPLOAD_ENABLED": "true" if args.adaptive_upload else "false",
            "TWOMAN_ADAPTIVE_UPLOAD_MIN_WORKERS": str(args.adaptive_min_workers),
            "TWOMAN_ADAPTIVE_UPLOAD_INITIAL_WORKERS": str(args.adaptive_initial_workers),
            "TWOMAN_ADAPTIVE_UPLOAD_MAX_WORKERS": str(args.adaptive_max_workers),
            "TWOMAN_ADAPTIVE_UPLOAD_MIN_BATCH_BYTES": str(args.adaptive_min_batch_bytes),
            "TWOMAN_ADAPTIVE_UPLOAD_MAX_BATCH_BYTES": str(args.adaptive_max_batch_bytes),
            "TWOMAN_ADAPTIVE_UPLOAD_INCREASE_AFTER_SUCCESSES": str(args.adaptive_increase_after_successes),
            "TWOMAN_ADAPTIVE_UPLOAD_DECREASE_AFTER_ERRORS": str(args.adaptive_decrease_after_errors),
            "TWOMAN_ADAPTIVE_UPLOAD_BACKLOG_THRESHOLD_FRAMES": str(args.adaptive_backlog_threshold_frames),
            "TWOMAN_ADAPTIVE_UPLOAD_DECISION_INTERVAL_SECONDS": str(args.adaptive_decision_interval_seconds),
            "TWOMAN_TRACE": "0",
            "TWOMAN_AUTO_WIREPROXY": "true",
        }
    )
    print("deploy: updating Go agent binary/config")
    proc = subprocess.run(
        ["bash", "scripts/deploy_hidden_server.sh"],
        cwd=str(ROOT),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=True,
        timeout=300,
    )
    for line in proc.stdout.splitlines():
        if "password" not in line.lower() and "token" not in line.lower():
            print(f"deploy: {line}")


def set_remote_agent_variant(
    ssh: SSH,
    config_path: str,
    service_name: str,
    workers: int,
    batch: int,
    flush_delay: float,
    agent_down_parallelism: int = 0,
    adaptive_upload: dict[str, Any] | None = None,
) -> None:
    adaptive_json = json.dumps(adaptive_upload or {})
    script = f"""
set -euo pipefail
python3 - <<'PY'
import json
path = {json.dumps(config_path)}
adaptive = json.loads({json.dumps(adaptive_json)})
with open(path, "r", encoding="utf-8") as handle:
    cfg = json.load(handle)
cfg.setdefault("upload_profiles", {{}}).setdefault("data", {{}})
cfg["upload_profiles"]["data"]["max_batch_bytes"] = {batch}
cfg["upload_profiles"]["data"]["flush_delay_seconds"] = {flush_delay}
cfg.setdefault("up_workers", {{}})["data"] = {workers}
if {agent_down_parallelism} > 0:
    cfg.setdefault("down_parallelism", {{}})["data"] = {agent_down_parallelism}
if adaptive:
    cfg["adaptive_upload"] = adaptive
else:
    cfg.pop("adaptive_upload", None)
with open(path, "w", encoding="utf-8") as handle:
    json.dump(cfg, handle, indent=2)
    handle.write("\\n")
PY
systemctl restart {shlex.quote(service_name)}
systemctl is-active {shlex.quote(service_name)}
"""
    proc = ssh.run(script, timeout=45)
    if "active" not in proc.stdout:
        raise RuntimeError(f"agent did not restart cleanly: {proc.stdout} {proc.stderr}")
    time.sleep(4.0)


def remote_raw_upload_matrix(ssh: SSH, broker_base_url: str, token: str, size_bytes: int, concurrencies: list[int], proxy_url: str) -> list[dict[str, Any]]:
    payload = {
        "url": f"{broker_base_url.rstrip('/')}/upload_probe",
        "token": token,
        "size_bytes": size_bytes,
        "concurrencies": concurrencies,
        "proxy_url": proxy_url,
    }
    remote = r"""
import json, os, subprocess, sys, tempfile, time

payload = json.load(sys.stdin)
body_path = "/tmp/twoman-upload-probe.bin"
with open(body_path, "wb") as handle:
    handle.truncate(int(payload["size_bytes"]))

results = []
for concurrency in payload["concurrencies"]:
    procs = []
    started = time.monotonic()
    for _ in range(int(concurrency)):
        command = [
            "curl", "-sk",
            "--connect-timeout", "20", "--max-time", "180",
            "-H", "Authorization: Bearer " + payload["token"],
            "--data-binary", "@" + body_path,
            "-o", "/dev/null",
            "-w", "%{http_code} %{time_total} %{speed_upload}",
        ]
        if payload.get("proxy_url"):
            command.extend(["--proxy", payload["proxy_url"]])
        command.append(payload["url"])
        procs.append(subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
    samples = []
    ok = 0
    for proc in procs:
        out, err = proc.communicate(timeout=210)
        fields = out.strip().split()
        sample = {"returncode": proc.returncode, "stderr": err[-200:]}
        if len(fields) == 3:
            sample.update({"http_code": fields[0], "time_total": float(fields[1]), "speed_upload": float(fields[2])})
            if proc.returncode == 0 and fields[0].startswith("2"):
                ok += 1
        samples.append(sample)
    wall = time.monotonic() - started
    results.append({
        "concurrency": int(concurrency),
        "ok": ok,
        "total": len(samples),
        "bytes": int(payload["size_bytes"]) * ok,
        "wall_seconds": wall,
        "aggregate_Bps": (int(payload["size_bytes"]) * ok / wall) if wall > 0 else 0.0,
        "samples": samples,
    })
print(json.dumps(results))
"""
    command = "python3 -c " + shlex.quote(remote)
    ssh_args = [
        "sshpass",
        "-e",
        "ssh",
        "-p",
        ssh.port,
        "-o",
        "StrictHostKeyChecking=no",
    ]
    if ssh.known_hosts_file:
        ssh_args.extend(["-o", f"UserKnownHostsFile={ssh.known_hosts_file}"])
    ssh_args.extend([f"{ssh.user}@{ssh.host}", command])
    proc = subprocess.run(
        ssh_args,
        input=json.dumps(payload),
        env=sshpass_env(ssh.password),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        timeout=max(300, 240 * len(concurrencies)),
    )
    return json.loads(proc.stdout)


def build_local_go_binary(tmp_dir: Path) -> Path:
    binary = tmp_dir / "twoman-helper-agent"
    run(["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", str(binary), "."], cwd=ROOT / "helper-agent", timeout=120)
    return binary


def wait_for_listen_state(path: Path, timeout: float = 20.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if int(payload.get("http_port", 0)) > 0:
                return payload
        except (OSError, json.JSONDecodeError, ValueError):
            pass
        time.sleep(0.2)
    raise TimeoutError(f"timed out waiting for {path}")


def start_helper(
    binary: Path,
    tmp_dir: Path,
    broker_base_url: str,
    client_token: str,
    peer: str,
    target_agent_peer_label: str,
    helper_workers: int = 0,
    helper_batch: int = 0,
    helper_down_parallelism: int = 0,
    helper_flush_delay: float = 0.006,
    adaptive_upload: dict[str, Any] | None = None,
) -> tuple[subprocess.Popen[str], int, Path]:
    listen_state = tmp_dir / f"{peer}-listen.json"
    config_path = tmp_dir / f"{peer}.json"
    config = {
        "transport": "http",
        "transport_profile": "auto",
        "broker_base_url": broker_base_url,
        "client_token": client_token,
        "target_agent_peer_label": target_agent_peer_label,
        "auth_mode": "bearer",
        "legacy_custom_headers_enabled": False,
        "binary_media_type": "image/webp",
        "route_template": "/{lane}/{direction}",
        "health_template": "/health",
        "peer_id": peer,
        "listen_host": "127.0.0.1",
        "http_listen_port": 0,
        "socks_listen_port": 0,
        "listen_state_path": str(listen_state),
        "http_timeout_seconds": 30,
        "heartbeat_interval_seconds": 15,
        "flush_delay_seconds": 0.01,
        "verify_tls": True,
    }
    if helper_workers > 0:
        config["up_workers"] = {"data": helper_workers}
    if helper_down_parallelism > 0:
        config["down_parallelism"] = {"data": helper_down_parallelism}
    if helper_batch > 0:
        config["upload_profiles"] = {
            "data": {
                "max_batch_bytes": helper_batch,
                "flush_delay_seconds": helper_flush_delay,
            }
        }
    if adaptive_upload:
        config["adaptive_upload"] = adaptive_upload
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    log_path = tmp_dir / f"{peer}.log"
    log = log_path.open("w", encoding="utf-8")
    proc = subprocess.Popen(
        [str(binary), "--mode", "helper", "--config", str(config_path)],
        cwd=str(tmp_dir),
        text=True,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    try:
        state = wait_for_listen_state(listen_state)
        return proc, int(state["http_port"]), log_path
    except Exception:
        proc.terminate()
        raise


def stop_process(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def curl_download_via_helper(port: int, url: str, max_time: int) -> dict[str, Any]:
    command = [
        "curl",
        "--silent",
        "--show-error",
        "--proxy",
        f"http://127.0.0.1:{port}",
        "--output",
        "/dev/null",
        "--connect-timeout",
        "30",
        "--max-time",
        str(max_time),
        "--write-out",
        "%{http_code} %{time_total} %{speed_download}",
        url,
    ]
    try:
        proc = subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max_time + 20,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "returncode": None,
            "timeout": True,
            "stderr": (exc.stderr or "")[-300:] if isinstance(exc.stderr, str) else "",
            "stdout": (exc.stdout or "")[-300:] if isinstance(exc.stdout, str) else "",
        }
    fields = proc.stdout.strip().split()
    result: dict[str, Any] = {"returncode": proc.returncode, "stderr": proc.stderr[-300:]}
    if len(fields) == 3:
        result.update({"http_code": fields[0], "time_total": float(fields[1]), "speed_download": float(fields[2])})
    result["ok"] = proc.returncode == 0 and result.get("http_code", "").startswith("2")
    return result


def curl_upload_via_helper(port: int, url: str, body_path: Path, max_time: int) -> dict[str, Any]:
    command = [
        "curl",
        "--silent",
        "--show-error",
        "--proxy",
        f"http://127.0.0.1:{port}",
        "--request",
        "POST",
        "--data-binary",
        f"@{body_path}",
        "--output",
        "/dev/null",
        "--connect-timeout",
        "30",
        "--max-time",
        str(max_time),
        "--write-out",
        "%{http_code} %{time_total} %{speed_upload}",
        url,
    ]
    try:
        proc = subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max_time + 20,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "returncode": None,
            "timeout": True,
            "stderr": (exc.stderr or "")[-300:] if isinstance(exc.stderr, str) else "",
            "stdout": (exc.stdout or "")[-300:] if isinstance(exc.stdout, str) else "",
        }
    fields = proc.stdout.strip().split()
    result: dict[str, Any] = {"returncode": proc.returncode, "stderr": proc.stderr[-300:]}
    if len(fields) == 3:
        result.update({"http_code": fields[0], "time_total": float(fields[1]), "speed_upload": float(fields[2])})
    result["ok"] = proc.returncode == 0 and result.get("http_code", "").startswith("2")
    return result


def tunnel_variant(
    binary: Path,
    tmp_dir: Path,
    broker_base_url: str,
    client_token: str,
    target_agent_peer_label: str,
    agent_workers: int,
    agent_batch: int,
    helper_workers: int,
    helper_batch: int,
    agent_down_parallelism: int,
    helper_down_parallelism: int,
    bytes_count: int,
    download_url: str,
    upload_url: str,
    adaptive_upload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    peer = (
        f"bench-helper-aw{agent_workers}-ab{agent_batch}"
        f"-hw{helper_workers}-hb{helper_batch}"
        f"-ad{agent_down_parallelism}-hd{helper_down_parallelism}-{int(time.time())}"
    )
    proc, port, log_path = start_helper(
        binary,
        tmp_dir,
        broker_base_url,
        client_token,
        peer,
        target_agent_peer_label,
        helper_workers,
        helper_batch,
        helper_down_parallelism,
        adaptive_upload=adaptive_upload,
    )
    try:
        upload_body = tmp_dir / f"{peer}-upload.bin"
        with upload_body.open("wb") as handle:
            handle.truncate(bytes_count)
        warmup_url = f"https://speed.cloudflare.com/__down?bytes={min(1_000_000, bytes_count)}"
        warmup = curl_download_via_helper(port, warmup_url, 90)
        download_sample = curl_download_via_helper(port, download_url, 240)
        upload_sample = curl_upload_via_helper(port, upload_url, upload_body, 240)
        return {
            "workers": agent_workers,
            "batch_bytes": agent_batch,
            "agent_workers": agent_workers,
            "agent_batch_bytes": agent_batch,
            "helper_workers": helper_workers,
            "helper_batch_bytes": helper_batch,
            "agent_down_parallelism": agent_down_parallelism,
            "helper_down_parallelism": helper_down_parallelism,
            "adaptive_upload": adaptive_upload or {},
            "bytes": bytes_count,
            "warmup": warmup,
            "sample": download_sample,
            "download_sample": download_sample,
            "upload_sample": upload_sample,
            "helper_log": str(log_path),
        }
    finally:
        stop_process(proc)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-env", default=os.environ.get("TWOMAN_SERVER_ENV", ""))
    parser.add_argument("--cpanel-base-url", default=os.environ.get("TWOMAN_CPANEL_BASE_URL", ""))
    parser.add_argument("--cpanel-username", default=os.environ.get("TWOMAN_CPANEL_USERNAME", ""))
    parser.add_argument("--cpanel-password", default=os.environ.get("TWOMAN_CPANEL_PASSWORD", ""))
    parser.add_argument("--cpanel-home", default="")
    parser.add_argument("--node-dir", default="parvaneh_node")
    parser.add_argument("--broker-base-url", default=os.environ.get("TWOMAN_BROKER_BASE_URL", ""))
    parser.add_argument("--client-token", default=os.environ.get("TWOMAN_CLIENT_TOKEN", ""))
    parser.add_argument("--agent-token", default=os.environ.get("TWOMAN_AGENT_TOKEN", ""))
    parser.add_argument("--target-agent-peer-label", default="")
    parser.add_argument("--skip-deploy", action="store_true")
    parser.add_argument("--skip-raw", action="store_true")
    parser.add_argument("--skip-tunnel", action="store_true")
    parser.add_argument("--raw-upload-bytes", type=int, default=5_000_000)
    parser.add_argument("--tunnel-bytes", type=int, default=15_000_000)
    parser.add_argument("--download-url", default="")
    parser.add_argument("--upload-url", default="https://speed.cloudflare.com/__up")
    parser.add_argument("--variants", default="")
    parser.add_argument("--helper-workers", type=int, default=0)
    parser.add_argument("--helper-batch-bytes", type=int, default=0)
    parser.add_argument("--agent-down-parallelism", type=int, default=0)
    parser.add_argument("--helper-down-parallelism", type=int, default=0)
    parser.add_argument("--adaptive-upload", action="store_true")
    parser.add_argument("--adaptive-min-workers", type=int, default=0)
    parser.add_argument("--adaptive-initial-workers", type=int, default=0)
    parser.add_argument("--adaptive-max-workers", type=int, default=0)
    parser.add_argument("--adaptive-min-batch-bytes", type=int, default=0)
    parser.add_argument("--adaptive-max-batch-bytes", type=int, default=0)
    parser.add_argument("--adaptive-increase-after-successes", type=int, default=16)
    parser.add_argument("--adaptive-decrease-after-errors", type=int, default=1)
    parser.add_argument("--adaptive-backlog-threshold-frames", type=int, default=128)
    parser.add_argument("--adaptive-decision-interval-seconds", type=float, default=2.0)
    parser.add_argument("--raw-concurrency", default="1,2,3,4,6,8")
    parser.add_argument("--raw-upload-proxy-url", default="socks5h://127.0.0.1:1280")
    parser.add_argument("--remote-agent-config", default="/opt/twoman/config.json")
    parser.add_argument("--remote-agent-service", default="twoman-agent.service")
    parser.add_argument("--output-dir", default="output")
    args = parser.parse_args()
    if not args.server_env:
        raise SystemExit("--server-env or TWOMAN_SERVER_ENV is required")
    if not args.broker_base_url:
        raise SystemExit("--broker-base-url or TWOMAN_BROKER_BASE_URL is required")
    server = parse_server_env(ROOT / args.server_env)
    if args.client_token and args.agent_token:
        host_config = {"client_tokens": [args.client_token], "agent_tokens": [args.agent_token]}
    else:
        for name in ("cpanel_base_url", "cpanel_username", "cpanel_password"):
            if not getattr(args, name):
                raise SystemExit(
                    f"--{name.replace('_', '-')} or TWOMAN_{name.upper()} is required when explicit tokens are not provided"
                )
        home = args.cpanel_home or f"/home/{args.cpanel_username}"
        host_config = load_host_config(args.cpanel_base_url, args.cpanel_username, args.cpanel_password, home, args.node_dir)
    client_token = host_config["client_tokens"][0]
    ssh = SSH(server)
    adaptive_upload = adaptive_upload_config(args)

    if not args.skip_deploy:
        deploy_go_agent(args, server, host_config)

    tmp_dir = Path(tempfile.mkdtemp(prefix="twoman-live-ceiling-", dir=str(ROOT / "tests")))
    output_dir = ROOT / args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)
    result: dict[str, Any] = {
        "started_utc": started.isoformat(),
        "broker_base_url": args.broker_base_url,
        "node_dir": args.node_dir,
        "raw_upload_bytes_per_request": args.raw_upload_bytes,
        "tunnel_bytes_per_request": args.tunnel_bytes,
        "download_url": args.download_url or f"https://speed.cloudflare.com/__down?bytes={args.tunnel_bytes}",
        "upload_url": args.upload_url,
        "raw_upload_proxy_url": args.raw_upload_proxy_url or "direct",
        "remote_agent_config": args.remote_agent_config,
        "remote_agent_service": args.remote_agent_service,
        "adaptive_upload": adaptive_upload or {},
        "raw_upload": [],
        "tunnel": [],
    }

    try:
        binary = build_local_go_binary(tmp_dir)

        raw_results = []
        if not args.skip_raw:
            raw_route = args.raw_upload_proxy_url or "direct"
            print(f"raw: server -> host upload_probe route={raw_route}")
            raw_results = remote_raw_upload_matrix(
                ssh,
                args.broker_base_url,
                client_token,
                args.raw_upload_bytes,
                [int(item) for item in args.raw_concurrency.split(",") if item.strip()],
                args.raw_upload_proxy_url,
            )
            result["raw_upload"] = raw_results
            for row in raw_results:
                print(
                    "raw:"
                    f" concurrency={row['concurrency']}"
                    f" ok={row['ok']}/{row['total']}"
                    f" aggregate={row['aggregate_Bps'] / 1024 / 1024:.3f} MiB/s"
                    f" wall={row['wall_seconds']:.2f}s"
                )

        if args.variants:
            variants = []
            for raw_variant in args.variants.split(","):
                fields = raw_variant.split(":")
                if len(fields) == 2:
                    agent_workers, agent_batch = fields
                    variants.append((
                        int(agent_workers),
                        int(agent_batch),
                        args.helper_workers,
                        args.helper_batch_bytes,
                        args.agent_down_parallelism,
                        args.helper_down_parallelism,
                    ))
                elif len(fields) == 4:
                    agent_workers, agent_batch, helper_workers, helper_batch = fields
                    variants.append((
                        int(agent_workers),
                        int(agent_batch),
                        int(helper_workers),
                        int(helper_batch),
                        args.agent_down_parallelism,
                        args.helper_down_parallelism,
                    ))
                elif len(fields) == 6:
                    agent_workers, agent_batch, helper_workers, helper_batch, agent_down, helper_down = fields
                    variants.append((
                        int(agent_workers),
                        int(agent_batch),
                        int(helper_workers),
                        int(helper_batch),
                        int(agent_down),
                        int(helper_down),
                    ))
                else:
                    raise SystemExit(
                        "--variants entries must be agentWorkers:agentBatch, "
                        "agentWorkers:agentBatch:helperWorkers:helperBatch, or "
                        "agentWorkers:agentBatch:helperWorkers:helperBatch:agentDown:helperDown"
                    )
        else:
            worker_sweep = [(1, 131072), (2, 131072), (4, 131072), (6, 131072), (8, 524288)]
            batch_sweep = [(4, 65536), (4, 262144), (4, 524288)]
            variants = worker_sweep + batch_sweep
            variants = [
                (
                    workers,
                    batch,
                    args.helper_workers,
                    args.helper_batch_bytes,
                    args.agent_down_parallelism,
                    args.helper_down_parallelism,
                )
                for workers, batch in variants
            ]
        seen: set[tuple[int, int, int, int, int, int]] = set()
        variants = [variant for variant in variants if not (variant in seen or seen.add(variant))]

        if not args.skip_tunnel:
            download_url = args.download_url or f"https://speed.cloudflare.com/__down?bytes={args.tunnel_bytes}"
            for agent_workers, agent_batch, helper_workers, helper_batch, agent_down, helper_down in variants:
                helper_desc = "auto"
                if helper_workers > 0 or helper_batch > 0:
                    helper_desc = f"{helper_workers}:{helper_batch}"
                down_desc = "auto"
                if agent_down > 0 or helper_down > 0:
                    down_desc = f"agent={agent_down or 'auto'} helper={helper_down or 'auto'}"
                print(f"tunnel: agent={agent_workers}:{agent_batch} helper={helper_desc} down={down_desc}")
                set_remote_agent_variant(
                    ssh,
                    args.remote_agent_config,
                    args.remote_agent_service,
                    agent_workers,
                    agent_batch,
                    0.006,
                    agent_down,
                    adaptive_upload,
                )
                sample = tunnel_variant(
                    binary,
                    tmp_dir,
                    args.broker_base_url,
                    client_token,
                    args.target_agent_peer_label,
                    agent_workers,
                    agent_batch,
                    helper_workers,
                    helper_batch,
                    agent_down,
                    helper_down,
                    args.tunnel_bytes,
                    download_url,
                    args.upload_url,
                    adaptive_upload,
                )
                result["tunnel"].append(sample)
                s = sample["sample"]
                up = sample["upload_sample"]
                speed = float(s.get("speed_download") or 0.0)
                upload_speed = float(up.get("speed_upload") or 0.0)
                print(
                    "tunnel:"
                    f" agent={agent_workers}:{agent_batch}"
                    f" helper={helper_desc}"
                    f" down={down_desc}"
                    f" ok={s.get('ok')}"
                    f" http={s.get('http_code')}"
                    f" down={speed / 1024 / 1024:.3f} MiB/s"
                    f" up={upload_speed / 1024 / 1024:.3f} MiB/s"
                    f" time={s.get('time_total')}"
                )

        ok_samples = [row for row in result["tunnel"] if row["sample"].get("ok")]
        if ok_samples:
            best = max(ok_samples, key=lambda row: float(row["sample"].get("speed_download") or 0.0))
            result["best_tunnel"] = {
                "workers": best["workers"],
                "batch_bytes": best["batch_bytes"],
                "agent_workers": best["agent_workers"],
                "agent_batch_bytes": best["agent_batch_bytes"],
                "helper_workers": best["helper_workers"],
                "helper_batch_bytes": best["helper_batch_bytes"],
                "agent_down_parallelism": best["agent_down_parallelism"],
                "helper_down_parallelism": best["helper_down_parallelism"],
                "speed_Bps": best["sample"]["speed_download"],
                "speed_Mbps": best["sample"]["speed_download"] * 8 / 1_000_000,
                "time_total": best["sample"]["time_total"],
            }
        ok_upload_samples = [row for row in result["tunnel"] if row.get("upload_sample", {}).get("ok")]
        if ok_upload_samples:
            best_up = max(ok_upload_samples, key=lambda row: float(row["upload_sample"].get("speed_upload") or 0.0))
            result["best_tunnel_upload"] = {
                "workers": best_up["workers"],
                "batch_bytes": best_up["batch_bytes"],
                "agent_workers": best_up["agent_workers"],
                "agent_batch_bytes": best_up["agent_batch_bytes"],
                "helper_workers": best_up["helper_workers"],
                "helper_batch_bytes": best_up["helper_batch_bytes"],
                "agent_down_parallelism": best_up["agent_down_parallelism"],
                "helper_down_parallelism": best_up["helper_down_parallelism"],
                "speed_Bps": best_up["upload_sample"]["speed_upload"],
                "speed_Mbps": best_up["upload_sample"]["speed_upload"] * 8 / 1_000_000,
                "time_total": best_up["upload_sample"]["time_total"],
            }
        if raw_results:
            best_raw = max(raw_results, key=lambda row: float(row.get("aggregate_Bps") or 0.0))
            result["best_raw_upload"] = {
                "concurrency": best_raw["concurrency"],
                "aggregate_Bps": best_raw["aggregate_Bps"],
                "aggregate_Mbps": best_raw["aggregate_Bps"] * 8 / 1_000_000,
            }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    result["ended_utc"] = datetime.now(timezone.utc).isoformat()
    output_path = output_dir / f"twoman-live-ceiling-{started.strftime('%Y%m%dT%H%M%SZ')}.json"
    output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"result: {output_path}")
    if "best_raw_upload" in result:
        print(f"best_raw_upload: {result['best_raw_upload']}")
    if "best_tunnel" in result:
        print(f"best_tunnel: {result['best_tunnel']}")
    if "best_tunnel_upload" in result:
        print(f"best_tunnel_upload: {result['best_tunnel_upload']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

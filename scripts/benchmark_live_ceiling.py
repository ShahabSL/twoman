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


def parse_server_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    required = {"ip", "password", "port"}
    missing = required - values.keys()
    if missing:
        raise SystemExit(f"server env missing required keys: {', '.join(sorted(missing))}")
    return values


def cpanel_json(base_url: str, username: str, password: str, endpoint: str, params: dict[str, str]) -> dict[str, Any]:
    args = [
        "curl",
        "-sk",
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
        self.password = server["password"]
        self.port = server["port"]

    def run(self, command: str, *, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
        args = [
            "sshpass",
            "-p",
            self.password,
            "ssh",
            "-p",
            self.port,
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ConnectTimeout=15",
            f"root@{self.host}",
            command,
        ]
        return run(args, timeout=timeout)


def deploy_go_agent(args: argparse.Namespace, server: dict[str, str], host_config: dict[str, Any]) -> None:
    env = os.environ.copy()
    env.update(
        {
            "TWOMAN_SERVER_HOST": server["ip"],
            "TWOMAN_SERVER_USER": "root",
            "TWOMAN_SERVER_PORT": server["port"],
            "TWOMAN_SERVER_PASSWORD": server["password"],
            "TWOMAN_BROKER_BASE_URL": args.broker_base_url,
            "TWOMAN_AGENT_TOKEN": host_config["agent_tokens"][0],
            "TWOMAN_AGENT_PEER_ID": host_config.get("preferred_agent_peer_label") or "agent-main",
            "TWOMAN_DATA_UP_WORKERS": "2",
            "TWOMAN_DATA_UP_MAX_BATCH_BYTES": "131072",
            "TWOMAN_DATA_UP_FLUSH_DELAY_SECONDS": "0.006",
            "TWOMAN_TRACE": "0",
            "TWOMAN_AUTO_WIREPROXY": "true",
        }
    )
    print("deploy: updating server2 Go agent binary/config")
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


def set_remote_agent_variant(ssh: SSH, workers: int, batch: int, flush_delay: float) -> None:
    script = f"""
set -euo pipefail
python3 - <<'PY'
import json
path = "/opt/twoman/config.json"
with open(path, "r", encoding="utf-8") as handle:
    cfg = json.load(handle)
cfg.setdefault("upload_profiles", {{}}).setdefault("data", {{}})
cfg["upload_profiles"]["data"]["max_batch_bytes"] = {batch}
cfg["upload_profiles"]["data"]["flush_delay_seconds"] = {flush_delay}
cfg.setdefault("up_workers", {{}})["data"] = {workers}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(cfg, handle, indent=2)
    handle.write("\\n")
PY
systemctl restart twoman-agent.service
systemctl is-active twoman-agent.service
"""
    proc = ssh.run(script, timeout=45)
    if "active" not in proc.stdout:
        raise RuntimeError(f"agent did not restart cleanly: {proc.stdout} {proc.stderr}")
    time.sleep(4.0)


def remote_raw_upload_matrix(ssh: SSH, broker_base_url: str, token: str, size_bytes: int, concurrencies: list[int]) -> list[dict[str, Any]]:
    payload = {
        "url": f"{broker_base_url.rstrip('/')}/upload_probe",
        "token": token,
        "size_bytes": size_bytes,
        "concurrencies": concurrencies,
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
        procs.append(subprocess.Popen([
            "curl", "-sk", "--proxy", "socks5h://127.0.0.1:1280",
            "--connect-timeout", "20", "--max-time", "180",
            "-H", "Authorization: Bearer " + payload["token"],
            "--data-binary", "@" + body_path,
            "-o", "/dev/null",
            "-w", "%{http_code} %{time_total} %{speed_upload}",
            payload["url"],
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
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
    proc = subprocess.run(
        [
            "sshpass",
            "-p",
            ssh.password,
            "ssh",
            "-p",
            ssh.port,
            "-o",
            "StrictHostKeyChecking=no",
            f"root@{ssh.host}",
            command,
        ],
        input=json.dumps(payload),
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


def start_helper(binary: Path, tmp_dir: Path, broker_base_url: str, client_token: str, peer: str) -> tuple[subprocess.Popen[str], int, Path]:
    listen_state = tmp_dir / f"{peer}-listen.json"
    config_path = tmp_dir / f"{peer}.json"
    config = {
        "transport": "http",
        "transport_profile": "auto",
        "broker_base_url": broker_base_url,
        "client_token": client_token,
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
        "max_batch_bytes": 65536,
        "verify_tls": True,
        "upload_profiles": {
            "data": {
                "max_batch_bytes": 65536,
                "flush_delay_seconds": 0.004,
            }
        },
        "up_workers": {"data": 2},
    }
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


def tunnel_variant(binary: Path, tmp_dir: Path, broker_base_url: str, client_token: str, workers: int, batch: int, bytes_count: int, download_url: str) -> dict[str, Any]:
    peer = f"bench-helper-w{workers}-b{batch}-{int(time.time())}"
    proc, port, log_path = start_helper(binary, tmp_dir, broker_base_url, client_token, peer)
    try:
        warmup_url = f"https://speed.cloudflare.com/__down?bytes={min(1_000_000, bytes_count)}"
        warmup = curl_download_via_helper(port, warmup_url, 90)
        sample = curl_download_via_helper(port, download_url, 240)
        return {
            "workers": workers,
            "batch_bytes": batch,
            "bytes": bytes_count,
            "warmup": warmup,
            "sample": sample,
            "helper_log": str(log_path),
        }
    finally:
        stop_process(proc)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-env", default="private_handoff/secrets/server2.env")
    parser.add_argument("--cpanel-base-url", default=os.environ.get("TWOMAN_CPANEL_BASE_URL", ""))
    parser.add_argument("--cpanel-username", default=os.environ.get("TWOMAN_CPANEL_USERNAME", ""))
    parser.add_argument("--cpanel-password", default=os.environ.get("TWOMAN_CPANEL_PASSWORD", ""))
    parser.add_argument("--cpanel-home", default="")
    parser.add_argument("--node-dir", default="parvaneh_node")
    parser.add_argument("--broker-base-url", default="https://mirageclub.ir/parvaneh")
    parser.add_argument("--skip-deploy", action="store_true")
    parser.add_argument("--skip-raw", action="store_true")
    parser.add_argument("--skip-tunnel", action="store_true")
    parser.add_argument("--raw-upload-bytes", type=int, default=5_000_000)
    parser.add_argument("--tunnel-bytes", type=int, default=15_000_000)
    parser.add_argument("--download-url", default="")
    parser.add_argument("--variants", default="")
    parser.add_argument("--raw-concurrency", default="1,2,3,4,6,8")
    parser.add_argument("--output-dir", default="output")
    args = parser.parse_args()
    for name in ("cpanel_base_url", "cpanel_username", "cpanel_password"):
        if not getattr(args, name):
            raise SystemExit(f"--{name.replace('_', '-')} or TWOMAN_{name.upper()} is required")

    server = parse_server_env(ROOT / args.server_env)
    home = args.cpanel_home or f"/home/{args.cpanel_username}"
    host_config = load_host_config(args.cpanel_base_url, args.cpanel_username, args.cpanel_password, home, args.node_dir)
    client_token = host_config["client_tokens"][0]
    ssh = SSH(server)

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
        "raw_upload": [],
        "tunnel": [],
    }

    try:
        binary = build_local_go_binary(tmp_dir)

        raw_results = []
        if not args.skip_raw:
            print("raw: server2+WARP -> host upload_probe")
            raw_results = remote_raw_upload_matrix(
                ssh,
                args.broker_base_url,
                client_token,
                args.raw_upload_bytes,
                [int(item) for item in args.raw_concurrency.split(",") if item.strip()],
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
                worker_text, batch_text = raw_variant.split(":", 1)
                variants.append((int(worker_text), int(batch_text)))
        else:
            worker_sweep = [(1, 131072), (2, 131072), (4, 131072), (6, 131072), (8, 524288)]
            batch_sweep = [(4, 65536), (4, 262144), (4, 524288)]
            variants = worker_sweep + batch_sweep
        seen: set[tuple[int, int]] = set()
        variants = [variant for variant in variants if not (variant in seen or seen.add(variant))]

        if not args.skip_tunnel:
            download_url = args.download_url or f"https://speed.cloudflare.com/__down?bytes={args.tunnel_bytes}"
            for workers, batch in variants:
                print(f"tunnel: workers={workers} batch={batch}")
                set_remote_agent_variant(ssh, workers, batch, 0.006)
                sample = tunnel_variant(binary, tmp_dir, args.broker_base_url, client_token, workers, batch, args.tunnel_bytes, download_url)
                result["tunnel"].append(sample)
                s = sample["sample"]
                speed = float(s.get("speed_download") or 0.0)
                print(
                    "tunnel:"
                    f" workers={workers}"
                    f" batch={batch}"
                    f" ok={s.get('ok')}"
                    f" http={s.get('http_code')}"
                    f" speed={speed / 1024 / 1024:.3f} MiB/s"
                    f" time={s.get('time_total')}"
                )

        ok_samples = [row for row in result["tunnel"] if row["sample"].get("ok")]
        if ok_samples:
            best = max(ok_samples, key=lambda row: float(row["sample"].get("speed_download") or 0.0))
            result["best_tunnel"] = {
                "workers": best["workers"],
                "batch_bytes": best["batch_bytes"],
                "speed_Bps": best["sample"]["speed_download"],
                "speed_Mbps": best["sample"]["speed_download"] * 8 / 1_000_000,
                "time_total": best["sample"]["time_total"],
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

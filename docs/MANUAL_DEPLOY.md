# Manual Deployment

Use this guide when the scripted install path fails or when you want to inspect each step manually.

If you do not need that level of control, start with [docs/EASY_DEPLOY.md](docs/EASY_DEPLOY.md).

## 1. cPanel host

Target layout under your public base path, for example `/home/<user>/public_html/rahkar`:

- `api.php`
- `health.php`
- `app/bootstrap.php`
- `app/bridge_runtime.php`
- `app/config.php`
- `runtime/http_broker_daemon.py`
- `runtime/logs/`
- `storage/`
- `offload/`

### Files to upload

Upload these repo files to the matching host paths:

- `host/public/api.php` -> `<public>/api.php`
- `host/public/health.php` -> `<public>/health.php`
- `host/app/bootstrap.php` -> `<public>/app/bootstrap.php`
- `host/app/bridge_runtime.php` -> `<public>/app/bridge_runtime.php`
- `host/runtime/http_broker_daemon.py` -> `<public>/runtime/http_broker_daemon.py`

### Create host config

Create `<public>/app/config.php` from `host/app/config.sample.php`.

Set at least:

- `storage_path`
- `public_base_path`
- `client_tokens`
- `agent_tokens`
- `bridge_local_port`
- `bridge_max_streams_per_peer_session`
- `bridge_max_open_rate_per_peer_session`
- `bridge_open_rate_window_seconds`
- `bridge_max_peer_buffered_bytes`

Minimal example:

```php
<?php

return [
    'storage_path' => '/home/USER/public_html/rahkar/storage',
    'public_base_path' => '/rahkar',
    'offload_relative_path' => 'offload',
    'offload_ttl_seconds' => 3600,
    'client_tokens' => ['replace-with-client-token'],
    'agent_tokens' => ['replace-with-agent-token'],
    'reverse_keys' => ['unused-public-release-placeholder'],
    'max_request_body_bytes' => 8 * 1024 * 1024,
    'poll_wait_ms' => 20000,
    'reverse_wait_ms' => 45000,
    'poll_sleep_us' => 200000,
    'job_lease_seconds' => 30,
    'bridge_local_port' => 18093,
    'bridge_session_ttl_seconds' => 300,
    'bridge_max_agent_idle_seconds' => 90,
    'bridge_max_streams_per_peer_session' => 256,
    'bridge_max_open_rate_per_peer_session' => 120,
    'bridge_open_rate_window_seconds' => 10,
    'bridge_max_peer_buffered_bytes' => 32 * 1024 * 1024,
];
```

### Start the broker manually

Open:

```text
https://your-host.example/rahkar/api.php?action=health
```

with a valid `Authorization: Bearer ...` token from either the client token or the agent token.

Expected result:

```json
{"ok":true,...}
```

If the broker is not running, `api.php?action=health` will attempt to start it.

Cloudflare note:

- if this public hostname is fronted by a Cloudflare-proxied record, keep the
  same proxied hostname in `broker_base_url`
- Cloudflare can hide the direct origin IP, but it does not remove the public
  host from the Twoman path
- if the hidden server still cannot reliably reach that proxied hostname,
  keep `upstream_proxy_url` enabled on the hidden side

## 2. Hidden server

Copy these files to the hidden server, for example under `/opt/twoman`:

- `twoman-helper-agent` built from `helper-agent/`
- `hidden_server/agent_watchdog.py`
- `hidden_server/install_watchdog.sh`
- `hidden_server/systemd/twoman-agent-watchdog.service`
- `hidden_server/systemd/twoman-agent-watchdog.timer`

### Create hidden-server config

Create `/opt/twoman/config.json` from `hidden_server/config.sample.json`.

Example:

```json
{
  "broker_base_url": "https://your-host.example/api/v1/telemetry",
  "upstream_proxy_url": "socks5h://127.0.0.1:1280",
  "outbound_proxy_url": "socks5h://127.0.0.1:1280",
  "outbound_proxy_label": "wireproxy",
  "agent_token": "replace-with-agent-token",
  "http_timeout_seconds": 30,
  "flush_delay_seconds": 0.01,
  "max_batch_bytes": 65536,
  "upload_profiles": {
    "data": {
      "max_batch_bytes": 131072,
      "flush_delay_seconds": 0.006
    }
  },
  "idle_repoll_delay_seconds": {
    "ctl": 0.05,
    "data": 0.1
  },
  "peer_id": "agent-main",
  "prefer_ipv4": true,
  "disable_ipv6_origin": true,
  "happy_eyeballs_delay_seconds": 0.25,
  "http2_enabled": {
    "ctl": false,
    "data": false
  }
}
```

`upstream_proxy_url` is optional. Set it only when the hidden server must reach
the public host through a local upstream proxy such as `wireproxy`.

`outbound_proxy_url` is optional. Set it when the hidden server should make its
final outbound TCP and DNS traffic through a SOCKS5 or HTTP CONNECT proxy
instead of using the hidden server IP directly.

Use HTTP/1.1 for the hidden-agent control lane by default on the current public
Passenger path. In live validation, `ctl=true` on the hidden agent caused
repeated transport timeouts and stalled client streams, while `ctl=false,
data=false` restored stable end-to-end traffic.

Keep `prefer_ipv4=true` on the hidden agent. On networks where hidden-server
IPv6 egress is unreliable, also set `disable_ipv6_origin=true` so literal IPv6
targets fail fast instead of burning the full open-connect timeout window.

On the public Passenger host, keep `streaming_data_down_helper=false`
and `down_wait_ms={"ctl":250,"data":250}`. That avoids long-lived helper
`data/down` requests monopolizing the Passenger worker while still keeping
latency materially lower than the older `500 ms` polling setting.

Use broker lane profiles close to:

- `ctl`: `4096` bytes / `8` frames / `1ms` / `pad_min 1024`
- `pri`: `32768` bytes / `16` frames / `2ms` / `pad_min 1024`
- `bulk`: `1048576` bytes / `128` frames / `4ms` / `pad_min 0`

### Start agent directly

```bash
/opt/twoman/twoman-helper-agent --mode agent --config /opt/twoman/config.json
```

### Install as a service

Create `/etc/systemd/system/twoman-agent.service`:

```ini
[Unit]
Description=Twoman hidden agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/twoman
Environment=TWOMAN_TRACE=0
ExecStart=/opt/twoman/twoman-helper-agent --mode agent --config /opt/twoman/config.json
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now twoman-agent.service
```

### Install watchdog manually

Update `hidden_server/systemd/twoman-agent-watchdog.service` if your service name differs from `twoman-agent.service`, then:

```bash
sudo install -m 0755 /opt/twoman/agent_watchdog.py /opt/twoman/agent_watchdog.py
sudo install -m 0644 /opt/twoman/twoman-agent-watchdog.service /etc/systemd/system/twoman-agent-watchdog.service
sudo install -m 0644 /opt/twoman/twoman-agent-watchdog.timer /etc/systemd/system/twoman-agent-watchdog.timer
sudo systemctl daemon-reload
sudo systemctl enable --now twoman-agent-watchdog.timer
sudo systemctl start twoman-agent-watchdog.service
```

## 3. Local helper

Create `local_client/config.json` from `local_client/config.sample.json`.

Example:

```json
{
  "broker_base_url": "https://your-host.example/api/v1/telemetry",
  "upstream_proxy_url": "",
  "client_token": "replace-with-client-token",
  "listen_host": "127.0.0.1",
  "http_listen_port": 18092,
  "socks_listen_port": 11092,
  "http_timeout_seconds": 30,
  "flush_delay_seconds": 0.01,
  "max_batch_bytes": 65536,
  "http2_enabled": {
    "ctl": true,
    "data": false
  }
}
```

Run helper with the Go dataplane:

```bash
scripts/start_client.sh local_client/config.json
```

Stop helper:

- foreground run: `Ctrl+C`
- background run: `kill <pid>`

## 4. Verification

Bridge health:

```bash
curl -H 'Authorization: Bearer YOUR_CLIENT_TOKEN' \
  'https://your-host.example/rahkar/api.php?action=health'
```

SOCKS egress:

```bash
curl --socks5-hostname 127.0.0.1:11092 https://api.ipify.org
```

HTTP egress:

```bash
curl --proxy http://127.0.0.1:18092 https://api.ipify.org
```

Expected result:

- the returned IP should be the hidden server when no hidden outbound proxy is configured
- the returned IP should be the configured proxy exit when `outbound_proxy_url` is enabled

## Troubleshooting

If the host script path fails:

- verify file upload permissions in cPanel File Manager
- verify the configured application-server route serves `/health` relative to the public broker base URI
- verify `/bin/python3` exists on the host when using the bridge backend
- verify `api.php?action=health` returns `ok`

If the hidden server fails:

- `systemctl status twoman-agent.service`
- `journalctl -u twoman-agent.service -n 100 --no-pager`
- `systemctl status twoman-agent-watchdog.timer`
- `cat /proc/$(systemctl show -p MainPID --value twoman-agent.service)/limits | grep 'Max open files'`

If the local helper fails:

- verify `go version` works and `helper-agent/` builds
- verify the ports are free:
  - `18092`
  - `11092`
- run the helper directly in the foreground to see the error

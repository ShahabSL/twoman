# Twoman

Twoman is a host-preserving relay for shared cPanel hosting.

Final path:

`app -> local helper -> cPanel host -> localhost broker on the host -> hidden reverse agent -> internet`

The cPanel host stays in the live path. The hidden server performs outbound internet access. The local helper exposes normal HTTP and SOCKS5 proxies so apps like Telegram and browsers can use the system.

Compatibility note:
- the live bridge path remains `/bridge/v2`
- that path name is kept for wire compatibility with existing deployments, not because this repository ships multiple public versions

## Status

This repository contains the current public implementation.

What it is good at:
- Telegram and other lighter interactive traffic
- SOCKS5 and HTTP proxy access through a localhost helper
- Shared-host deployments where the public host must remain in-path

What it is not:
- a full-speed VPN replacement
- a general-purpose high-throughput tunnel on hostile shared hosting

## Repository Layout

- `twoman_protocol.py`: framed protocol and lane definitions
- `twoman_transport.py`: shared public-leg transport
- `local_client/helper.py`: local HTTP + SOCKS5 helper
- `hidden_server/agent.py`: hidden reverse agent
- `host/runtime/http_broker_daemon.py`: asyncio broker for the cPanel host
- `host/app/bridge_runtime.php`: PHP bootstrap that starts and supervises the broker
- `host/public/api.php`: public health/bootstrap endpoint
- `host/twoman.htaccess`: LiteSpeed reverse-proxy rules
- `tests/run_e2e.sh`: local smoke test

## Architecture

Twoman uses:
- external helper lanes: `ctl` + `data`
- external agent lanes: `ctl` + `data`
- internal scheduler classes: `ctl`, `pri`, `bulk`

Key design points:
- helper downlinks are streamed HTTP/1.1 responses
- helper uplinks are bounded POST batches
- the broker assigns agent-side stream IDs and scopes helper streams by session
- public authentication uses bearer tokens in `X-Relay-Token`

More detail: [docs/ARCHITECTURE.md](/home/shahab/dev/hobby/mintm/docs/ARCHITECTURE.md)

## Quick Start

### 1. Configure the host

Copy:
- `host/twoman.htaccess` into your public `/.htaccess`
- `host/public/api.php` into your public Twoman path
- `host/app/bridge_runtime.php`
- `host/app/bootstrap.php`
- `host/runtime/http_broker_daemon.py`

Create `host/app/config.php` from `host/app/config.sample.php` and set:
- `public_base_path`
- `client_tokens`
- `agent_tokens`
- `bridge_local_port`

### 2. Configure the hidden server

Copy `hidden_server/config.sample.json` to `config.json` and set:
- `broker_base_url`
- `agent_token`

Run:

```bash
python3 hidden_server/agent.py --config hidden_server/config.json
```

### 3. Configure the local helper

Copy `local_client/config.sample.json` to `config.json` and set:
- `broker_base_url`
- `client_token`

Run:

```bash
python3 local_client/helper.py --config local_client/config.json
```

Default helper ports:
- HTTP proxy: `127.0.0.1:8080`
- SOCKS5 proxy: `127.0.0.1:1080`

## Requirements

- cPanel host with LiteSpeed `.htaccess` reverse proxy support to `127.0.0.1`
- Python 3 on the host for `host/runtime/http_broker_daemon.py`
- Python 3.9+ recommended for helper and hidden agent
- `pip install -r requirements.txt`

### 4. Verify

Bridge health:

```bash
curl -H 'X-Relay-Token: YOUR_CLIENT_TOKEN' \
  'https://your-host.example/twoman/api.php?action=health'
```

SOCKS egress:

```bash
curl --socks5-hostname 127.0.0.1:1080 https://api.ipify.org
```

HTTP egress:

```bash
curl --proxy http://127.0.0.1:8080 https://api.ipify.org
```

Expected result: the origin IP should be the hidden server, not the local client.

## Development

Run the local smoke test:

```bash
tests/run_e2e.sh
```

Enable verbose tracing temporarily:

```bash
TWOMAN_TRACE=1 python3 hidden_server/agent.py --config hidden_server/config.json
```

Tracing is off by default to avoid log growth on production hosts.

## Operational Notes

- LiteSpeed reverse proxying to `127.0.0.1` is the core shared-host trick.
- The broker is the hot-path component on the cPanel host. PHP is only bootstrap/supervision.
- Browser workloads are materially heavier than Telegram or one-shot `curl` probes.
- SOCKS is generally the better app-facing surface than the HTTP proxy for real-world use.

## Security

- Do not commit real `client_token` or `agent_token` values.
- Do not commit `host/app/config.php`.
- Do not commit runtime data under `host/storage/`.
- Rotate tokens if they have ever been shared.

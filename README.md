# Twoman

<p align="center">
  <img src="docs/assets/logo-homepage.png" alt="Twoman logo" width="160" />
</p>

<p align="center">
  <a href="https://github.com/ShahabSL/twoman/actions/workflows/ci.yml"><img src="https://github.com/ShahabSL/twoman/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/ShahabSL/twoman/releases"><img src="https://img.shields.io/github/v/release/ShahabSL/twoman" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
</p>

Twoman is a host-preserving relay for shared cPanel hosting and managed
CloudLinux app runtimes.

Final path:

`app -> local helper -> public host broker -> hidden reverse agent -> internet`

The public host stays in the live path. The hidden server performs outbound
internet access. The local helper exposes normal HTTP and SOCKS5 proxies so
apps like Telegram and browsers can use the system.

Compatibility note:
- the public broker base URI is configurable end-to-end; deployments can mount the service under paths such as `/api/v1/telemetry` or `/wp-content/sync`
- route templates are now relative to that configured base URI by default

## Easy Deploy

The main path is the Linux installer. Run it on the Linux machine that
should become the hidden Twoman server. The installer:

- asks only for the public host domain and cPanel credentials
- checks that the Linux machine can actually reach the host
- detects which public-host backends your cPanel account supports
- recommends the best backend automatically
- generates Persian-style default names and paths, while still letting you override them
- can route the hidden server through local WARP WireProxy when the Linux machine cannot reach the host directly
- can separately route hidden-server outbound internet traffic through a SOCKS5 / HTTP CONNECT proxy such as local WireProxy
- deploys the public broker and installs the hidden agent on the same machine
- prints the final Twoman import text and installs a `twoman-server` management command

From a cloned repo:

```bash
sudo bash scripts/install_twoman.sh
```

From GitHub directly:

```bash
curl -fsSL https://raw.githubusercontent.com/ShahabSL/twoman/main/scripts/install_twoman.sh | sudo bash
```

Fully unattended installs are also supported through `twoman-server install` flags
after bootstrap. See [docs/EASY_DEPLOY.md](docs/EASY_DEPLOY.md) for the
non-interactive example.

After deployment:

- `sudo twoman-server` prints a fast server-control overview and common commands
- `sudo twoman-server list` shows every managed tunnel instance under the shared control root
- `sudo twoman-server set-default <instance>` changes which instance `sudo twoman-server` manages by default
- `sudo twoman-server status` or `sudo twoman-server verify` runs a non-interactive health check
- `sudo twoman-server logs` prints the hidden-agent journal tail
- `sudo twoman-server --instance <name> config` prints the client import text for one managed tunnel
- `sudo twoman-server restart-upstream-proxy` restarts managed WireProxy when that route is enabled

Multi-instance note:

- one control root can manage multiple hidden-server tunnels at once
- installer state now lives under `instances/<name>/`
- new named installs default to `/opt/twoman-<name>` and `twoman-<name>.service`
- when Node is available, the installer recommends it first
- multiple hidden servers can point at the same public host broker
- each hidden server should use a distinct agent peer label, such as `agent-main`, `agent-eu`, or `agent-us`
- client profiles can leave `targetAgentPeerLabel` empty for broker-selected routing or set it to one label to force a specific exit
- adding another exit does not require another public host; it only requires another hidden agent with the same broker URL and agent token

Easy-deploy guide:
- [docs/EASY_DEPLOY.md](docs/EASY_DEPLOY.md)

If this Linux machine can only reach the public host through WARP, answer `yes`
when the installer asks about a local WARP / upstream proxy and keep the default
`socks5h://127.0.0.1:1280` when you already run `wireproxy.service`.

If you also want the final public egress IP to be the WARP exit instead of the
hidden server IP, enable the separate hidden outbound proxy option and point it
at the same `socks5h://127.0.0.1:1280` listener.

## Client Quickstart

Twoman clients all consume the same `twoman://profile?data=...` import text
printed by `sudo twoman-server config` on the server.

Android:

- install the release APK
- paste or open the `twoman://...` import text
- choose Proxy mode for app-level proxying or VPN mode for whole-device routing

Windows desktop:

- install the Windows desktop release
- import the same `twoman://...` text
- connect, then choose SOCKS, HTTP, system proxy, or tunnel mode

Headless Linux:

```bash
tar -xzf twoman-cli-linux-amd64.tar.gz
cd twoman-linux-amd64
sudo ./install.sh
twoman import 'twoman://profile?data=...'
twoman service install
twoman status
twoman service logs
twoman logs export --output ~/twoman-diagnostics
```

The headless client installs `twoman-helper-agent` as a sidecar and discovers it
automatically; normal users should not need helper paths or runtime flags. Use
`twoman connect` only when you want a temporary non-service session. Use
`twoman profiles delete "Name"` to remove imported profiles and
`twoman logs export --output DIR` to collect redacted diagnostics for support.

## Cloudflare Fronting

Twoman can sit behind a Cloudflare-proxied hostname when the public host serves
normal HTTP or HTTPS traffic through that name.

Operational guidance:

- a proxied Cloudflare `A`, `AAAA`, or `CNAME` record can hide the origin IP
  and route client and hidden-server traffic to Cloudflare's edge first
- this can help when the hidden server has trouble reaching the public host's
  direct origin IP but can still reach Cloudflare normally
- this does not remove the public host from the Twoman path; the host still
  remains in-band behind Cloudflare
- this does not mean WebSocket mode is always the right choice; Twoman still
  follows the broker-advertised transport profile for the actual host/backend

Recommended use:

- keep the public broker on a normal HTTPS hostname
- proxy that hostname through Cloudflare if your host and domain support it
- keep hidden-side WARP enabled if the hidden server still cannot reliably
  reach the proxied hostname directly
- treat Cloudflare fronting as public-host protection and reachability help,
  not as a replacement for hidden-side WARP

## Status

This repository contains the current public implementation.

What it is good at:
- Telegram and other lighter interactive traffic
- SOCKS5 and HTTP proxy access through a localhost helper
- shared-host deployments where the public host must remain in-path
- managed-host deployments where a real Node app runtime is available

What it is not:
- a full-speed VPN replacement
- a general-purpose high-throughput tunnel on hostile shared hosting

## Documentation

Start here:

- [docs/EASY_DEPLOY.md](docs/EASY_DEPLOY.md): one-command Linux install, optional WARP route, `twoman-server` management command
- [docs/MANUAL_DEPLOY.md](docs/MANUAL_DEPLOY.md): repo-level host, hidden-server, and helper deployment
- [docs/BACKENDS.md](docs/BACKENDS.md): backend families and when each one fits
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md): current stable managed-host profile and benchmark limits
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): runtime layout, lanes, and broker behavior
- [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md): release validation and packaging checklist
- [docs/releases/](docs/releases): versioned release notes
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution and validation guidance
- [SECURITY.md](SECURITY.md): vulnerability reporting guidance

## Repository Layout

- `helper-agent/`: Go helper/agent dataplane used by the default client and hidden-server installs
- `twoman_protocol.py`: Python protocol helpers used by host/control compatibility tests
- `hidden_server/`: hidden-server config, watchdog, and systemd support for the Go agent
- `android-client/`: Android client with saved profiles, share/import profile text, proxy mode, and VPN mode
- `desktop_app/`: Windows Tauri desktop GUI that launches the Go helper sidecar
- `desktop_client/socks_gateway.py`: Windows desktop authenticated share proxy sidecar source
- `client-cli/`: Linux `twoman` CLI that imports profiles and runs the Go helper
- `host/node_selector/broker.js`: CloudLinux Node selector broker for managed-host deployments
- `host/runtime/http_broker_daemon.py`: asyncio broker for bridge-style cPanel deployments
- `host/app/bridge_runtime.php`: PHP bootstrap that starts and supervises the bridge broker
- `host/public/api.php`: public health/bootstrap endpoint for bridge-style deployments
- `tests/run_e2e_go_node_http.sh`: Go helper/agent smoke test for the Node selector broker

Backend overview: [docs/BACKENDS.md](docs/BACKENDS.md)
Android client notes: [android-client/README.md](android-client/README.md)
Desktop app notes: [desktop_app/README.md](desktop_app/README.md)

Portable Windows note:
- the desktop app only uses app-local state if the packaged build includes `portable-data/` or `twoman-portable` beside `Twoman.exe`
- the repo ships a portable packager at `desktop_app/scripts/package_windows_portable.py` so that layout is reproducible

## Architecture

Twoman uses:
- external helper lanes: `ctl` + `data`
- external agent lanes: `ctl` + `data`
- internal scheduler classes: `ctl`, `pri`, `bulk`

Key design points:
- helpers and agents default to `transport_profile: auto`, which reads broker
  capabilities from `/health` and selects the right transport profile for the
  current backend family
- Passenger/shared-host deployments stay on short-request HTTP polling profiles
- managed Node-capable hosts can use a lower-churn managed-host profile and
  opportunistically upgrade to WebSocket transport when the host advertises it
  and no hidden-side upstream SOCKS/HTTP proxy is in the path
- helper uplinks are bounded POST batches
- tunnel DNS is now a dedicated protocol subsystem instead of short-lived proxy
  streams mixed into normal TCP control flow
- the broker assigns agent-side stream IDs and scopes helper streams by session
- public authentication prefers `Authorization: Bearer <token>` with standard cookies for peer/session identity

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Backend Strategy

Twoman is one product with multiple public-host backend families.

Today:

- the default dataplane is the Go helper/agent on every client and hidden server
- the current best managed-host public backend is the CloudLinux Node selector path
- the cPanel LiteSpeed bridge backend remains available for hosts that cannot run Node

This is intentional. Different host classes expose different runtime models,
and Twoman does not force them into one fragile host implementation.

## Manual Deployment

Twoman still ships with repo-level scripts for each side:

- `scripts/deploy_host.sh`: uploads the cPanel host files, writes `host/app/config.php`, restarts the broker, and verifies health
- `scripts/deploy_hidden_server.sh`: builds/uploads the Go hidden agent, writes `config.json`, installs `systemd` units, enables the watchdog, and restarts the agent
- `scripts/build_client_cli_linux.sh`: builds the supported Linux `twoman` client bundle

Manual deployment details:
- [docs/MANUAL_DEPLOY.md](docs/MANUAL_DEPLOY.md)

### 1. Deploy the cPanel host

```bash
export TWOMAN_CPANEL_BASE_URL='https://your-host.example:2083'
export TWOMAN_CPANEL_USERNAME='cpanel-user'
export TWOMAN_CPANEL_PASSWORD='cpanel-password'
export TWOMAN_CPANEL_HOME='/home/cpanel-user'
export TWOMAN_PUBLIC_ORIGIN='https://your-host.example'
export TWOMAN_PUBLIC_BASE_PATH='/twoman'
export TWOMAN_CLIENT_TOKEN='replace-with-client-token'
export TWOMAN_AGENT_TOKEN='replace-with-agent-token'

./scripts/deploy_host.sh
```

### 2. Deploy the hidden server

```bash
export TWOMAN_SERVER_HOST='<hidden-server-host>'
export TWOMAN_SERVER_USER='root'
export TWOMAN_SERVER_PASSWORD='server-password'
export TWOMAN_SERVER_DIR='/opt/twoman'
export TWOMAN_BROKER_BASE_URL='https://your-host.example/api/v1/telemetry'
export TWOMAN_AGENT_TOKEN='replace-with-agent-token'
export TWOMAN_AGENT_PEER_ID='agent-main'
export TWOMAN_OUTBOUND_PROXY_URL='socks5h://127.0.0.1:1280'
export TWOMAN_OUTBOUND_PROXY_LABEL='wireproxy'

./scripts/deploy_hidden_server.sh
```

### 3. Install the Linux client

```bash
scripts/build_client_cli_linux.sh
sudo dist/client-cli/twoman-linux-amd64/install.sh
twoman import 'twoman://profile?data=...'
twoman service install
twoman status
twoman service logs
twoman logs export --output ~/twoman-diagnostics
```

See [docs/CLIENT_CLI.md](docs/CLIENT_CLI.md).

Advanced multi-exit profiles can set `targetAgentPeerLabel` in the shared
`twoman://profile?...` import text. Empty means broker-selected failover; a
value such as `agent-main` or `agent-eu` pins that profile to a specific
hidden exit.

Default helper ports:
- HTTP proxy: `127.0.0.1:18092`
- SOCKS5 proxy: `127.0.0.1:11092`

Connection strings are route definitions, not local socket assignments. Windows
desktop and Linux CLI imports therefore default to stable local ports so reconnects and
systemd restarts do not surprise users with a new browser/proxy endpoint.
Android can still use dynamic local ports internally because its app services
consume the helper listen-state directly.

Use this path when you need to inspect or override each stage manually:
- [docs/MANUAL_DEPLOY.md](docs/MANUAL_DEPLOY.md)

## Requirements

- cPanel/Passenger or managed-host application-server integration for the public broker path
- Python 3 on the host only when using the bridge backend (`host/runtime/http_broker_daemon.py`)
- Go 1.22+ for local helper and hidden-agent builds
- `curl` for `scripts/deploy_host.sh`
- `ssh` and `scp` for `scripts/deploy_hidden_server.sh`
- `sshpass` only if you use password-based hidden-server deploys
- `pip install -r requirements.txt` for control scripts and bridge-host tooling

### 4. Verify

Bridge health:

```bash
curl -H 'Authorization: Bearer YOUR_CLIENT_TOKEN' \
  'https://your-host.example/twoman/api.php?action=health'
```

SOCKS egress:

```bash
curl --socks5-hostname 127.0.0.1:11092 https://api.ipify.org
```

HTTP egress:

```bash
curl --proxy http://127.0.0.1:18092 https://api.ipify.org
```

Expected result: the origin IP should be the hidden server or the configured
hidden outbound proxy exit, not the local client.

## Development

Run the Go dataplane smoke test:

```bash
tests/run_e2e_go_node_http.sh
```

Enable verbose tracing temporarily:

```bash
cd helper-agent
TWOMAN_TRACE=1 go run . --mode agent --config ../hidden_server/config.json
```

Tracing is off by default to avoid log growth on production hosts.

Linux client crash and runtime logs:

- `twoman logs` reads the helper log file
- `twoman service logs` reads the user service journal
- `twoman logs export --output DIR` writes a redacted support bundle

## Operational Notes

- LiteSpeed reverse proxying to `127.0.0.1` is the core shared-host trick.
- The broker is the hot-path component on the cPanel host. PHP is only bootstrap/supervision.
- Browser workloads are materially heavier than Telegram or one-shot `curl` probes.
- SOCKS is generally the better app-facing surface than the HTTP proxy for real-world use.
- The broker now enforces per-session safety limits for concurrent streams, open-rate bursts, and queued bytes.
- The hidden agent watchdog restarts the service before file descriptors or `CLOSE-WAIT` sockets can pile up into an outage.

## Security

- Do not commit real `client_token` or `agent_token` values.
- Do not commit `host/app/config.php`.

## License

MIT. See [LICENSE](LICENSE).
- Do not commit runtime data under `host/storage/`.
- Rotate tokens if they have ever been shared.

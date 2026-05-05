# Easy Deploy

Use this path when you want one Linux machine to become the hidden Twoman
server while also deploying the public host broker from the same command.

This is the preferred Twoman installation path.

## What the installer does

`scripts/install_twoman.sh` bootstraps the control dependencies, launches the
Twoman installer, and then:

1. collects the minimum required host details
2. verifies the Linux machine can talk to the public host
3. detects the cPanel account capabilities
4. recommends the best supported backend
5. generates randomized Persian-style defaults for paths and site naming
6. optionally routes cPanel deployment and hidden-agent runtime through local WARP WireProxy
7. can separately route hidden-server outbound internet traffic through a SOCKS5 or HTTP CONNECT proxy
8. deploys the selected host backend
9. installs the hidden agent locally as a systemd service with a watchdog
10. validates broker health and performs a local helper probe
11. installs `/usr/local/bin/twoman` for management

The current Linux machine becomes the hidden server. You do not need a second
manual SSH deploy step for the hidden agent.

One control root can manage multiple named Twoman instances. Each instance gets
its own state directory, hidden install root, and systemd service, while the
shared `twoman` launcher and control virtual environment stay global.

## Requirements

- Ubuntu or another Linux distribution with `python3`, `curl`, and `systemd`
- `sudo` access on the machine that will become the hidden server
- a cPanel account on the public host
- optional: a local SOCKS5 or HTTP upstream when the hidden server cannot reach
  the public host directly

## Required input

The default interactive path only asks for:

- public host domain
- cPanel username
- cPanel password

The installer derives these defaults automatically:

- cPanel API URL: `https://<domain>:2083`
- cPanel home directory: `/home/<cpanel-user>`
- generated Persian site name and randomized public paths
- Passenger app name / app root or Node selector app root
- hidden-agent install root: `/opt/twoman` for the default instance
- hidden-agent service names: `twoman-agent.service` and watchdog units for the default instance

For named instances:

- use `--instance <name>`
- default hidden install root becomes `/opt/twoman-<name>`
- default hidden service becomes `twoman-<name>.service`
- state is saved under `/opt/twoman/control/instances/<name>/`

You can override the generated values when the installer asks whether to
customize the deployment.

## Optional WARP route on the hidden server

If the Linux machine cannot reach the public host directly, the installer can
route both the deployment traffic and the hidden-agent runtime through a local
upstream proxy.

Recommended path for hidden-server reachability:

- run `wireproxy` locally on the hidden server
- expose SOCKS5 on `127.0.0.1:1280`
- answer `yes` when the installer asks whether to use a local WARP / upstream
  proxy
- keep the default proxy URL: `socks5h://127.0.0.1:1280`

This affects only the hidden server and the installer that runs on it. Twoman
clients on desktop and Android do not need WARP for this mode.

Optional outbound path:

- answer `yes` when the installer asks whether hidden-server outbound internet
  traffic should also use a local proxy
- keep `socks5h://127.0.0.1:1280` if you want the final public egress IP to be
  the WARP exit instead of the hidden server IP

The host route and the outbound route are separate settings. The first fixes
hidden-server -> public-host reachability. The second changes what IP websites
see for the final egress.

## Optional Cloudflare Fronting

If your public hostname is proxied through Cloudflare, Twoman can use that
hostname as the public broker origin just like any other HTTPS site.

Use this when:

- you want the public host hidden behind a Cloudflare edge hostname
- the hidden server can reach Cloudflare more reliably than the public host's
  direct origin IP
- you want a cleaner public-facing deployment story for a managed Node or
  bridge-style host

Important limits:

- Cloudflare fronting does not bypass the public host; the host still runs the
  Twoman broker behind the proxied hostname
- Cloudflare fronting does not automatically make `managed_host_ws` the best
  transport; the broker still advertises the right profile, and helpers/agents
  should follow it
- if the hidden server still has poor reachability to the proxied hostname,
  keep the hidden-side WARP route enabled

## Run it

From a cloned repo:

```bash
sudo bash scripts/install_twoman.sh
```

From GitHub directly:

```bash
curl -fsSL https://raw.githubusercontent.com/ShahabSL/twoman/main/scripts/install_twoman.sh | sudo bash
```

The bootstrap script forwards extra flags to
`python -m twoman_control.cli install`, so you can keep using the same entry
point for both interactive and scripted installs.

## Non-interactive install

Example:

```bash
sudo bash scripts/install_twoman.sh \
  --non-interactive \
  --public-origin https://your-host.example \
  --cpanel-base-url https://your-host.example:2083 \
  --cpanel-username cpanel-user \
  --cpanel-password cpanel-password \
  --cpanel-home /home/cpanel-user \
  --backend cloudlinux_node_selector \
  --hidden-upstream-proxy-url socks5h://127.0.0.1:1280 \
  --hidden-upstream-proxy-label wireproxy \
  --hidden-outbound-proxy-url socks5h://127.0.0.1:1280 \
  --hidden-outbound-proxy-label wireproxy
```

Useful flags:

- `--instance <name>`: install or reconfigure one named Twoman tunnel under the shared control root
- `--customize`: override generated paths, app roots, and service names
- `--verify-tls` / `--no-verify-tls`: control TLS verification for broker traffic
- `--hidden-outbound-proxy-url`: route final hidden-server egress through a SOCKS5 or HTTP CONNECT proxy
- `--skip-helper-probe`: skip the final helper traffic probe when you only need
  deployment and service install

## What backend gets chosen

The installer checks the public host and ranks backends in this order:

1. `cloudlinux_node_selector`
2. `cpanel_runtime_bridge`
3. `passenger_python`

If multiple backends are available, the highest-ranked one is suggested as the
default. The detected capabilities are stored in the install state and can be
reviewed later from the TUI.

## After install

The installer prints:

- the deployed broker URL
- the hidden-agent service name
- the Twoman import text for Android and desktop clients

It also installs:

- launcher: `/usr/local/bin/twoman`
- registry: `/opt/twoman/control/instances.json`
- state file: `/opt/twoman/control/instances/<name>/install-state.json`
- import text: `/opt/twoman/control/instances/<name>/profile-share.txt`

## Management command

Run:

```bash
sudo twoman
```

That opens the Textual TUI. The TUI exposes:

- health verification
- hidden-agent restart
- optional WireProxy restart when the hidden route uses WARP
- watchdog run
- public-host redeploy
- capability review
- client import text display
- recent hidden-agent logs
- reconfigure by re-running the installer against the saved state

Non-interactive commands are also available:

```bash
sudo twoman list
sudo twoman set-default node
sudo twoman verify
sudo twoman logs
sudo twoman --instance bridge show-config
sudo twoman restart-agent
sudo twoman restart-upstream-proxy
sudo twoman run-watchdog
sudo twoman redeploy-host
```

Use `--instance <name>` with the operational commands whenever you want to
target a non-default tunnel.

## Notes

- Use [docs/MANUAL_DEPLOY.md](docs/MANUAL_DEPLOY.md) only when you need to
  inspect or override each deployment stage directly.
- The hidden agent is installed into a dedicated Python virtual environment
  under the install root so the Linux instance does not depend on system
  `site-packages`.
- The installer saves the cPanel credentials in the root-only state file
  because host redeploy and reconfigure actions need them later.
- If the public host cannot be reached from the Linux machine, capability
  detection and deployment will fail early unless you enable the local WARP /
  upstream proxy route first.

# Client CLI

`twoman` is the lightweight headless Linux client for Twoman.

It uses the same `twoman://profile?data=...` import text as Android and the
desktop app, then starts the Go helper in headless mode and prints the local
SOCKS5 and HTTP proxy endpoints.

## Install From A Release Bundle

Install a specific released version directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/ShahabSL/twoman/main/client-cli/install-linux.sh | sudo bash -s -- --version 1.0.7
```

Or install offline from a downloaded artifact:

```bash
tar -xzf twoman-cli-linux-amd64-v1.0.7.tar.gz
cd twoman-linux-amd64
sudo ./install.sh
```

The installer places:

- `twoman` in `/usr/local/bin`
- `twoman-helper-agent` in `/usr/local/lib/twoman`

After that, users never need to pass a helper path.
Check the installed client and helper versions with:

```bash
twoman version
twoman-helper-agent --version
```

## Use

Import a profile:

```bash
twoman import 'twoman://profile?data=...'
```

Run it as a user service:

```bash
twoman service install
```

This writes `~/.config/systemd/user/twoman-client.service`, enables it for the
current user, and starts it immediately. If it must start after boot before the
user logs in, enable linger once:

```bash
sudo loginctl enable-linger "$USER"
```

For a one-shot/background session instead of a service:

```bash
twoman connect
```

The command prints:

```text
Twoman connected
SOCKS5: 127.0.0.1:11092
HTTP:   127.0.0.1:18092
PID:    12345
```

Imported profiles use stable local ports by default (`SOCKS5 11092`,
`HTTP 18092`). That is intentional for headless Linux services: browsers,
system proxy settings, and monitoring should not lose the local endpoint after a
service restart. Ephemeral ports are still available for advanced one-shot
tests:

```bash
twoman connect --http-port 0 --socks-port 0
```

Do not install a long-running service with `--http-port 0` or `--socks-port 0`
unless you explicitly want the local proxy ports to change after every helper
restart.

Check status:

```bash
twoman status
twoman status --json
```

Inspect logs and generated runtime config:

```bash
twoman logs
twoman logs export --output ~/twoman-diagnostics
twoman config
```

`twoman logs` reads the helper log file. For older service installs that only
wrote to journald, it falls back to `journalctl --user -u twoman-client`.
`twoman logs export` creates a timestamped diagnostics directory containing
recent helper logs, service journal lines, runtime state, service unit metadata,
and redacted profiles/config. It is the preferred command to ask users for when
debugging disconnects. `twoman config` redacts the client token by default.

Manage imported profiles:

```bash
twoman profiles
twoman profiles default "Profile Name"
twoman profiles delete "Profile Name"
twoman profiles delete --force "Profile Name"
```

Profile deletion refuses to remove the currently running profile unless
`--force` is passed. The safer normal flow is `twoman disconnect` first, then
delete the profile.

Stop:

```bash
twoman disconnect
```

Service controls:

```bash
twoman service status
twoman service logs
twoman service restart
twoman service stop
twoman service uninstall
```

## State

By default, state is stored under:

```text
~/.local/state/twoman/client
```

Override it with:

```bash
TWOMAN_CLIENT_HOME=/path/to/state twoman status
twoman --home /path/to/state status
```

## Build From Source

```bash
scripts/build_client_cli_linux.sh
sudo dist/client-cli/twoman-linux-amd64/install.sh
```

For development only, you can run the bundle in place:

```bash
dist/client-cli/twoman-linux-amd64/twoman import 'twoman://profile?data=...'
dist/client-cli/twoman-linux-amd64/twoman connect
```

The command auto-discovers `twoman-helper-agent` next to itself, in
`~/.local/lib/twoman`, `/usr/local/lib/twoman`, `/usr/lib/twoman`, or through
`TWOMAN_HELPER_BIN`.

## Notes

- The CLI is for local client proxy control, not hidden-agent server
  management.
- Hidden-agent server management uses the separate `twoman-server` command, for
  example `sudo twoman-server status`, `sudo twoman-server logs`, and
  `sudo twoman-server config`.
- The CLI does not enable a system proxy or VPN. It exposes local HTTP and
  SOCKS5 endpoints for apps that can use proxy settings.
- Profiles may include `targetAgentPeerLabel` for advanced multi-exit setups.
  Leave it empty for broker-selected automatic failover. Set it to a live agent
  label such as `agent-main` or `agent-eu` to force that profile through a
  specific hidden exit; if that agent is unavailable, the connection fails
  clearly instead of silently falling back.

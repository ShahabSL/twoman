# Client CLI

`twoman` is the lightweight, non-TUI Linux client for Twoman.

It uses the same `twoman://profile?data=...` import text as Android and the
desktop app, then starts the Go helper in headless mode and prints the local
SOCKS5 and HTTP proxy endpoints.

## Install From A Release Bundle

```bash
tar -xzf twoman-cli-linux-amd64.tar.gz
cd twoman-linux-amd64
sudo ./install.sh
```

The installer places:

- `twoman` in `/usr/local/bin`
- `twoman-helper-agent` in `/usr/local/lib/twoman`

After that, users never need to pass a helper path.

## Use

Import a profile:

```bash
twoman import 'twoman://profile?data=...'
```

Connect:

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

Check status:

```bash
twoman status
twoman status --json
```

Inspect logs and generated runtime config:

```bash
twoman logs
twoman config
```

`twoman config` redacts the client token by default.

Stop:

```bash
twoman disconnect
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
- Hidden-agent server management remains under `sudo twoman verify`,
  `sudo twoman logs`, `sudo twoman tui`, and the other server-side `twoman`
  subcommands.
- The CLI does not enable a system proxy or VPN. It exposes local HTTP and
  SOCKS5 endpoints for apps that can use proxy settings.
- Profiles may include `targetAgentPeerLabel` for advanced multi-exit setups.
  Leave it empty for broker-selected automatic failover. Set it to a live agent
  label such as `agent-main` or `agent-nima` to force that profile through a
  specific hidden exit; if that agent is unavailable, the connection fails
  clearly instead of silently falling back.

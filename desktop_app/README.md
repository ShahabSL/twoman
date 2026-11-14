# Twoman Desktop App

`desktop_app/` is the Tauri desktop client shell for Twoman.

Stack:
- Tauri 2
- React
- shadcn/ui

What it does:
- saved Twoman profiles
- profile import/export text compatible with the Android client
- `Proxy` mode for local SOCKS + HTTP listeners
- `System proxy` mode on Windows, implemented as Windows system proxy management
- `Tunnel` mode on Windows, implemented as a TUN sidecar routed into the local Twoman SOCKS helper
- authenticated public SOCKS and HTTP proxies that forward into the local Twoman helper
- copyable helper/share logs inside the app

Important scope:
- this app is the user-facing desktop shell
- the Twoman helper dataplane is the Go `helper-agent` runtime
- the desktop SOCKS gateway and Windows TUN runtime remain separate sidecars

## Running from Source

Requirements:
- Node.js 22+
- Rust toolchain
- Go toolchain for source-mode helper execution
- Python 3 for the Windows desktop SOCKS gateway sidecar

Install dependencies:

```bash
cd desktop_app
npm install
```

Run the GUI in development:

```bash
npm run tauri dev
```

The app starts with no profiles. Add one profile in the UI or import share text.
Imported share text defaults to stable local ports on desktop. Use `0` in the
profile editor only when you intentionally want ephemeral ports that can change
after the helper restarts.

## Windows Config Fields

For the current live method, the user-facing fields are:
- `Broker URL`
- `Client token`
- `Verify TLS`
- `HTTP/2 control`
- `HTTP/2 data`
- `HTTP port`
- `SOCKS port`

`System proxy` mode on Windows means:
- start the Twoman local helper
- point the current user’s Windows system HTTP/HTTPS proxy settings at the helper’s local HTTP port

`Tunnel` mode on Windows means:
- start the Twoman local helper
- start a bundled `sing-box` TUN sidecar
- route Windows traffic through a real TUN interface into the helper’s local SOCKS port
- hijack DNS into the tunnel path while excluding private LAN ranges from capture

This is a real system tunnel, not just Windows proxy settings.
On Windows, creating the TUN interface requires Administrator privileges.

## Sidecar Builds

Build Windows sidecars from Windows Python:

```bat
cd desktop_app
scripts\build_sidecars_windows.bat
```

The sidecars are written to:
- `src-tauri/resources/sidecars/windows/`

On Windows, the sidecar build also downloads the pinned `sing-box` release for
the TUN runtime and stages it as `twoman-tunnel.exe`.

## Portable Windows Build

Portable Windows distribution should be shipped as a folder or zip, not just the installer.

Portable layout:
- `Twoman.exe`
- `sidecars/windows/twoman-helper.exe`
- `sidecars/windows/twoman-gateway.exe`
- `sidecars/windows/twoman-tunnel.exe`
- `portable-data/`
- `twoman-portable`

Portable mode only activates when one of these exists beside `Twoman.exe`:
- `portable-data/`
- `twoman-portable`

When portable mode is active, the app keeps:
- profiles
- shared proxy entries
- logs
- runtime files

inside that folder instead of the normal Windows app-data directories.

Portable data paths:
- `portable-data/config/profiles.json`
- `portable-data/config/shares.json`
- `portable-data/config/settings.json`
- `portable-data/runtime/helper.json`
- `portable-data/runtime/tunnel.json`
- `portable-data/twoman-logs/helper.log`
- `portable-data/twoman-logs/tunnel.log`

Package the portable handoff after a Windows build:

```bash
python3 desktop_app/scripts/package_windows_portable.py
```

That script:
- copies the fresh Windows `Twoman.exe`
- copies the current Windows sidecars
- writes `portable-data/README.txt`
- writes the `twoman-portable` marker
- rebuilds `private_handoff/desktop_app/windows/Twoman_<version>_x64-portable.zip`

Regenerate the Windows icon set after changing `src/assets/logo.png`:

```bash
python3 desktop_app/scripts/generate_windows_icons.py
```

That script emits exact small Windows icon layers so the taskbar/titlebar does
not depend on one blurred downscale from a large raster.

## Packaging

The Linux desktop build uses the same React interface, profile format, Go
helper and authenticated sharing gateway as the Windows desktop client.
Linux supports local HTTP/SOCKS proxy mode and authenticated proxy sharing;
system proxy and TUN modes remain Windows-only.

On x86_64 Linux, install Node.js 22+, Rust, Go, Python 3.11+ with `venv`,
and the Tauri native build dependencies (`pkg-config`, `libglib2.0-dev`,
`libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
`librsvg2-dev` and `patchelf`). Then run:

```bash
bash desktop_app/scripts/build_linux.sh
```

The script checks that the repository and desktop package versions match,
builds both Linux sidecars from this checkout, and creates a Debian package
and a portable folder archive in `dist/desktop-linux/`. The portable folder
includes a `Twoman` executable and `sidecars/linux/`; keep them together.
Destination machines need GTK 3 and WebKitGTK 4.1, but no development tools
or Python installation. Packages target the distribution used for the build.

The Linux release configuration is passed explicitly by the script, so
`cargo check` and development builds can still run before sidecars are staged.
The `Linux desktop` GitHub Actions workflow builds on Ubuntu 22.04, tests both
package layouts with a local relay under Xvfb, and saves the packages as CI
artifacts. Publishing a GitHub release also attaches the tested `.deb`, portable
archive, versioned checksum file and build information to that release. The
release tag (with an optional `v` prefix) must match `VERSION`.

To run the same native smoke test locally, install `webkit2gtk-driver`, `xvfb`,
`xauth` and `dbus-x11`, then run:

```bash
npm ci --prefix host/node_selector
xvfb-run -a -s '-screen 0 1280x900x24' dbus-run-session -- \
  python3 tests/run_desktop_linux_smoke.py
```

The test uses isolated application data and a loopback-only relay, verifies
that the bundled sidecars are used, and checks HTTP/SOCKS proxies,
authenticated sharing, disconnect and reconnect. It needs no live credentials.

For a headless Linux client, use the `twoman` CLI bundle from `client-cli/`.

## Validation

Backend runtime validation:

```bash
cd desktop_app/src-tauri
TWOMAN_E2E_BROKER_BASE_URL='https://<public-host>/<path>' \
TWOMAN_E2E_CLIENT_TOKEN='<client-token>' \
cargo test live_connect_share_disconnect_flow -- --ignored --nocapture
```

That test covers:
- connect
- local SOCKS egress
- authenticated shared SOCKS egress
- authenticated shared HTTP proxy egress
- disconnect

Windows-only tunnel validation:

```bash
cd desktop_app/src-tauri
TWOMAN_E2E_BROKER_BASE_URL='https://<public-host>/<path>' \
TWOMAN_E2E_CLIENT_TOKEN='<client-token>' \
TWOMAN_E2E_ENABLE_TUNNEL='true' \
cargo test live_connect_tunnel_disconnect_flow -- --ignored --nocapture
```

That test covers:
- baseline direct egress
- tunnel connect
- direct egress through the Windows tunnel
- disconnect and route restoration

## Learning Notes

The desktop app is intentionally split into:
- a modern GUI shell
- separately managed helper/share/tunnel runtimes

That keeps the UI replaceable without rewriting the helper protocol path each time.

## Why This Matters

The previous Windows client kept failing because UI lifecycle and process lifecycle were tangled together inside one Python desktop shell. This Tauri app keeps the connection state machine in one place and treats helper/share/tunnel processes as managed runtime components, which is the right production pattern for a desktop network client.

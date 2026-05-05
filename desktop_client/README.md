# Desktop Client

The desktop client is the public Linux/Windows manager for Twoman helper profiles.

It provides:

- saved profiles
- profile import/export text compatible with the Android app
- connect/disconnect for the local helper
- an authenticated SOCKS5 share layer that forwards public SOCKS traffic into the local Twoman SOCKS port
- Linux and Windows packaging from the same codebase
- source-level TUI tests plus end-to-end proxy tests against the local Twoman broker stack

The desktop UI is a Textual TUI so the same client works on Linux terminals and Windows terminals.

## What the SOCKS share does

When the local helper exposes a SOCKS proxy on `127.0.0.1:21167`, the desktop client can also expose a second SOCKS5 listener such as:

- `0.0.0.0:31167`

That externally reachable listener requires username/password authentication and then forwards each SOCKS connection through the local Twoman SOCKS helper. This is useful when a machine running the client should also act as a controlled proxy entry point for other devices.

## Development

Install runtime dependencies:

```bash
python3 -m pip install -r requirements.txt -r desktop_client/requirements.txt
```

Run the TUI:

```bash
python3 -m desktop_client
```

## Packaging

Linux one-file build:

```bash
./desktop_client/build_linux.sh
```

Windows one-file build:

```bat
desktop_client\\build_windows.bat
```

Windows executables should still be built on Windows for normal release use. WSL + Wine is suitable for smoke testing.

## Tests

Headless Textual UI coverage:

```bash
python3 -m unittest tests/test_desktop_client_tui.py
```

Source-runtime end-to-end share test:

```bash
bash tests/run_desktop_client_e2e.sh
```

# Android Client

This Android app is the user-facing Twoman client for phones and tablets.

It supports:

- saved profiles
- profile sharing
- profile import from shared text
- local proxy mode
- optional LAN-shared SOCKS mode
- full-device VPN mode
- in-app logs
- launcher icon branding from the Twoman mark

The profile UI keeps the active mode visible in two ways:

- the active button is highlighted
- the row shows `Running in Proxy mode` or `Running in VPN mode`

## Modes

### Proxy

Starts the embedded helper and exposes localhost proxies inside Android:

- SOCKS5 on the configured SOCKS port
- HTTP on the configured HTTP port
- optional SOCKS binding on the phone's Wi-Fi IP for same-network clients

This is the most direct way to validate the helper on-device.

### VPN

Starts the embedded helper and a `VpnService`-backed TUN interface.

Current design notes:

- public-leg transport stays on the working HTTP profile
- VPN mode uses a local SOCKS5 bridge through `tun2socks`
- VPN DNS uses real resolver IPs from the profile, not the legacy `198.18.0.2` virtual address, unless a local DNS proxy is implemented
- DNS UDP requests are translated to TCP DNS upstream so the tunnel stays compatible with the existing TCP-only Twoman backend
- on Android 13+ the app excludes local/private-network routes from the VPN so nearby devices and local network access can stay reachable
- Twoman excludes its own app package from the VPN route so broker/control traffic does not loop through the tunnel it is creating
- mobile runtime config enables adaptive upload by default, starting conservatively and ramping only when there is backlog

## Saved Profiles

Profiles store:

- name
- broker URL
- client token
- HTTP port
- SOCKS port
- LAN-sharing toggle for SOCKS
- TLS verification
- HTTP/2 control toggle
- HTTP/2 data toggle
- DNS resolver IPs used by VPN mode
- helper transport tuning such as TLS handshake timeout and adaptive upload defaults

Profiles are persisted in app-private storage and can be reused from the main screen.

Profiles can also be shared as text:

- `Share` opens the Android share sheet with an encoded profile string
- `Add` includes an `Import text` field and `Import` action
- import accepts either the full shared `twoman://profile?...` text or the encoded payload by itself

## Build

Requirements:

- Android SDK
- Java 17+
- Android NDK 27+
- Go 1.22+ for the packaged helper-agent binary

Build debug APK:

```bash
export ANDROID_SDK_ROOT="$HOME/android-sdk"
export ANDROID_HOME="$HOME/android-sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
cd android-client
./gradlew assembleArm64Debug
```

APK output:

```text
android-client/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
```

## Release Build

The project is set up for release signing through environment variables so
private signing material stays out of git.

Required environment variables:

```bash
export TWOMAN_ANDROID_KEYSTORE_FILE="/absolute/path/to/release-keystore.jks"
export TWOMAN_ANDROID_KEYSTORE_PASSWORD="..."
export TWOMAN_ANDROID_KEY_ALIAS="..."
export TWOMAN_ANDROID_KEY_PASSWORD="..."
```

Build signed release APKs:

```bash
export ANDROID_SDK_ROOT="$HOME/android-sdk"
export ANDROID_HOME="$HOME/android-sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
cd android-client
./gradlew assembleArm64Release bundleArm64Release
```

Release outputs are flavor-specific so the phone build can stay arm64-only.
For a modern phone, the installable artifact is:

```text
android-client/app/build/outputs/apk/arm64/release/app-arm64-release.apk
```

The Play-ready bundle is:

```text
android-client/app/build/outputs/bundle/arm64Release/app-arm64-release.aab
```

An `x86_64` desktop flavor can still be built separately for emulators.

## Tested Behavior

Validated on a real Android device:

- Proxy mode starts and serves working SOCKS/HTTP proxy traffic
- LAN-shared SOCKS traffic works from another device on the same Wi-Fi
- Proxy mode stops cleanly and returns the UI to `Stopped`
- VPN mode establishes successfully
- VPN mode stops cleanly and returns the UI to `Stopped`
- browser traffic reaches real destination TCP flows through the VPN path
- the Add dialog opens cleanly
- `Share` opens the system share sheet with exported profile text
- import text populates the dialog fields and saves a new profile
- the active mode is visible from the main list row
- the launcher icon uses the Twoman logo assets

Concrete live broker addresses and tokens belong only in `private_handoff/`, not in this public tree.

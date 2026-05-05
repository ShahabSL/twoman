# CLPersist Method

This is the current working Twoman deployment method on the managed CloudLinux host.

Concrete live values belong only in `private_handoff/` and should not be copied into public docs.

## Live Path

- Local helper on the user machine
- Public host broker at `<public-host-base-url>`
- Reverse hidden agent on `<hidden-server-host>:<port>`
- Internet egress from the hidden server

Effective path:

`client -> local helper -> public host broker -> hidden agent -> internet`

## Host Runtime

- CloudLinux Node selector app
- HTTP transport only
- No public WebSocket path
- Control lane over HTTP/2
- Data lane over HTTP/1.1

## Local Proxy Ports

The verified local helper profile uses:

- SOCKS5: `127.0.0.1:21167`
- HTTP: `127.0.0.1:28167`

## Important Client Settings

- `broker_base_url = <public-host-base-url>`
- `verify_tls = false`
- `log_path = logs/helper.log`
- `http2_enabled.ctl = true`
- `http2_enabled.data = false`
- `streaming_up_lanes = []`

Recommended upload tuning:

- `upload_profiles.data.max_batch_bytes = 65536`
- `upload_profiles.data.flush_delay_seconds = 0.004`

Recommended repoll tuning:

- `idle_repoll_delay_seconds.ctl = 0.05`
- `idle_repoll_delay_seconds.data = 0.1`

Important hidden-agent setting:

- `http2_enabled.ctl = false`

The managed-host method is currently stable with helper control on HTTP/2 and
hidden-agent control on HTTP/1.1.

## Client Logging

The Go helper writes rotating client logs by default.

- default path: `logs/helper.log`
- override with `TWOMAN_LOG_PATH=/path/to/helper.log`
- Go helper stderr/stdout are written to the same log

## Code Paths

Main host broker:
- `host/node_selector/broker.js`

Go helper/agent dataplane:
- `helper-agent/`

Client launcher defaults:
- `scripts/start_client.sh`

Friend bundle:
- `private_handoff/friend_client_bundle/`

## What 21167 Is

`21167` is the current verified local SOCKS5 port of the working helper profile.

If a browser or app was pointed at `127.0.0.1:21167`, it was using the local SOCKS5 helper for this method.

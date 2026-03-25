# Architecture

## Summary

Twoman is designed for environments where:
- the public host must remain in the traffic path
- the public host is a shared cPanel/LiteSpeed environment
- the hidden server can make outbound HTTPS requests to the host
- end-user applications need a local HTTP/SOCKS5 proxy

## Data Path

1. An application talks to the local helper.
2. The helper speaks Twoman frames to the public bridge at `/twoman/bridge/v2/...`.
   The `/bridge/v2` path name is retained for deployment compatibility.
3. LiteSpeed reverse-proxies those paths to the localhost Python broker.
4. The hidden agent maintains a reverse session to the broker.
5. The hidden server opens the real outbound TCP connection.

## Lanes

External lanes:
- `ctl`
- `data`

Internal scheduling classes:
- `ctl`
- `pri`
- `bulk`

The external `data` lane carries both `pri` and `bulk` traffic. `FRAME_DATA` bulk frames are marked with `FLAG_DATA_BULK` so the broker can preserve scheduling intent.

## Authentication

Each public request includes:
- `X-Relay-Token`
- `X-Twoman-Role`
- `X-Twoman-Peer`
- `X-Twoman-Session`

The token is the shared bearer credential. Peer and session headers are routing identity, not the secret.

## Why The Host Broker Exists

The broker exists because:
- PHP is too expensive for the hot path
- shared-host public ports are unavailable
- the hidden server cannot accept direct inbound public traffic in the required topology

The broker is:
- asyncio-based
- loopback-bound
- started and supervised by PHP bootstrap code

## Host Constraints

Twoman is intentionally shaped around shared-host reality:
- response streaming works better than aggressive request-body transport
- helper downlinks use streamed HTTP/1.1
- larger uploads and larger browser workloads are the practical ceiling

## Production Reality

Twoman is best suited for:
- Telegram
- lighter browsing
- constrained relay scenarios where “host must stay in path” is more important than maximum throughput

It is not a substitute for a direct tunnel or a VPS-based relay.

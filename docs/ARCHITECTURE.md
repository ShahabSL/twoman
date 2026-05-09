# Architecture

## Summary

Twoman is designed for environments where:
- the public host must remain in the traffic path
- the public host is a shared cPanel/LiteSpeed environment
- some managed hosts expose a stronger Node runtime than the shared-host path
- the hidden server can make outbound HTTPS requests to the host
- end-user applications need a local HTTP/SOCKS5 proxy

## Data Path

1. An application talks to the local helper.
2. The helper speaks Twoman frames to the public broker at a fully configured base URI such as
   `/api/v1/telemetry`, with relative route templates such as `/{lane}/{direction}`.
3. The helper and agent fetch broker capabilities from `/health` and select a
   named transport profile automatically unless an explicit profile is pinned.
4. Preferred shared-host deployments use internal application-server integration such as Passenger WSGI.
5. The hidden agent maintains a reverse session to the broker.
6. The hidden server opens the real outbound TCP connection directly or through
   an optional hidden outbound proxy.

## Lanes

External lanes:
- `ctl`
- `data`

Internal scheduling classes:
- `ctl`
- `pri`
- `bulk`

The external `data` lane carries both `pri` and `bulk` traffic. `FRAME_DATA` bulk frames are marked with `FLAG_DATA_BULK` so the broker can preserve scheduling intent.

## Transport Profiles

Twoman 1.0 treats transport behavior as a backend capability instead of one
global runtime shape.

Current named profiles:

- `shared_host_safe`
- `managed_host_http`
- `managed_host_ws`

Default behavior:

- helpers and agents set `transport_profile: auto`
- the broker publishes `capabilities` in `/health`
- the transport picks the broker-recommended profile, then falls back through
  other supported profiles when needed

Current selection rules:

- Passenger and bridge-style shared hosts recommend `shared_host_safe`
- `shared_host_safe` assumes short-request polling on the public host instead of
  long-lived down streams, including the hidden-agent `data/down` path when the
  hidden side is reaching the host through WARP or another upstream proxy
- managed Node hosts recommend `managed_host_http`
- managed Node hosts may advertise `managed_host_ws` as an optional higher-throughput path
- WebSocket mode is skipped when the hidden server is using an upstream proxy
  such as WireProxy/WARP, because the current transport intentionally keeps that
  path on HTTP until proxy-aware WebSocket support is added

## Authentication

Each public request now prefers:
- `Authorization: Bearer <token>`
- `Cookie: _cf_role=...; _cf_lspa=...; _wp_syncId=...`

The token remains the shared bearer credential. Peer and session cookies provide routing identity, not the secret.

## Why The Host Broker Exists

The broker exists because:
- PHP is too expensive for the hot path
- shared-host public ports are unavailable
- the hidden server cannot accept direct inbound public traffic in the required topology

The broker is:
- asyncio-based
- deployable behind Passenger WSGI or a compatibility daemon
- able to use Unix domain sockets for host-internal control traffic when the deployment supports it

## Host Constraints

Twoman is intentionally shaped around shared-host reality:
- response behavior must match the host runtime instead of assuming one model
- Passenger/shared hosts are safer with bounded polling responses
- managed Node runtimes can sustain lower-churn long-lived transports
- binary lane traffic defaults to `image/webp` so intermediaries see a standard media type
- upload worker counts, batch sizes, and downlink parallelism are broker
  capabilities so deployments can be tuned without client-side hardcoding

## DNS

Tunnel DNS is now a dedicated subsystem.

Why:

- VPN DNS is latency-sensitive and user-visible
- treating each DNS query as an ordinary short proxy stream made Android VPN
  mode look dead even when the transport was technically connected

Current model:

- helper captures DNS queries locally
- helper sends `FRAME_DNS_QUERY`
- broker routes DNS requests separately from TCP stream lifecycle
- agent resolves DNS directly or through the configured hidden outbound proxy
  and returns `FRAME_DNS_RESPONSE` or `FRAME_DNS_FAIL`

This keeps DNS out of normal TCP OPEN/WINDOW/FIN churn while preserving the
same public camouflage surface.

## Production Reality

Twoman is for host-preserving relay deployments. The public host stays in-band
for topology and camouflage reasons, while the Go dataplane, broker-advertised
profiles, and adaptive upload controls are used to extract the best validated
performance from that topology.

If a deployment does not need the public host in the traffic path, benchmark a
direct relay architecture separately instead of mixing that requirement into
Twoman's transport model.

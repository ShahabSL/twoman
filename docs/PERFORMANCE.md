# Performance Notes

This document explains how Twoman selects and validates fast public-host
profiles. Treat it as an operating method, not a universal throughput promise:
the public host, hidden server route, client network, and selected backend all
affect the final number.

## Current Release Behavior

- Helpers and hidden agents default to `transport_profile: auto`.
- The broker advertises its active profile, route templates, batch limits,
  down-lane parallelism, cipher suite, and version metadata from authenticated
  health.
- Clients do not pin worker counts or batch sizes in connection strings.
- Managed Node deployments use the broker-advertised `managed_host_http`
  profile unless the broker and route prove another profile is available.
- Data uploads use bounded POST batches with multipart-shaped bodies.
- Data downlinks use bounded concurrent polls on the managed HTTP profile.
- Adaptive upload is a server-side/runtime setting, not a client UX setting.

The current managed-host profile uses larger Go batches and multiple bounded
data workers so normal client traffic can fill the available path without
manual local tuning. Operators should change these values through deploy
configuration and broker health, then validate with stress tests.

## Adaptive Upload

Runtime config key: `adaptive_upload`.

Deploy scripts expose:

- `TWOMAN_ADAPTIVE_UPLOAD_ENABLED`
- `TWOMAN_ADAPTIVE_UPLOAD_MIN_WORKERS`
- `TWOMAN_ADAPTIVE_UPLOAD_INITIAL_WORKERS`
- `TWOMAN_ADAPTIVE_UPLOAD_MAX_WORKERS`
- `TWOMAN_ADAPTIVE_UPLOAD_MIN_BATCH_BYTES`
- `TWOMAN_ADAPTIVE_UPLOAD_MAX_BATCH_BYTES`
- `TWOMAN_ADAPTIVE_UPLOAD_INCREASE_AFTER_SUCCESSES`
- `TWOMAN_ADAPTIVE_UPLOAD_DECREASE_AFTER_ERRORS`
- `TWOMAN_ADAPTIVE_UPLOAD_BACKLOG_THRESHOLD_FRAMES`
- `TWOMAN_ADAPTIVE_UPLOAD_DECISION_INTERVAL_SECONDS`
- `TWOMAN_ADAPTIVE_UPLOAD_ERROR_COOLDOWN_SECONDS`

Adaptive upload starts from the configured floor, increases only when the data
lane has enough backlog or fills batches, and backs down after upload errors.
The error cooldown prevents immediate re-ramp after host-side resets. Enable it
per deployment when live tests show that the host/server pair benefits from
adaptive scheduling.

## Validation Method

Benchmark every release or deployment profile with the same metadata:

- Twoman version, git commit, and release asset name.
- Broker base URL and backend family.
- Hidden-server route, including whether host reachability uses WARP/WireProxy.
- Cipher suite and broker-advertised transport profile.
- Client platform and helper version.
- Concurrent stream count, object size, duration, and error count.

Recommended test groups:

- Broker health and camouflage checks.
- Raw host upload probes for the selected backend.
- Single-stream download and upload.
- Multi-stream download and upload.
- Multi-client stress with separate helper peer IDs.
- Long-running reconnect tests with logs and broker session counts.

Use the live benchmark scripts under `scripts/` for repeatable path probes and
`tests/run_client_cli_e2e.sh` for local Linux CLI regression coverage.

## Tuning Rules

- Prefer broker-advertised profiles over client-side hardcoding.
- Tune one deployment variable at a time and record the exact release/version.
- Raise upload workers only when the host accepts the extra concurrency without
  resets, EOFs, or rising reconnects.
- Increase batch size only when latency remains acceptable for interactive
  traffic.
- Keep control traffic small and isolated from bulk data.
- Treat WebSocket as a separate profile that must be proven by real broker
  health, upgrade probes, and end-to-end tests.
- Keep the public host in path for Twoman deployments; if that requirement is
  removed, benchmark a different architecture instead of calling it Twoman
  performance.

## Release Gate

A release is performance-ready when:

- the Linux CLI, Android, and Windows clients launch the same versioned helper
  and report nonzero local ports where applicable;
- authenticated broker health reports the expected product version and profile;
- multi-client stress completes without peer replacement, session leaks, or
  repeated reconnects;
- representative upload and download benchmarks complete without host reset
  patterns; and
- diagnostics can be exported with redacted logs for support.

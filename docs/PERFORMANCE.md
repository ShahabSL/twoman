# Performance Notes

This document records the best currently proven managed-host profile and the
limits observed during live probes. It is operational guidance, not a promise
that every host or network will reproduce the same numbers.

## Current Stable Managed-Host Profile

The current stable profile for the audited `/parvaneh` CloudLinux Node selector
deployment is:

- public backend: `cloudlinux_node_selector`
- broker profile: `managed_host_http`
- helper data upload workers: `32`
- agent data upload workers: `8`
- helper and agent data upload batch: `524288` bytes
- helper and agent data flush delay: `0.006` seconds
- helper and agent data down parallelism: `4`
- broker bulk lane batch: `4194304` bytes
- upload body camouflage: `multipart`
- public data routes: `/media/upload` and `/media/download`

Helpers and agents should normally keep `transport_profile: auto` and avoid
pinning these numbers in client configs. The broker advertises the active
profile from `/health`, so server-side tuning can move without rebuilding
clients.

Adaptive upload scheduling is available but intentionally opt-in. It starts
from the configured worker and batch floor, increases only while the data lane
is backlogged or filling batches, and backs down on upload errors. Keep it
disabled for release defaults until a live host/server pair proves it is better
than the fixed advertised profile.

## Live Benchmark Results

Latest stable direct-server benchmark artifact:
`output/twoman-direct-stable-candidate-20260507T143900Z.json`

Measured on `2026-05-07` against the managed host deployment path:

- tunnel download, 1 concurrent 100 MB download: `30.81 Mbps`
- tunnel download, 4 concurrent 100 MB downloads: `51.30 Mbps`
- tunnel download, 8 concurrent 100 MB downloads: not stable, `7/8` completed
- tunnel upload, 1 concurrent 25 MB upload: `29.48 Mbps`
- tunnel upload, 4 concurrent 25 MB uploads: `49.37 Mbps`
- tunnel upload, 8 concurrent 25 MB uploads: `49.07 Mbps`

The best aggressive download-only artifact is:
`output/twoman-direct-absolute-aggregate-20260507T133821Z.json`

That profile reached `79.74 Mbps` at 8 concurrent 100 MB downloads, but it was
not kept as the default because repeated stress later showed stalls and upload
instability.

## Host Ceiling Findings

Raw host ingress was pushed independently of the full tunnel:

- Direct server to host, 5 MB uploads: best burst was about `73.99 Mbps` at 32
  concurrent uploads; higher concurrency started failing.
- Local machine to host, 5 MB uploads: best burst was about `54.35 Mbps` at 64
  concurrent uploads; 96 concurrent uploads failed.

These probes are why the stable tunnel profile is intentionally below the most
aggressive burst result. On this single cPanel Node app, more concurrency helps
until the host runtime starts resetting, timing out, or returning errors.

## Adaptive Upload Scheduling

Runtime config key: `adaptive_upload`.

Deploy scripts expose the same feature through:

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

This is not a substitute for broker-advertised profiles. Use it for measured
host/server pairs where the best fixed worker count changes with live network
conditions.

Latest adaptive check on `2026-05-07`:

- WARP-routed server, fixed profile:
  `19.24 Mbps` download and `9.25 Mbps` upload.
- WARP-routed server, adaptive profile:
  `18.00 Mbps` download and `7.37 Mbps` upload.
- Direct server, fixed profile:
  `13.10 Mbps` download and `7.88 Mbps` upload.
- Direct server, adaptive profile:
  `18.40 Mbps` download and `8.37 Mbps` upload.

Decision: keep the fixed advertised profile as the default. Adaptive scheduling
is a useful tuning tool and may help direct-host paths like Toork, but the WARP
path regressed in the same benchmark, so it should not be enabled globally.

## Interpretation

The current single-host HTTP architecture is tuned close to the stable ceiling
observed on the audited host. To move materially beyond this class of numbers,
the next architecture candidates are:

- a Go WebSocket transport, since the host front door accepted WebSocket
  upgrades during probing
- multiple independent host apps or hosts for striping
- a different provider or edge runtime with higher sustained request ingress

Those are architecture changes. They should be benchmarked separately instead
of being mixed into the stable HTTP profile.

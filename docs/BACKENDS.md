# Backends

Twoman supports multiple public-host backend families.

Different host classes expose different runtime surfaces. The right public-host
implementation on a LiteSpeed/cPanel account with no app runtime is not the
same as the right implementation on a Passenger/Application Manager account.

## Shared Product Goal

These backend families still target the same product shape:

- local helper on the client machine
- public host remains in the path
- hidden reverse agent on the hidden server
- final path:
  `client -> public host -> hidden server -> internet`

Optional reachability note:

- the hidden server may use a local upstream proxy such as WireProxy/WARP when
  it cannot reach the public host directly
- that changes only the hidden-to-host route; it does not change desktop or
  Android client requirements

## Backend Families

### `cpanel_runtime_bridge`

Control-plane/runtime bootstrap for hostile shared hosts. The public data path now
expects internal app-server integration instead of legacy rewrite proxying.

Implementation surface:

- PHP bootstrap/watchdog
- localhost Python broker

Primary files:

- `host/runtime/http_broker_daemon.py`
- `host/app/bridge_runtime.php`
- `host/public/index.php`
- `host/public/.htaccess`
- `scripts/deploy_host.sh`

Current status:

- bridge deploy defaults keep helper downlinks bounded with
  `streaming_ctl_down_helper=false` and `streaming_data_down_helper=false`
- bridge deploy defaults keep the helper and hidden agent on combined data
  lanes with `helper_down_combined_data_lane=true` and
  `agent_down_combined_data_lane=true`
- bridge deploy defaults now keep `streaming_data_down_agent=false`
- the advertised `shared_host_safe` helper profile raises
  `down_parallelism.data=2` on bridge_runtime to hide PHP relay jitter without
  reopening long-lived helper responses on the public host
- the advertised `shared_host_safe` agent profile also keeps
  `down_parallelism.data=2` so one bounded hidden-agent poll can be reopened
  while the other remains available
- reason: on the audited bridge path, bounded helper polls preserve the
  camouflage story and avoid public-host queue buildup, and bounded hidden-side
  polls avoid the mid-stream resets seen on WARP-backed bridge sessions

### `cloudlinux_node_selector`

Current best managed-host backend for CloudLinux accounts that expose a real
Node.js selector runtime.

Implementation surface:

- CloudLinux Node.js selector app
- Node broker on the public host
- broker-advertised transport capabilities
- managed-host HTTP profile by default
- optional managed-host WebSocket profile when the host and route allow it
- reverse hidden agent

Current status:

- end-to-end tunnel is proven on the audited managed host
- browser-grade smoke tests are passing on the current profile
- the broker now advertises `managed_host_http` as the default profile and
  `managed_host_ws` as an optional higher-throughput profile
- a Cloudflare-proxied hostname can front the managed host cleanly, but Twoman
  should still follow the broker-advertised profile instead of assuming that
  Cloudflare implies public WebSocket viability
- current cPanel Node deploy defaults keep helper downlinks bounded with
  `streaming_data_down_helper=false`
- current cPanel Node deploy defaults keep `streaming_data_down_agent=false`
- the advertised `managed_host_http` helper profile now keeps
  `down_parallelism.data=4` so bounded helper polls can reopen while
  the first is draining
- the current best stable audited profile uses helper data upload workers
  `32`, agent data upload workers `8`, `512 KiB` data upload batches, `6 ms`
  data flush delay, and a `4 MiB` broker bulk lane batch
- Go helper/agent runtimes also support opt-in adaptive upload scheduling for
  measured deployments where live host capacity changes; release defaults stay
  fixed until benchmarks prove adaptive is better on that host/server pair
- helper and agent probe WebSocket mode only when the host advertises it and no
  hidden-side upstream proxy such as WARP is configured
- reason: on the audited cPanel front-end, long-lived helper data streams were
  buffered until the server-side stream window closed, which delayed `FIN` and
  later response frames by roughly 30 seconds
- camouflage deploys should publish the same generated `404.html` at both the
  site slug and the root `public_html` when `TWOMAN_CAMOUFLAGE_SITE_ROOT_INDEX=true`
- camouflage deploys should also install matching `.htaccess` `ErrorDocument`
  rules so unknown Apache-served paths use that same themed 404 page
- unauthenticated Node broker routes, including `/health`, lane routes, probes,
  and unknown app paths, should also return the themed HTML `404` instead of
  broker JSON or `403`
- if the hidden server cannot reliably reach the managed host even through a
  Cloudflare-proxied hostname, keep hidden-side WARP enabled and let the hidden
  agent use that route only for host reachability and optional outbound egress

Primary files:

- `host/node_selector/broker.js`
- `scripts/deploy_host_node_selector.sh`
- `tests/run_e2e_go_node_http.sh`
- `docs/CLPERSIST_METHOD.md`
- `docs/PERFORMANCE.md`

### `passenger_python`

Backend track for cPanel hosts with a real Passenger/Application Manager
surface and Python runtime.

Implementation surface:

- Passenger-managed Python WSGI app
- no PHP in the hot path

Current status:

- application registration is proven on the audited CloudLinux host
- `/health` is served relative to the configured Passenger base URI
- `LSAPI_CHILDREN=1` and `LSAPI_AVOID_FORK=1` are required baseline settings
- full broker traffic now expects Passenger-managed routing rather than `.htaccess` loopback proxying
- current Passenger deploy defaults use `down_wait_ms={"ctl":250,"data":250}`
- current Passenger deploy defaults keep `streaming_ctl_down_helper=false` and
  `streaming_data_down_helper=false`
- current Passenger deploy defaults keep `streaming_ctl_down_agent=false` and
  `streaming_data_down_agent=false`
- the advertised `shared_host_safe` helper profile keeps `http2_enabled.ctl=false`
  because the audited Passenger host behaves more reliably with short HTTP/1.1
  control uploads than with helper-side HTTP/2 control requests
- reason: long-lived helper or agent down streams can monopolize the public
  Passenger queue or get cut mid-response on the audited CloudLinux host
- current deploy defaults size broker lanes as `ctl=4096/8/1ms`, `pri=32768/16/2ms`, and `bulk=262144/64/4ms`
- the broker advertises only `shared_host_safe`, and helpers/agents now select
  that profile automatically
- current public-host naming guidance is documented in
  `docs/HOST_APP_MAPPINGS.md`

Primary files:

- `host/passenger_python/broker_app.py`
- `host/passenger_python/passenger_wsgi.py`
- `backends/passenger_python/proof_app.py`
- `scripts/deploy_host_passenger.sh`

### `passenger_node`

Backend track for Passenger-capable hosts where Node.js and WebSocket upgrade
are truly available.

Why it matters:

- best fit for long-lived bidirectional control/data channels
- highest-upside path for reducing request churn

Current status:

- generic Passenger runtime is not the preferred Node path on the audited CloudLinux host
- proof app scaffold exists for fast validation

Primary files:

- `backends/passenger_node/app.js`
- `backends/passenger_node/package.json`

## Standard Maintenance Model

The standard model is:

- one product
- multiple backend implementations
- backend-specific deployment and validation

Backends may share code where safe, but they do not need to share everything.
If a host class needs a different client or broker model, that is acceptable.

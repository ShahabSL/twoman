const fs = require("fs");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

class TransportCipher {
  constructor(keyBuffer, ivBuffer) {
    if (!keyBuffer || keyBuffer.length === 0) {
      keyBuffer = Buffer.from("twoman-default-key");
    }
    this.key = crypto.createHash("sha256").update(keyBuffer).digest();

    this.iv =
      ivBuffer.length < 16
        ? Buffer.concat([ivBuffer, Buffer.alloc(16 - ivBuffer.length)])
        : ivBuffer.subarray(0, 16);

    this._cipher = crypto.createCipheriv("aes-256-ctr", this.key, this.iv);
  }
  process(data) {
    if (!data || data.length === 0) return Buffer.alloc(0);
    return this._cipher.update(data);
  }
}

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = process.env.TWOMAN_CONFIG_PATH || path.join(__dirname, "config.json");
let TRACE_ENABLED = /^(1|true|yes|on|debug|verbose)$/i.test(process.env.TWOMAN_TRACE || "");
let DEBUG_STATS_ENABLED = /^(1|true|yes|on|debug|verbose)$/i.test(process.env.TWOMAN_DEBUG_STATS || "");
const HEARTBEAT_INTERVAL_MS = 20000;
const DEFAULT_RUNTIME_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RUNTIME_LOG_BACKUP_COUNT = 3;
const DEFAULT_EVENT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_EVENT_LOG_BACKUP_COUNT = 5;
const DEFAULT_RECENT_EVENT_LIMIT = 200;
const DEFAULT_BINARY_MEDIA_TYPE = "image/webp";
let RUNTIME_LOG_PATH = process.env.TWOMAN_RUNTIME_LOG_PATH || "";
let EVENT_LOG_PATH = process.env.TWOMAN_EVENT_LOG_PATH || "";
let RUNTIME_LOG_MAX_BYTES = DEFAULT_RUNTIME_LOG_MAX_BYTES;
let RUNTIME_LOG_BACKUP_COUNT = DEFAULT_RUNTIME_LOG_BACKUP_COUNT;
let EVENT_LOG_MAX_BYTES = DEFAULT_EVENT_LOG_MAX_BYTES;
let EVENT_LOG_BACKUP_COUNT = DEFAULT_EVENT_LOG_BACKUP_COUNT;
let RECENT_EVENT_LIMIT = DEFAULT_RECENT_EVENT_LIMIT;
let BINARY_MEDIA_TYPE = DEFAULT_BINARY_MEDIA_TYPE;

const FRAME_HEADER_SIZE = 20;
const FRAME_OPEN_OK = 4;
const FRAME_FIN = 8;
const FRAME_DATA = 6;
const FRAME_WINDOW = 7;
const FRAME_PING = 10;
const FRAME_OPEN = 3;
const FRAME_OPEN_FAIL = 5;
const FRAME_RST = 9;
const FRAME_DNS_QUERY = 12;
const FRAME_DNS_RESPONSE = 13;
const FRAME_DNS_FAIL = 14;
const FLAG_DATA_BULK = 1;
const LANE_CTL = "ctl";
const LANE_DATA = "data";
const DEFAULT_DATA_REPLAY_RESEND_MS = 750;
const DNS_FRAME_TYPES = new Set([FRAME_DNS_QUERY, FRAME_DNS_RESPONSE, FRAME_DNS_FAIL]);
const PROFILE_SHARED_HOST_SAFE = "shared_host_safe";
const PROFILE_MANAGED_HOST_HTTP = "managed_host_http";
const PROFILE_MANAGED_HOST_WS = "managed_host_ws";
const CAPABILITY_VERSION = 1;

function coerceInt(value, fallbackValue, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return Math.max(minimum, fallbackValue);
  }
  return Math.max(minimum, parsed);
}

function brokerCapabilities() {
  const agentDownWaitMs = state ? state.downWaitMsForRole("agent") : { ctl: 1000, data: 1000 };
  const agentDownReadTimeoutSeconds = Math.max(15.0, (Math.max(agentDownWaitMs.ctl, agentDownWaitMs.data) / 1000.0) + 10.0);
  const helperDownCombinedDataLane = state ? state.helperDownCombinedDataLane : false;
  const agentDownCombinedDataLane = state ? state.agentDownCombinedDataLane : false;
  const websocketPublicEnabled = state ? state.websocketPublicEnabled : false;
  const supportedProfiles = [PROFILE_MANAGED_HOST_HTTP];
  if (websocketPublicEnabled) {
    supportedProfiles.push(PROFILE_MANAGED_HOST_WS);
  }
  return {
    version: CAPABILITY_VERSION,
    backend_family: "node_selector",
    recommended_profile: PROFILE_MANAGED_HOST_HTTP,
    supported_profiles: supportedProfiles,
    profiles: {
      [PROFILE_MANAGED_HOST_HTTP]: {
        transport: "http",
        helper: {
          http2_enabled: { ctl: true, data: false },
          down_lanes: helperDownCombinedDataLane ? ["data"] : [],
          down_parallelism: { data: 2 },
          upload_profiles: {
            data: { max_batch_bytes: 65536, flush_delay_seconds: 0.004 }
          },
          idle_repoll_delay_seconds: { ctl: 0.05, data: 0.10 },
          streaming_up_lanes: []
        },
        agent: {
          http2_enabled: { ctl: false, data: false },
          down_lanes: agentDownCombinedDataLane ? ["data"] : [],
          proxy_keepalive_connections: 2,
          proxy_keepalive_expiry_seconds: 15.0,
          upload_profiles: {
            data: { max_batch_bytes: 131072, flush_delay_seconds: 0.006 }
          },
          down_read_timeout_seconds: agentDownReadTimeoutSeconds,
          idle_repoll_delay_seconds: { ctl: 0.05, data: 0.10 },
          streaming_up_lanes: [],
          ...(agentDownCombinedDataLane ? { stream_control_lane: "pri" } : {})
        }
      },
      [PROFILE_MANAGED_HOST_WS]: {
        transport: "ws",
        helper: {
          streaming_up_lanes: []
        },
        agent: {
          streaming_up_lanes: []
        }
      }
    },
    camouflage: {
      binary_media_type: BINARY_MEDIA_TYPE,
      route_template: loadedConfig.route_template || "/{lane}/{direction}",
      health_template: loadedConfig.health_template || "/health"
    }
  };
}

function defaultLogDir() {
  return path.join(path.dirname(path.resolve(CONFIG_PATH)), "logs");
}

function resolveLogPath(configValue, envValue, defaultFilename) {
  const explicitEnv = String(envValue || "").trim();
  if (explicitEnv) {
    return path.resolve(explicitEnv);
  }
  const configured = String(configValue || "").trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(path.dirname(path.resolve(CONFIG_PATH)), configured);
  }
  const sharedLogDir = String(process.env.TWOMAN_LOG_DIR || "").trim();
  const baseDir = sharedLogDir ? path.resolve(sharedLogDir) : defaultLogDir();
  return path.join(baseDir, defaultFilename);
}

function ensureLogDir(filePath) {
  const directory = path.dirname(path.resolve(filePath));
  fs.mkdirSync(directory, { recursive: true });
}

function rotateFile(filePath, backupCount) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  if (backupCount <= 0) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  const oldest = `${filePath}.${backupCount}`;
  if (fs.existsSync(oldest)) {
    fs.rmSync(oldest, { force: true });
  }
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    const target = `${filePath}.${index + 1}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, target);
    }
  }
  fs.renameSync(filePath, `${filePath}.1`);
}

function appendRotatedLine(filePath, maxBytes, backupCount, line) {
  try {
    ensureLogDir(filePath);
    const incomingBytes = Buffer.byteLength(line, "utf8");
    const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (maxBytes > 0 && currentSize + incomingBytes > maxBytes) {
      rotateFile(filePath, backupCount);
    }
    fs.appendFileSync(filePath, line, "utf8");
  } catch (_error) {
    // Best-effort diagnostics only.
  }
}

function normalizeLaneProfiles(config) {
  const defaults = {
    ctl: { maxBytes: 4096, maxFrames: 8, holdMs: 1, padMin: 1024 },
    pri: { maxBytes: 32768, maxFrames: 16, holdMs: 2, padMin: 1024 },
    bulk: { maxBytes: 262144, maxFrames: 64, holdMs: 4, padMin: 0 }
  };
  const configured = (config && typeof config.lane_profiles === "object" && config.lane_profiles) || {};
  const normalized = {
    ctl: { ...defaults.ctl },
    pri: { ...defaults.pri },
    bulk: { ...defaults.bulk }
  };
  const aliasFor = {
    maxBytes: "max_bytes",
    maxFrames: "max_frames",
    holdMs: "hold_ms",
    padMin: "pad_min"
  };
  for (const lane of Object.keys(normalized)) {
    const override = configured[lane];
    if (!override || typeof override !== "object") {
      continue;
    }
    for (const key of Object.keys(aliasFor)) {
      const rawValue = override[key] ?? override[aliasFor[key]];
      if (rawValue === undefined || rawValue === null) {
        continue;
      }
      const numeric = Number(rawValue);
      if (!Number.isFinite(numeric)) {
        continue;
      }
      const minimum = (key === "maxBytes" || key === "maxFrames") ? 1 : 0;
      normalized[lane][key] = Math.max(minimum, Math.trunc(numeric));
    }
  }
  return normalized;
}

function runtimeLog(message) {
  if (!RUNTIME_LOG_PATH) {
    return;
  }
  appendRotatedLine(RUNTIME_LOG_PATH, RUNTIME_LOG_MAX_BYTES, RUNTIME_LOG_BACKUP_COUNT, `${new Date().toISOString()} ${message}\n`);
}

function jsonSafe(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonSafe(entry));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[String(key)] = jsonSafe(entry);
    }
    return result;
  }
  return String(value);
}

function trace(message) {
  if (!TRACE_ENABLED) {
    return;
  }
  const line = `[node-broker] ${message}\n`;
  runtimeLog(message);
  process.stderr.write(line);
}

function nowMs() {
  return Date.now();
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function makeErrorPayload(message) {
  return Buffer.from(String(message || ""), "utf8");
}

function paddedPayload(payload, minimumSize) {
  let body = payload || Buffer.alloc(0);
  while (body.length < minimumSize) {
    body = Buffer.concat([body, encodeFrame({ typeId: FRAME_PING, flags: 0, streamId: 0, offset: nowMs(), payload: Buffer.alloc(0) })]);
  }
  return body;
}

function pingFramePayload() {
  return encodeFrame({ typeId: FRAME_PING, flags: 0, streamId: 0, offset: nowMs(), payload: Buffer.alloc(0) });
}

function encodeFrame(frame) {
  const payload = frame.payload || Buffer.alloc(0);
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt8(frame.typeId >>> 0, 0);
  header.writeUInt8(frame.flags >>> 0, 1);
  header.writeUInt16BE(0, 2);
  header.writeUInt32BE(frame.streamId >>> 0, 4);
  header.writeBigUInt64BE(BigInt(frame.offset || 0), 8);
  header.writeUInt32BE(payload.length >>> 0, 16);
  return Buffer.concat([header, payload]);
}

class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk) {
    if (!chunk || chunk.length === 0) {
      return [];
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames = [];
    while (this.buffer.length >= FRAME_HEADER_SIZE) {
      const typeId = this.buffer.readUInt8(0);
      const flags = this.buffer.readUInt8(1);
      const streamId = this.buffer.readUInt32BE(4);
      const offset = Number(this.buffer.readBigUInt64BE(8));
      const length = this.buffer.readUInt32BE(16);
      const total = FRAME_HEADER_SIZE + length;
      if (this.buffer.length < total) {
        break;
      }
      const payload = this.buffer.subarray(FRAME_HEADER_SIZE, total);
      frames.push({ typeId, flags, streamId, offset, payload });
      this.buffer = this.buffer.subarray(total);
    }
    return frames;
  }
}

class FrameQueue {
  constructor() {
    this.items = [];
    this.bufferedBytes = 0;
  }

  push(payload) {
    this.items.push(payload);
    this.bufferedBytes += payload.length;
  }

  shift() {
    const payload = this.items.shift() || null;
    if (payload) {
      this.bufferedBytes = Math.max(0, this.bufferedBytes - payload.length);
    }
    return payload;
  }
}

class PeerState {
  constructor(role, peerLabel, peerSessionId) {
    this.role = role;
    this.peerLabel = peerLabel;
    this.peerSessionId = peerSessionId;
    this.lastSeenMs = nowMs();
    this.channels = { ctl: null, data: null };
    this.flushScheduled = { ctl: false, data: false };
    this.ctlQueue = new FrameQueue();
    this.dataPriQueue = new FrameQueue();
    this.dataBulkQueue = new FrameQueue();
    this.dataReplay = { pri: [], bulk: [] };
    this.dataReplayByPayload = new Map();
    this.waiters = { ctl: [], data: [] };
    this.activeStreams = 0;
    this.openEventsMs = [];
  }

  touch() {
    this.lastSeenMs = nowMs();
  }

  bufferedBytesTotal() {
    return this.ctlQueue.bufferedBytes + this.dataPriQueue.bufferedBytes + this.dataBulkQueue.bufferedBytes;
  }

  notifyWaiters(lane) {
    const waiters = this.waiters[lane];
    this.waiters[lane] = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  waitForLane(lane, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(false);
      }, timeoutMs);
      this.waiters[lane].push(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

class StreamState {
  constructor(helperSessionId, helperPeerLabel, helperStreamId, agentSessionId, agentStreamId) {
    this.helperSessionId = helperSessionId;
    this.helperPeerLabel = helperPeerLabel;
    this.helperStreamId = Number(helperStreamId);
    this.agentSessionId = agentSessionId;
    this.agentStreamId = Number(agentStreamId);
    this.createdAtMs = nowMs();
    this.lastSeenMs = this.createdAtMs;
    this.helperAckOffset = 0;
    this.agentAckOffset = 0;
    this.helperFinSeen = false;
    this.agentFinSeen = false;
    this.helperFinOffset = null;
    this.agentFinOffset = null;
  }

  touch() {
    this.lastSeenMs = nowMs();
  }
}

class DnsQueryState {
  constructor(helperSessionId, helperPeerLabel, helperRequestId, agentSessionId, agentRequestId) {
    this.helperSessionId = helperSessionId;
    this.helperPeerLabel = helperPeerLabel;
    this.helperRequestId = Number(helperRequestId);
    this.agentSessionId = agentSessionId;
    this.agentRequestId = Number(agentRequestId);
    this.createdAtMs = nowMs();
    this.lastSeenMs = this.createdAtMs;
  }

  touch() {
    this.lastSeenMs = nowMs();
  }
}

class BrokerState {
  constructor(config) {
    this.config = config;
    this.baseUri = String(config.base_uri || process.env.TWOMAN_BASE_URI || "").replace(/\/+$/, "");
    this.clientTokens = new Set(config.client_tokens || []);
    this.agentTokens = new Set(config.agent_tokens || []);
    this.peerTtlMs = Number(config.peer_ttl_seconds || 90) * 1000;
    this.streamTtlMs = Number(config.stream_ttl_seconds || 300) * 1000;
    this.dnsQueryTtlMs = Number(config.dns_query_ttl_seconds || 30) * 1000;
    this.maxLaneBytes = Number(config.max_lane_bytes || 16 * 1024 * 1024);
    this.maxPeerBufferedBytes = Number(
      config.max_peer_buffered_bytes || Math.min(this.maxLaneBytes * 2, 32 * 1024 * 1024)
    );
    this.maxStreamsPerPeerSession = Math.max(1, Number(config.max_streams_per_peer_session || 256));
    this.maxOpenRatePerPeerSession = Math.max(1, Number(config.max_open_rate_per_peer_session || 120));
    this.openRateWindowMs = Math.max(1000, Number(config.open_rate_window_seconds || 10) * 1000);
    this.flushBackpressureBytes = Number(config.flush_backpressure_bytes || 512 * 1024);
    this.flushRetryDelayMs = Number(config.flush_retry_delay_ms || 5);
    this.dataReplayResendMs = Math.max(50, Number(config.data_replay_resend_ms || DEFAULT_DATA_REPLAY_RESEND_MS));
    this.streamMaxDurationMs = Math.max(
      5000,
      Number(config.stream_max_duration_ms || 30000),
    );
    this.downWaitMsByRole = this.normalizeRoleDownWaitMs(config);
    this.helperDownCombinedDataLane = Boolean(config.helper_down_combined_data_lane);
    this.agentDownCombinedDataLane = Boolean(config.agent_down_combined_data_lane);
    this.websocketPublicEnabled = Boolean(config.websocket_public_enabled);
    this.streamingCtlDownHelper = Boolean(config.streaming_ctl_down_helper);
    this.streamingDataDownHelper = Boolean(config.streaming_data_down_helper);
    this.streamingCtlDownAgent = Boolean(config.streaming_ctl_down_agent);
    this.streamingDataDownAgent = Boolean(config.streaming_data_down_agent);
    this.laneProfiles = normalizeLaneProfiles(config);
    this.peers = new Map();
    this.streamsByHelper = new Map();
    this.streamsByAgent = new Map();
    this.dnsQueriesByHelper = new Map();
    this.dnsQueriesByAgent = new Map();
    this.agentSessionId = "";
    this.agentPeerLabel = "";
    this.nextAgentStreamId = 1;
    this.nextAgentDnsRequestId = 1;
    this.metrics = {
      peer_connects: 0,
      peer_disconnects: 0,
      ws_messages_in: { ctl: 0, data: 0 },
      ws_bytes_in: { ctl: 0, data: 0 },
      ws_messages_out: { ctl: 0, data: 0 },
      ws_bytes_out: { ctl: 0, data: 0 },
      frames_in: { ctl: 0, pri: 0, bulk: 0 },
      frames_out: { ctl: 0, pri: 0, bulk: 0 },
      connect_probe: { ok: 0, fail: 0 }
    };
    this.recentEvents = [];
  }

  normalizeDownWaitMs(rawConfig) {
    const ctl = Math.max(50, Number(rawConfig.ctl || rawConfig.control || 1000));
    const data = Math.max(50, Number(rawConfig.data || 1000));
    return { ctl, data };
  }

  normalizeRoleDownWaitMs(config) {
    const base = this.normalizeDownWaitMs(config.down_wait_ms || {});
    const values = {
      helper: { ...base },
      agent: { ...base }
    };
    const byRole = (config && typeof config.down_wait_ms_by_role === "object" && config.down_wait_ms_by_role) || {};
    for (const role of ["helper", "agent"]) {
      const override = byRole[role];
      if (!override || typeof override !== "object") {
        continue;
      }
      values[role] = this.normalizeDownWaitMs({ ...values[role], ...override });
    }
    return values;
  }

  downWaitMsForRole(role) {
    return this.downWaitMsByRole[role] || this.downWaitMsByRole.helper;
  }

  helperControlLane() {
    return this.helperDownCombinedDataLane ? "pri" : LANE_CTL;
  }

  targetLaneForRole(targetRole, inboundLane, frameTypeId) {
    if (targetRole === "agent" && this.agentDownCombinedDataLane) {
      return frameTypeId === FRAME_DATA ? inboundLane : "pri";
    }
    if (targetRole === "helper" && this.helperDownCombinedDataLane) {
      return (frameTypeId === FRAME_DATA || DNS_FRAME_TYPES.has(frameTypeId)) ? inboundLane : "pri";
    }
    return (frameTypeId === FRAME_DATA || DNS_FRAME_TYPES.has(frameTypeId)) ? inboundLane : null;
  }

  recordEvent(kind, details, options = {}) {
    const event = {
      ts: new Date().toISOString(),
      kind,
      ...jsonSafe(details)
    };
    if (options.durable !== false && EVENT_LOG_PATH) {
      appendRotatedLine(
        EVENT_LOG_PATH,
        EVENT_LOG_MAX_BYTES,
        EVENT_LOG_BACKUP_COUNT,
        `${JSON.stringify(event)}\n`
      );
    }
    this.recentEvents.push(event);
    if (this.recentEvents.length > RECENT_EVENT_LIMIT) {
      this.recentEvents.splice(0, this.recentEvents.length - RECENT_EVENT_LIMIT);
    }
  }

  peerKey(role, peerSessionId) {
    return `${role}:${peerSessionId}`;
  }

  streamHelperKey(peerSessionId, streamId) {
    return `${peerSessionId}:${streamId}`;
  }

  dnsHelperKey(peerSessionId, requestId) {
    return `${peerSessionId}:${requestId}`;
  }

  auth(role, token) {
    if (role === "helper") {
      return this.clientTokens.has(token);
    }
    if (role === "agent") {
      return this.agentTokens.has(token);
    }
    return false;
  }

  normalizePath(rawPath) {
    if (rawPath === "/health" || rawPath === "/pid" || rawPath === "/connect-probe") {
      return rawPath;
    }
    if (this.baseUri && rawPath.startsWith(this.baseUri)) {
      const suffix = rawPath.slice(this.baseUri.length);
      return suffix || "/";
    }
    return rawPath || "/";
  }

  ensurePeer(role, peerLabel, peerSessionId) {
    const key = this.peerKey(role, peerSessionId);
    let peer = this.peers.get(key);
    if (!peer) {
      peer = new PeerState(role, peerLabel, peerSessionId);
      this.peers.set(key, peer);
      this.metrics.peer_connects += 1;
      trace(`peer online role=${role} label=${peerLabel} session=${peerSessionId}`);
      this.recordEvent("peer_online", {
        role,
        peer_label: peerLabel,
        peer_session_id: peerSessionId
      });
    }
    peer.touch();
    peer.peerLabel = peerLabel;
    if (role === "agent") {
      this.agentSessionId = peerSessionId;
      this.agentPeerLabel = peerLabel;
    }
    return peer;
  }

  allocateAgentDnsRequestId() {
    let requestId = Number(this.nextAgentDnsRequestId) >>> 0;
    if (requestId <= 0) {
      requestId = 1;
    }
    const start = requestId;
    while (this.dnsQueriesByAgent.has(requestId)) {
      requestId = requestId >= 0xFFFFFFFF ? 1 : requestId + 1;
      if (requestId === start) {
        throw new Error("no available agent dns request ids");
      }
    }
    this.nextAgentDnsRequestId = requestId >= 0xFFFFFFFF ? 1 : requestId + 1;
    return requestId;
  }

  bindChannel(role, peerLabel, peerSessionId, lane, ws) {
    const peer = this.ensurePeer(role, peerLabel, peerSessionId);
    peer.channels[lane] = ws;
    ws._twomanPeerKey = this.peerKey(role, peerSessionId);
    ws._twomanLane = lane;
    ws.isAlive = true;
    this.scheduleFlush(peer, lane);
    return peer;
  }

  unbindChannel(peerKey, lane, ws) {
    const peer = this.peers.get(peerKey);
    if (!peer) {
      return;
    }
    if (peer.channels[lane] === ws) {
      peer.channels[lane] = null;
      this.metrics.peer_disconnects += 1;
      this.recordEvent("channel_closed", {
        role: peer.role,
        peer_label: peer.peerLabel,
        peer_session_id: peer.peerSessionId,
        lane
      });
    }
  }

  queueFrame(role, peerSessionId, frame, queueLane = null) {
    const peer = this.peers.get(this.peerKey(role, peerSessionId));
    if (!peer) {
      trace(`drop frame type=${frame.typeId} stream=${frame.streamId} role=${role} session=${peerSessionId} reason=no-peer`);
      this.recordEvent("queue_drop", {
        reason: "no-peer",
        role,
        peer_session_id: peerSessionId,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return false;
    }
    const encoded = encodeFrame(frame);
    if (this.maxPeerBufferedBytes && peer.bufferedBytesTotal() >= this.maxPeerBufferedBytes) {
      trace(`drop frame type=${frame.typeId} stream=${frame.streamId} role=${role} session=${peerSessionId} reason=peer-buffer-full`);
      this.recordEvent("queue_drop", {
        reason: "peer-buffer-full",
        role,
        peer_session_id: peerSessionId,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return false;
    }
    if (frame.typeId === FRAME_DATA || queueLane === "pri" || queueLane === "bulk") {
      const dataLane = queueLane || ((frame.flags & FLAG_DATA_BULK) ? "bulk" : "pri");
      const targetQueue = dataLane === "bulk" ? peer.dataBulkQueue : peer.dataPriQueue;
      if (targetQueue.bufferedBytes >= this.maxLaneBytes) {
        trace(`drop data stream=${frame.streamId} role=${role} session=${peerSessionId} reason=data-queue-full`);
        this.recordEvent("queue_drop", {
          reason: "data-queue-full",
          role,
          peer_session_id: peerSessionId,
          type_id: frame.typeId,
          stream_id: frame.streamId
        });
        return false;
      }
      targetQueue.push(encoded);
      if (frame.typeId === FRAME_DATA) {
        const entry = {
          encoded,
          streamId: frame.streamId,
          endOffset: Number(frame.offset || 0) + encoded.readUInt32BE(16),
          sentAtMs: 0,
          replayLane: dataLane
        };
        peer.dataReplay[dataLane].push(entry);
        peer.dataReplayByPayload.set(encoded, entry);
      } else {
        this.recordEvent("queue_ctl", {
          role,
          peer_session_id: peerSessionId,
          lane: dataLane,
          type_id: frame.typeId,
          stream_id: frame.streamId,
          payload_bytes: frame.payload ? frame.payload.length : 0
        }, { durable: false });
      }
      this.metrics.frames_out[dataLane] += 1;
      peer.notifyWaiters(LANE_DATA);
      this.scheduleFlush(peer, LANE_DATA);
      return true;
    }
    if (peer.ctlQueue.bufferedBytes >= this.maxLaneBytes) {
      trace(`drop ctl type=${frame.typeId} stream=${frame.streamId} role=${role} session=${peerSessionId} reason=ctl-queue-full`);
      this.recordEvent("queue_drop", {
        reason: "ctl-queue-full",
        role,
        peer_session_id: peerSessionId,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return false;
    }
    peer.ctlQueue.push(encoded);
    if (frame.typeId !== FRAME_PING) {
      this.recordEvent("queue_ctl", {
        role,
        peer_session_id: peerSessionId,
        type_id: frame.typeId,
        stream_id: frame.streamId,
        payload_bytes: frame.payload ? frame.payload.length : 0
      }, { durable: false });
    }
    this.metrics.frames_out.ctl += 1;
    peer.notifyWaiters(LANE_CTL);
    this.scheduleFlush(peer, LANE_CTL);
    return true;
  }

  laneProfile(lane) {
    return this.laneProfiles[lane] || this.laneProfiles.bulk;
  }

  async nextCtlPayload(peer, waitTimeoutMs) {
    let first = peer.ctlQueue.shift();
    if (!first) {
      const notified = await peer.waitForLane(LANE_CTL, waitTimeoutMs);
      if (!notified) {
        return pingFramePayload();
      }
      first = peer.ctlQueue.shift();
      if (!first) {
        return pingFramePayload();
      }
    }
    peer.touch();
    const firstTypeId = first.readUInt8(0);
    const firstStreamId = first.readUInt32BE(4);
    if (firstTypeId !== FRAME_PING) {
      this.recordEvent("dequeue_ctl", {
        role: peer.role,
        peer_session_id: peer.peerSessionId,
        type_id: firstTypeId,
        stream_id: firstStreamId,
        bytes: first.length
      }, { durable: false });
    }
    const profile = this.laneProfile(LANE_CTL);
    const payloads = [first];
    let total = first.length;
    let frames = 1;
    const deadline = Date.now() + profile.holdMs;
    while (total < profile.maxBytes && frames < profile.maxFrames && Date.now() < deadline) {
      const next = peer.ctlQueue.shift();
      if (!next) {
        break;
      }
      payloads.push(next);
      total += next.length;
      frames += 1;
    }
    this.metrics.ws_bytes_out.ctl += 0;
    return paddedPayload(Buffer.concat(payloads), profile.padMin);
  }

  async nextDataPayload(peer, waitTimeoutMs) {
    let first = peer.dataPriQueue.shift();
    let sourceLane = "pri";
    if (!first) {
      first = peer.dataBulkQueue.shift();
      sourceLane = "bulk";
    }
    if (!first) {
      const notified = await peer.waitForLane(LANE_DATA, waitTimeoutMs);
      if (!notified) {
        return pingFramePayload();
      }
      first = peer.dataPriQueue.shift();
      sourceLane = "pri";
      if (!first) {
        first = peer.dataBulkQueue.shift();
        sourceLane = "bulk";
      }
      if (!first) {
        first = this.nextReplayPayload(peer, "pri") || this.nextReplayPayload(peer, "bulk");
        sourceLane = first ? (peer.dataReplayByPayload.get(first)?.replayLane || "bulk") : sourceLane;
        if (!first) {
          return pingFramePayload();
        }
      }
    }
    this.noteDataSent(peer, first);
    peer.touch();
    const profile = this.laneProfile(sourceLane);
    const queue = sourceLane === "pri" ? peer.dataPriQueue : peer.dataBulkQueue;
    const payloads = [first];
    let total = first.length;
    let frames = 1;
    const deadline = Date.now() + profile.holdMs;
    while (total < profile.maxBytes && frames < profile.maxFrames && Date.now() < deadline) {
      let next = queue.shift();
      if (!next) {
        next = this.nextReplayPayload(peer, sourceLane);
      }
      if (!next) {
        break;
      }
      this.noteDataSent(peer, next);
      payloads.push(next);
      total += next.length;
      frames += 1;
    }
    return profile.padMin > 0 ? paddedPayload(Buffer.concat(payloads), profile.padMin) : Buffer.concat(payloads);
  }

  noteDataSent(peer, payload) {
    const entry = peer.dataReplayByPayload.get(payload);
    if (!entry) {
      return;
    }
    entry.sentAtMs = nowMs();
  }

  nextReplayPayload(peer, lane) {
    const entries = peer.dataReplay[lane];
    const cutoff = nowMs() - this.dataReplayResendMs;
    for (const entry of entries) {
      if (entry.sentAtMs > 0 && entry.sentAtMs <= cutoff) {
        return entry.encoded;
      }
    }
    return null;
  }

  pruneAckedData(role, peerSessionId, streamId, ackOffset) {
    const peer = this.peers.get(this.peerKey(role, peerSessionId));
    if (!peer) {
      return;
    }
    for (const lane of ["pri", "bulk"]) {
      const retained = [];
      for (const entry of peer.dataReplay[lane]) {
        if (entry.streamId === streamId && entry.endOffset <= ackOffset) {
          peer.dataReplayByPayload.delete(entry.encoded);
          continue;
        }
        retained.push(entry);
      }
      peer.dataReplay[lane] = retained;
    }
  }

  clearStreamReplay(stream) {
    this.pruneAckedData("helper", stream.helperSessionId, stream.helperStreamId, Number.MAX_SAFE_INTEGER);
    this.pruneAckedData("agent", stream.agentSessionId, stream.agentStreamId, Number.MAX_SAFE_INTEGER);
  }

  scheduleFlush(peer, lane) {
    if (peer.flushScheduled[lane]) {
      return;
    }
    peer.flushScheduled[lane] = true;
    const loop = () => {
      const ws = peer.channels[lane];
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        peer.flushScheduled[lane] = false;
        return;
      }
      if (ws.bufferedAmount > this.flushBackpressureBytes) {
        setTimeout(loop, this.flushRetryDelayMs);
        return;
      }
      let payload = null;
      let sourceKind = lane;
      if (lane === LANE_CTL) {
        payload = peer.ctlQueue.shift();
      } else {
        payload = peer.dataPriQueue.shift();
        if (payload) {
          sourceKind = "pri";
        } else {
          payload = peer.dataBulkQueue.shift();
          sourceKind = "bulk";
        }
      }
      if (!payload) {
        peer.flushScheduled[lane] = false;
        return;
      }
      this.metrics.ws_messages_out[lane] += 1;
      this.metrics.ws_bytes_out[lane] += payload.length;
      ws.send(payload, { binary: true }, (error) => {
        if (error) {
          if (lane === LANE_CTL) {
            peer.ctlQueue.items.unshift(payload);
            peer.ctlQueue.bufferedBytes += payload.length;
          } else if (sourceKind === "pri") {
            peer.dataPriQueue.items.unshift(payload);
            peer.dataPriQueue.bufferedBytes += payload.length;
          } else {
            peer.dataBulkQueue.items.unshift(payload);
            peer.dataBulkQueue.bufferedBytes += payload.length;
          }
          trace(`flush error lane=${lane} peer=${peer.peerSessionId} error=${error}`);
          runtimeLog(`flush error lane=${lane} role=${peer.role} label=${peer.peerLabel} peer=${peer.peerSessionId} error=${error}`);
          this.recordEvent("flush_error", {
            lane,
            peer_role: peer.role,
            peer_label: peer.peerLabel,
            peer_session_id: peer.peerSessionId,
            error: String(error && error.message ? error.message : error)
          });
          // Retry after a short delay so the frame isn't lost when no new
          // frames arrive to re-trigger scheduleFlush.
          setTimeout(loop, this.flushRetryDelayMs);
          return;
        }
        setImmediate(loop);
      });
    };
    setImmediate(loop);
  }

  handleFrame(senderRole, senderPeerSessionId, lane, frame) {
    if (frame.typeId === FRAME_PING) {
      return;
    }
    if (frame.typeId !== FRAME_DATA) {
      this.recordEvent("frame_in", {
        sender_role: senderRole,
        sender_peer_session_id: senderPeerSessionId,
        lane,
        type_id: frame.typeId,
        stream_id: frame.streamId,
        payload_bytes: frame.payload ? frame.payload.length : 0
      }, { durable: false });
    }
    if (frame.typeId === FRAME_OPEN && senderRole === "helper") {
      this.handleOpen(senderPeerSessionId, frame);
      return;
    }
    if (frame.typeId === FRAME_DNS_QUERY && senderRole === "helper") {
      this.handleDnsQuery(senderPeerSessionId, lane, frame);
      return;
    }
    if (frame.typeId === FRAME_DNS_RESPONSE || frame.typeId === FRAME_DNS_FAIL) {
      this.handleDnsResult(senderRole, senderPeerSessionId, lane, frame);
      return;
    }
    const stream = senderRole === "helper"
      ? this.streamsByHelper.get(this.streamHelperKey(senderPeerSessionId, frame.streamId))
      : this.streamsByAgent.get(frame.streamId);
    if (!stream) {
      trace(`drop frame type=${frame.typeId} stream=${frame.streamId} from=${senderRole}/${senderPeerSessionId} lane=${lane} reason=unknown-stream`);
      return;
    }
    stream.touch();
    if (frame.typeId === FRAME_WINDOW) {
      if (senderRole === "helper") {
        stream.helperAckOffset += Number(frame.offset || 0);
        this.pruneAckedData("helper", stream.helperSessionId, stream.helperStreamId, stream.helperAckOffset);
      } else {
        stream.agentAckOffset += Number(frame.offset || 0);
        this.pruneAckedData("agent", stream.agentSessionId, stream.agentStreamId, stream.agentAckOffset);
      }
    }
    if (frame.typeId === FRAME_FIN) {
      if (senderRole === "helper") {
        stream.helperFinSeen = true;
        stream.helperFinOffset = Number(frame.offset || 0);
      } else {
        stream.agentFinSeen = true;
        stream.agentFinOffset = Number(frame.offset || 0);
      }
    }
    let targetRole;
    let targetPeerSessionId;
    let outboundStreamId;
    if (senderRole === "helper") {
      targetRole = "agent";
      targetPeerSessionId = stream.agentSessionId;
      outboundStreamId = stream.agentStreamId;
    } else {
      targetRole = "helper";
      targetPeerSessionId = stream.helperSessionId;
      outboundStreamId = stream.helperStreamId;
    }
    const outboundFrame = {
      typeId: frame.typeId,
      flags: frame.flags,
      streamId: outboundStreamId,
      offset: frame.offset,
      payload: frame.payload
    };
    const targetLane = this.targetLaneForRole(targetRole, lane, frame.typeId);
    const queued = this.queueFrame(targetRole, targetPeerSessionId, outboundFrame, targetLane);
    if (queued) {
      this.recordEvent("frame_forward", {
        sender_role: senderRole,
        sender_peer_session_id: senderPeerSessionId,
        target_role: targetRole,
        target_peer_session_id: targetPeerSessionId,
        type_id: frame.typeId,
        source_stream_id: frame.streamId,
        target_stream_id: outboundStreamId
      }, { durable: false });
    }
    if (!queued && senderRole === "helper") {
      this.queueFrame("helper", senderPeerSessionId, {
        typeId: FRAME_RST,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload("broker queue full")
      }, this.helperControlLane());
    }
    if (frame.typeId === FRAME_RST) {
      this.dropStream(stream);
      return;
    }
    if ((frame.typeId === FRAME_FIN || frame.typeId === FRAME_WINDOW) && this.streamDeliveryComplete(stream)) {
      this.dropStream(stream);
    }
  }

  handleDnsQuery(helperSessionId, lane, frame) {
    let openError = "";
    let agentSessionId = this.agentSessionId;
    const helperPeer = this.peers.get(this.peerKey("helper", helperSessionId));
    const helperPeerLabel = helperPeer ? helperPeer.peerLabel : helperSessionId;
    if (!helperPeer) {
      openError = "helper session unavailable";
    }
    if (agentSessionId && !this.peers.has(this.peerKey("agent", agentSessionId))) {
      agentSessionId = "";
    }
    let agentRequestId = 0;
    if (agentSessionId && !openError) {
      agentRequestId = this.allocateAgentDnsRequestId();
      const query = new DnsQueryState(
        helperSessionId,
        helperPeerLabel,
        frame.streamId,
        agentSessionId,
        agentRequestId
      );
      this.dnsQueriesByHelper.set(this.dnsHelperKey(helperSessionId, frame.streamId), query);
      this.dnsQueriesByAgent.set(agentRequestId, query);
      this.recordEvent("dns_query_map", {
        helper_session_id: helperSessionId,
        helper_peer_label: helperPeerLabel,
        helper_request_id: frame.streamId,
        agent_session_id: agentSessionId,
        agent_request_id: agentRequestId
      });
    }
    if (openError) {
      this.queueFrame("helper", helperSessionId, {
        typeId: FRAME_DNS_FAIL,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload(openError)
      }, "pri");
      return;
    }
    if (!agentSessionId) {
      this.queueFrame("helper", helperSessionId, {
        typeId: FRAME_DNS_FAIL,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload("hidden agent unavailable")
      }, "pri");
      return;
    }
    const queued = this.queueFrame("agent", agentSessionId, {
      typeId: FRAME_DNS_QUERY,
      flags: frame.flags,
      streamId: agentRequestId,
      offset: frame.offset,
      payload: frame.payload
    }, lane === "bulk" ? "bulk" : "pri");
    if (queued) {
      return;
    }
    const query = this.dnsQueriesByHelper.get(this.dnsHelperKey(helperSessionId, frame.streamId));
    if (query) {
      this.dropDnsQuery(query, "agent-queue-failed");
    }
    this.queueFrame("helper", helperSessionId, {
      typeId: FRAME_DNS_FAIL,
      flags: 0,
      streamId: frame.streamId,
      offset: 0,
      payload: makeErrorPayload("hidden agent unavailable")
    }, "pri");
  }

  handleDnsResult(senderRole, senderPeerSessionId, lane, frame) {
    if (senderRole !== "agent") {
      this.recordEvent("frame_drop", {
        reason: "unexpected-dns-result-sender",
        sender_role: senderRole,
        sender_peer_session_id: senderPeerSessionId,
        lane,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return;
    }
    const query = this.dnsQueriesByAgent.get(frame.streamId);
    if (!query) {
      this.recordEvent("frame_drop", {
        reason: "unknown-dns-query",
        sender_role: senderRole,
        sender_peer_session_id: senderPeerSessionId,
        lane,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return;
    }
    query.touch();
    this.queueFrame("helper", query.helperSessionId, {
      typeId: frame.typeId,
      flags: frame.flags,
      streamId: query.helperRequestId,
      offset: frame.offset,
      payload: frame.payload
    }, lane === "bulk" ? "bulk" : "pri");
    const liveQuery = this.dnsQueriesByAgent.get(frame.streamId);
    if (liveQuery) {
      this.dropDnsQuery(liveQuery, "completed");
    }
  }

  handleOpen(helperSessionId, frame) {
    let openError = "";
    let agentSessionId = this.agentSessionId;
    const helperPeer = this.peers.get(this.peerKey("helper", helperSessionId));
    const helperPeerLabel = helperPeer ? helperPeer.peerLabel : helperSessionId;
    if (!helperPeer) {
      openError = "helper session unavailable";
    } else {
      openError = this.reserveHelperOpen(helperPeer);
    }
    if (agentSessionId && !this.peers.has(this.peerKey("agent", agentSessionId))) {
      agentSessionId = "";
    }
    if (openError) {
      this.recordEvent("open_fail", {
        helper_session_id: helperSessionId,
        helper_stream_id: frame.streamId,
        reason: openError
      });
      this.queueFrame("helper", helperSessionId, {
        typeId: FRAME_OPEN_FAIL,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload(openError)
      }, this.helperControlLane());
      return;
    }
    if (!agentSessionId) {
      this.recordEvent("open_fail", {
        helper_session_id: helperSessionId,
        helper_stream_id: frame.streamId,
        reason: "no-agent"
      });
      this.queueFrame("helper", helperSessionId, {
        typeId: FRAME_OPEN_FAIL,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload("hidden agent unavailable")
      }, this.helperControlLane());
      return;
    }
    const agentStreamId = this.nextAgentStreamId++;
    const stream = new StreamState(helperSessionId, helperPeerLabel, frame.streamId, agentSessionId, agentStreamId);
    this.streamsByHelper.set(this.streamHelperKey(helperSessionId, frame.streamId), stream);
    this.streamsByAgent.set(agentStreamId, stream);
    helperPeer.activeStreams += 1;
    const agentPeer = this.peers.get(this.peerKey("agent", agentSessionId));
    if (agentPeer) {
      agentPeer.activeStreams += 1;
    }
    trace(`open helper=${helperPeerLabel}/${helperSessionId} helper_stream=${frame.streamId} agent_session=${agentSessionId} agent_stream=${agentStreamId}`);
    this.recordEvent("open_map", {
      helper_session_id: helperSessionId,
      helper_stream_id: frame.streamId,
      agent_session_id: agentSessionId,
      agent_stream_id: agentStreamId,
      helper_peer_label: helperPeerLabel
    });
    this.queueFrame(
      "agent",
      agentSessionId,
      {
        typeId: FRAME_OPEN,
        flags: frame.flags,
        streamId: agentStreamId,
        offset: frame.offset,
        payload: frame.payload
      },
      this.agentDownCombinedDataLane ? "pri" : null
    );
  }

  reserveHelperOpen(peer) {
    const currentMs = nowMs();
    const windowStart = currentMs - this.openRateWindowMs;
    peer.openEventsMs = peer.openEventsMs.filter((value) => value >= windowStart);
    if (peer.activeStreams >= this.maxStreamsPerPeerSession) {
      return "too many concurrent streams";
    }
    if (peer.openEventsMs.length >= this.maxOpenRatePerPeerSession) {
      return "too many new streams";
    }
    peer.openEventsMs.push(currentMs);
    return "";
  }

  dropStream(stream) {
    this.clearStreamReplay(stream);
    this.streamsByHelper.delete(this.streamHelperKey(stream.helperSessionId, stream.helperStreamId));
    this.streamsByAgent.delete(stream.agentStreamId);
    this.recordEvent("drop_stream", {
      helper_session_id: stream.helperSessionId,
      helper_stream_id: stream.helperStreamId,
      agent_session_id: stream.agentSessionId,
      agent_stream_id: stream.agentStreamId,
      helper_fin_seen: stream.helperFinSeen,
      agent_fin_seen: stream.agentFinSeen,
      helper_fin_offset: stream.helperFinOffset,
      agent_fin_offset: stream.agentFinOffset,
      helper_ack_offset: stream.helperAckOffset,
      agent_ack_offset: stream.agentAckOffset
    });
    const helperPeer = this.peers.get(this.peerKey("helper", stream.helperSessionId));
    if (helperPeer && helperPeer.activeStreams > 0) {
      helperPeer.activeStreams -= 1;
    }
    const agentPeer = this.peers.get(this.peerKey("agent", stream.agentSessionId));
    if (agentPeer && agentPeer.activeStreams > 0) {
      agentPeer.activeStreams -= 1;
    }
  }

  dropDnsQuery(query, reason = "") {
    this.dnsQueriesByHelper.delete(this.dnsHelperKey(query.helperSessionId, query.helperRequestId));
    this.dnsQueriesByAgent.delete(query.agentRequestId);
    this.recordEvent("drop_dns_query", {
      helper_session_id: query.helperSessionId,
      helper_peer_label: query.helperPeerLabel,
      helper_request_id: query.helperRequestId,
      agent_session_id: query.agentSessionId,
      agent_request_id: query.agentRequestId,
      reason
    });
  }

  streamDeliveryComplete(stream) {
    if (!(stream.helperFinSeen && stream.agentFinSeen)) {
      return false;
    }
    const helperDone = stream.agentFinOffset !== null && stream.helperAckOffset >= Number(stream.agentFinOffset);
    const agentDone = stream.helperFinOffset !== null && stream.agentAckOffset >= Number(stream.helperFinOffset);
    return helperDone && agentDone;
  }

  cleanup() {
    const peerCutoff = nowMs() - this.peerTtlMs;
    const streamCutoff = nowMs() - this.streamTtlMs;
    const dnsQueryCutoff = nowMs() - this.dnsQueryTtlMs;
    for (const [key, peer] of this.peers.entries()) {
      if (peer.lastSeenMs >= peerCutoff) {
        continue;
      }
      const staleStreams = [];
      for (const stream of this.streamsByAgent.values()) {
        if (stream.helperSessionId === peer.peerSessionId || stream.agentSessionId === peer.peerSessionId) {
          staleStreams.push(stream);
        }
      }
      for (const stream of staleStreams) {
        this.recordEvent("cleanup_peer_expired", {
          role: peer.role,
          peer_label: peer.peerLabel,
          peer_session_id: peer.peerSessionId,
          helper_session_id: stream.helperSessionId,
          helper_stream_id: stream.helperStreamId,
          agent_session_id: stream.agentSessionId,
          agent_stream_id: stream.agentStreamId
        });
        if (peer.role === "helper" && stream.agentSessionId) {
          this.queueFrame("agent", stream.agentSessionId, {
            typeId: FRAME_RST,
            flags: 0,
            streamId: stream.agentStreamId,
            offset: 0,
            payload: makeErrorPayload("peer expired")
          });
        }
        if (peer.role === "agent" && stream.helperSessionId) {
          this.queueFrame("helper", stream.helperSessionId, {
            typeId: FRAME_RST,
            flags: 0,
            streamId: stream.helperStreamId,
            offset: 0,
            payload: makeErrorPayload("peer expired")
          }, this.helperControlLane());
        }
        this.dropStream(stream);
      }
      const staleDnsQueries = [];
      for (const query of this.dnsQueriesByAgent.values()) {
        if (query.helperSessionId === peer.peerSessionId || query.agentSessionId === peer.peerSessionId) {
          staleDnsQueries.push(query);
        }
      }
      for (const query of staleDnsQueries) {
        if (peer.role === "agent") {
          this.queueFrame("helper", query.helperSessionId, {
            typeId: FRAME_DNS_FAIL,
            flags: 0,
            streamId: query.helperRequestId,
            offset: 0,
            payload: makeErrorPayload("peer expired")
          }, "pri");
        }
        this.dropDnsQuery(query, "peer-expired");
      }
      this.peers.delete(key);
      if (peer.role === "agent" && this.agentSessionId === peer.peerSessionId) {
        this.agentSessionId = "";
        this.agentPeerLabel = "";
      }
    }
    for (const stream of Array.from(this.streamsByAgent.values())) {
      if (stream.lastSeenMs >= streamCutoff) {
        continue;
      }
      this.recordEvent("cleanup_stream_expired", {
        helper_session_id: stream.helperSessionId,
        helper_stream_id: stream.helperStreamId,
        agent_session_id: stream.agentSessionId,
        agent_stream_id: stream.agentStreamId
      });
      this.queueFrame("helper", stream.helperSessionId, {
        typeId: FRAME_RST,
        flags: 0,
        streamId: stream.helperStreamId,
        offset: 0,
        payload: makeErrorPayload("stream expired")
      }, this.helperControlLane());
      this.queueFrame("agent", stream.agentSessionId, {
        typeId: FRAME_RST,
        flags: 0,
        streamId: stream.agentStreamId,
        offset: 0,
        payload: makeErrorPayload("stream expired")
      });
      this.dropStream(stream);
    }
    for (const query of Array.from(this.dnsQueriesByAgent.values())) {
      if (query.lastSeenMs >= dnsQueryCutoff) {
        continue;
      }
      this.recordEvent("cleanup_dns_query_expired", {
        helper_session_id: query.helperSessionId,
        helper_request_id: query.helperRequestId,
        agent_session_id: query.agentSessionId,
        agent_request_id: query.agentRequestId
      });
      this.queueFrame("helper", query.helperSessionId, {
        typeId: FRAME_DNS_FAIL,
        flags: 0,
        streamId: query.helperRequestId,
        offset: 0,
        payload: makeErrorPayload("dns query expired")
      }, "pri");
      this.dropDnsQuery(query, "query-expired");
    }
  }

  stats() {
    const buffered = { ctl: 0, pri: 0, bulk: 0 };
    const peers = [];
    for (const peer of this.peers.values()) {
      buffered.ctl += peer.ctlQueue.bufferedBytes;
      buffered.pri += peer.dataPriQueue.bufferedBytes;
      buffered.bulk += peer.dataBulkQueue.bufferedBytes;
      if (DEBUG_STATS_ENABLED) {
        peers.push({
          role: peer.role,
          peer_label: peer.peerLabel,
          peer_session_id: peer.peerSessionId,
          active_streams: peer.activeStreams,
          ctl_buffered_bytes: peer.ctlQueue.bufferedBytes,
          pri_buffered_bytes: peer.dataPriQueue.bufferedBytes,
          bulk_buffered_bytes: peer.dataBulkQueue.bufferedBytes,
          last_seen_age_ms: Math.max(0, nowMs() - peer.lastSeenMs),
          channel_open: {
            ctl: Boolean(peer.channels.ctl && peer.channels.ctl.readyState === WebSocket.OPEN),
            data: Boolean(peer.channels.data && peer.channels.data.readyState === WebSocket.OPEN)
          }
        });
      }
    }
    const payload = {
      ok: true,
      pid: process.pid,
      peers: this.peers.size,
      streams: this.streamsByAgent.size,
      dns_queries: this.dnsQueriesByAgent.size,
      agent_peer_label: this.agentPeerLabel,
      agent_session_id: this.agentSessionId,
      base_uri: this.baseUri,
      log_paths: {
        runtime: RUNTIME_LOG_PATH,
        events: EVENT_LOG_PATH
      },
      buffered_ctl_bytes: buffered.ctl,
      buffered_pri_bytes: buffered.pri,
      buffered_bulk_bytes: buffered.bulk,
      capabilities: brokerCapabilities(),
      metrics: this.metrics,
      recent_event_count: this.recentEvents.length
    };
    if (DEBUG_STATS_ENABLED) {
      payload.peer_details = peers;
      payload.stream_details = Array.from(this.streamsByAgent.values()).slice(0, 32).map((stream) => ({
        helper_session_id: stream.helperSessionId,
        helper_stream_id: stream.helperStreamId,
        agent_session_id: stream.agentSessionId,
        agent_stream_id: stream.agentStreamId,
        age_ms: Math.max(0, nowMs() - stream.createdAtMs),
        last_seen_age_ms: Math.max(0, nowMs() - stream.lastSeenMs)
      }));
      payload.recent_events = this.recentEvents.slice(-64);
    }
    return payload;
  }
}

const loadedConfig = loadConfig();
if (!TRACE_ENABLED && loadedConfig.trace_enabled) {
  TRACE_ENABLED = true;
}
if (!DEBUG_STATS_ENABLED && loadedConfig.debug_stats_enabled) {
  DEBUG_STATS_ENABLED = true;
}
RUNTIME_LOG_PATH = resolveLogPath(
  loadedConfig.log_path,
  process.env.TWOMAN_RUNTIME_LOG_PATH || process.env.TWOMAN_LOG_PATH,
  "node-broker.log"
);
EVENT_LOG_PATH = resolveLogPath(
  loadedConfig.event_log_path,
  process.env.TWOMAN_EVENT_LOG_PATH,
  "node-broker-events.ndjson"
);
RUNTIME_LOG_MAX_BYTES = coerceInt(
  loadedConfig.log_max_bytes || process.env.TWOMAN_RUNTIME_LOG_MAX_BYTES,
  DEFAULT_RUNTIME_LOG_MAX_BYTES
);
RUNTIME_LOG_BACKUP_COUNT = coerceInt(
  loadedConfig.log_backup_count || process.env.TWOMAN_RUNTIME_LOG_BACKUP_COUNT,
  DEFAULT_RUNTIME_LOG_BACKUP_COUNT,
  0
);
EVENT_LOG_MAX_BYTES = coerceInt(
  loadedConfig.event_log_max_bytes || process.env.TWOMAN_EVENT_LOG_MAX_BYTES,
  DEFAULT_EVENT_LOG_MAX_BYTES
);
EVENT_LOG_BACKUP_COUNT = coerceInt(
  loadedConfig.event_log_backup_count || process.env.TWOMAN_EVENT_LOG_BACKUP_COUNT,
  DEFAULT_EVENT_LOG_BACKUP_COUNT,
  0
);
RECENT_EVENT_LIMIT = coerceInt(
  loadedConfig.recent_event_limit || process.env.TWOMAN_RECENT_EVENT_LIMIT,
  DEFAULT_RECENT_EVENT_LIMIT
);
BINARY_MEDIA_TYPE = String(
  loadedConfig.binary_media_type || process.env.TWOMAN_BINARY_MEDIA_TYPE || DEFAULT_BINARY_MEDIA_TYPE
).trim() || DEFAULT_BINARY_MEDIA_TYPE;
ensureLogDir(RUNTIME_LOG_PATH);
ensureLogDir(EVENT_LOG_PATH);
const state = new BrokerState(loadedConfig);
state.recordEvent("broker_loaded", {
  config_path: CONFIG_PATH,
  runtime_log_path: RUNTIME_LOG_PATH,
  event_log_path: EVENT_LOG_PATH
});
runtimeLog(`broker loaded config_path=${CONFIG_PATH} runtime_log_path=${RUNTIME_LOG_PATH} event_log_path=${EVENT_LOG_PATH}`);
var healthPublic = Boolean(loadedConfig.health_public);
function getTokenStr(role) {
  if (role === "agent" && loadedConfig.agent_tokens && loadedConfig.agent_tokens.length > 0) {
    return loadedConfig.agent_tokens[0];
  }
  if (role !== "agent" && loadedConfig.client_tokens && loadedConfig.client_tokens.length > 0) {
    return loadedConfig.client_tokens[0];
  }
  return "twoman-default-key";
}

function jsonResponse(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function parseCookieHeader(value) {
  const cookies = {};
  for (const chunk of String(value || "").split(";")) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    cookies[name] = decodeURIComponent(rawValue);
  }
  return cookies;
}

function normalizeMediaType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function validateBinaryMediaType(value) {
  const allowed = new Set([BINARY_MEDIA_TYPE, "application/octet-stream"]);
  if (!allowed.has(normalizeMediaType(value))) {
    throw new Error(`invalid binary content type: ${value || "<missing>"}`);
  }
}

function isHealthRoute(route) {
  return route === "/health" || route.endsWith("/health");
}

function parseLaneRoute(route) {
  const parts = route.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return {
    lane: parts[parts.length - 2],
    direction: parts[parts.length - 1]
  };
}

function parseWebSocketLaneRoute(route) {
  const parts = route.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 1) {
    return "";
  }
  return parts[parts.length - 1];
}

function connectionHeaders(req) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const authorization = String(req.headers.authorization || "");
  let token = "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    token = authorization.slice(7).trim();
  }
  if (!token) {
    token = String(cookies.twoman_auth || cookies._cfauth || req.headers["x-relay-token"] || "");
  }
  return {
    token,
    role: String(cookies._cf_role || req.headers["x-cf-role"] || ""),
    peer: String(cookies._cf_lspa || req.headers["x-cf-lspa"] || ""),
    session: String(cookies._wp_syncId || req.headers["x-wp-syncid"] || "")
  };
}

function isObserverAuthorized(req) {
  const identity = connectionHeaders(req);
  return state.auth("helper", identity.token) || state.auth("agent", identity.token);
}

async function handleConnectProbe(req, res, url) {
  const host = url.searchParams.get("host") || "";
  const port = Number(url.searchParams.get("port") || "0");
  if (!host || !port) {
    jsonResponse(res, 400, { error: "host and port are required" });
    return;
  }
  const started = Date.now();
  const socket = new net.Socket();
  socket.setTimeout(5000);
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(payload);
    };
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, error: "timeout" }));
    socket.once("error", (error) => finish({ ok: false, error: String(error.message || error) }));
    socket.connect(port, host);
  });
  if (result.ok) {
    state.metrics.connect_probe.ok += 1;
  } else {
    state.metrics.connect_probe.fail += 1;
  }
  jsonResponse(res, 200, {
    host,
    port,
    ok: result.ok,
    error: result.error || "",
    time_ms: Date.now() - started
  });
}

function handleChunkStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
    "Transfer-Encoding": "chunked"
  });
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    res.write(`tick ${count} ${Date.now()}\n`);
    if (count >= 30) {
      clearInterval(timer);
      res.end("done\n");
    }
  }, 1000);
  res.on("close", () => clearInterval(timer));
}

async function handleUploadProbe(req, res) {
  const started = Date.now();
  const events = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    events.push({
      offset_ms: Date.now() - started,
      chunk_bytes: chunk.length,
      total_bytes: totalBytes
    });
  }
  jsonResponse(res, 200, {
    ok: true,
    total_bytes: totalBytes,
    chunks: events.length,
    events
  });
}

function processInboundFrames(role, sessionId, externalLane, decoder, chunk) {
  const frames = decoder.feed(chunk);
  for (const frame of frames) {
    let logicalLane = externalLane;
    if (externalLane === LANE_DATA) {
      if (frame.typeId === FRAME_DATA) {
        logicalLane = (frame.flags & FLAG_DATA_BULK) ? "bulk" : "pri";
      } else if (DNS_FRAME_TYPES.has(frame.typeId)) {
        logicalLane = "pri";
      } else {
        logicalLane = LANE_CTL;
      }
    }
    state.metrics.frames_in[logicalLane] += 1;
    state.handleFrame(role, sessionId, logicalLane, frame);
  }
  return frames.length;
}

async function handleLaneDownStream(peer, lane, res) {
  const started = Date.now();
  const jitterFactor = 0.85 + Math.random() * 0.30;
  const maxDurationMs = Math.round(state.streamMaxDurationMs * jitterFactor);
  const waitTimeoutMs = lane === LANE_CTL ? 1000 : 1000;
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  res.writeHead(200, {
    "Content-Type": BINARY_MEDIA_TYPE,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
    "Transfer-Encoding": "chunked"
  });
  try {
    const tokenStr = getTokenStr(peer.role);
    const iv = crypto.randomBytes(16);
    const cipher = new TransportCipher(Buffer.from(tokenStr), iv);
    
    if (!res.write(iv)) {
      await new Promise((resolve) => res.once("drain", resolve));
    }

    while (!closed && !res.writableEnded && (Date.now() - started) < maxDurationMs) {
      const payload = lane === LANE_CTL
        ? await state.nextCtlPayload(peer, waitTimeoutMs)
        : await state.nextDataPayload(peer, waitTimeoutMs);
      if (!payload || payload.length === 0) {
        continue;
      }
      const ctPayload = cipher.process(payload);
      if (!res.write(ctPayload)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
      peer.touch();
    }
  } finally {
    if (!closed && !res.writableEnded) {
      res.end();
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = state.normalizePath(url.pathname);
  if (isHealthRoute(route)) {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    jsonResponse(res, 200, state.stats());
    return;
  }
  if (route === "/pid") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    jsonResponse(res, 200, { pid: process.pid });
    return;
  }
  if (route === "/connect-probe") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    await handleConnectProbe(req, res, url);
    return;
  }
  if (route === "/stream") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    handleChunkStream(res);
    return;
  }
  if (route === "/upload_probe" && req.method === "POST") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    await handleUploadProbe(req, res);
    return;
  }
  const parsedRoute = parseLaneRoute(route);
  if (parsedRoute && (parsedRoute.lane === LANE_CTL || parsedRoute.lane === LANE_DATA) && (parsedRoute.direction === "up" || parsedRoute.direction === "down")) {
    const lane = parsedRoute.lane;
    const direction = parsedRoute.direction;
    const headers = connectionHeaders(req);
    if (!headers.role || !headers.peer || !headers.session || !state.auth(headers.role, headers.token)) {
      jsonResponse(res, 403, { error: "invalid role or token" });
      return;
    }
    const peer = state.ensurePeer(headers.role, headers.peer, headers.session);
    if (req.method === "POST" && direction === "up") {
      try {
        validateBinaryMediaType(req.headers["content-type"]);
      } catch (error) {
        jsonResponse(res, 415, { error: error.message });
        return;
      }
      const decoder = new FrameDecoder();
      let frameCount = 0;
      let initCipher = null;
      let ivBuffer = Buffer.alloc(0);
      const tokenStr = getTokenStr(headers.role);

      for await (let chunk of req) {
        if (!initCipher) {
            const needed = 16 - ivBuffer.length;
            if (chunk.length >= needed) {
                ivBuffer = Buffer.concat([ivBuffer, chunk.subarray(0, needed)]);
                chunk = chunk.subarray(needed);
                initCipher = new TransportCipher(Buffer.from(tokenStr), ivBuffer);
            } else {
                ivBuffer = Buffer.concat([ivBuffer, chunk]);
                continue;
            }
        }
        if (chunk.length > 0) {
            const ptChunk = initCipher.process(chunk);
            frameCount += processInboundFrames(headers.role, headers.session, lane, decoder, ptChunk);
        }
      }
      jsonResponse(res, 200, { ok: true, frames: frameCount });
      return;
    }
    if (req.method === "GET" && direction === "down") {
      const roleDownWaitMs = state.downWaitMsForRole(headers.role);
      if (
        lane === LANE_CTL &&
        ((headers.role === "helper" && state.streamingCtlDownHelper) ||
          (headers.role === "agent" && state.streamingCtlDownAgent))
      ) {
        await handleLaneDownStream(peer, lane, res);
        return;
      }
      if (
        lane === LANE_DATA &&
        ((headers.role === "helper" && state.streamingDataDownHelper) ||
          (headers.role === "agent" && state.streamingDataDownAgent))
      ) {
        await handleLaneDownStream(peer, lane, res);
        return;
      }
      const payload = lane === LANE_CTL
        ? await state.nextCtlPayload(peer, roleDownWaitMs.ctl)
        : await state.nextDataPayload(peer, roleDownWaitMs.data);
        
      const tokenStr = getTokenStr(headers.role);
      const iv = crypto.randomBytes(16);
      const cipher = new TransportCipher(Buffer.from(tokenStr), iv);
      const encPayload = Buffer.concat([iv, cipher.process(payload)]);

      res.writeHead(200, {
        "Content-Type": BINARY_MEDIA_TYPE,
        "Content-Length": String(encPayload.length),
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(encPayload);
      return;
    }
    jsonResponse(res, 405, { error: "method not allowed" });
    return;
  }
  jsonResponse(res, 404, { error: "not found", path: route });
});

const wss = new WebSocketServer({ noServer: true });
const echoWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const route = state.normalizePath(url.pathname);
  if (route === "/ws-echo") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    echoWss.handleUpgrade(req, socket, head, (ws) => {
      echoWss.emit("connection", ws, req);
    });
    return;
  }
  const lane = parseWebSocketLaneRoute(route);
  if (lane !== LANE_CTL && lane !== LANE_DATA) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const headers = connectionHeaders(req);
  if (!headers.role || !headers.peer || !headers.session || !state.auth(headers.role, headers.token)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._twomanHeaders = headers;
    ws._twomanLane = lane;
    wss.emit("connection", ws, req);
  });
});

echoWss.on("connection", (ws) => {
  ws.on("message", (message, isBinary) => {
    ws.send(message, { binary: isBinary });
  });
});

wss.on("connection", (ws) => {
  const headers = ws._twomanHeaders;
  const lane = ws._twomanLane;
  const peer = state.bindChannel(headers.role, headers.peer, headers.session, lane, ws);
  const decoder = new FrameDecoder();
  
  const tokenStr = getTokenStr(headers.role);
  const sendIv = crypto.randomBytes(16);
  const sendCipher = new TransportCipher(Buffer.from(tokenStr), sendIv);
  let recvCipher = null;
  let recvIvBuffer = Buffer.alloc(0);
  
  const originalSend = ws.send.bind(ws);
  let firstMsg = true;
  ws.send = (data, options, cb) => {
      const ctPayload = sendCipher.process(data);
      if (firstMsg) {
          firstMsg = false;
          return originalSend(Buffer.concat([sendIv, ctPayload]), options, cb);
      }
      return originalSend(ctPayload, options, cb);
  };

  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (message) => {
    let data = Buffer.isBuffer(message) ? message : Buffer.from(message);
    
    if (!recvCipher) {
        const needed = 16 - recvIvBuffer.length;
        if (data.length >= needed) {
            recvIvBuffer = Buffer.concat([recvIvBuffer, data.subarray(0, needed)]);
            data = data.subarray(needed);
            recvCipher = new TransportCipher(Buffer.from(tokenStr), recvIvBuffer);
        } else {
            recvIvBuffer = Buffer.concat([recvIvBuffer, data]);
            return;
        }
    }
    
    if (data.length > 0) {
        const ptData = recvCipher.process(data);
        peer.touch();
        state.metrics.ws_messages_in[lane] += 1;
        state.metrics.ws_bytes_in[lane] += ptData.length;
        processInboundFrames(headers.role, headers.session, lane, decoder, ptData);
    }
  });
  ws.on("close", () => {
    state.unbindChannel(ws._twomanPeerKey, lane, ws);
  });
  ws.on("error", (error) => {
    trace(`ws error role=${headers.role} session=${headers.session} lane=${lane} error=${error}`);
    runtimeLog(`ws error role=${headers.role} label=${headers.peer} session=${headers.session} lane=${lane} error=${error}`);
    state.recordEvent("ws_error", {
      role: headers.role,
      peer_label: headers.peer,
      peer_session_id: headers.session,
      lane,
      error: String(error && error.message ? error.message : error)
    });
  });
  trace(`channel open role=${headers.role} label=${headers.peer} session=${headers.session} lane=${lane}`);
  state.recordEvent("channel_open", {
    role: headers.role,
    peer_label: headers.peer,
    peer_session_id: headers.session,
    lane
  });
});

setInterval(() => {
  state.cleanup();
}, 10000).unref();

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS).unref();

server.listen(process.env.PORT || 3000, () => {
  trace(`listening pid=${process.pid} base_uri=${state.baseUri || "/"}`);
  runtimeLog(`listening pid=${process.pid} base_uri=${state.baseUri || "/"} runtime_log_path=${RUNTIME_LOG_PATH} event_log_path=${EVENT_LOG_PATH}`);
  state.recordEvent("broker_started", {
    pid: process.pid,
    base_uri: state.baseUri || "/",
    runtime_log_path: RUNTIME_LOG_PATH,
    event_log_path: EVENT_LOG_PATH
  });
});

process.on("uncaughtException", (error) => {
  trace(`uncaughtException pid=${process.pid} error=${error && error.stack ? error.stack : error}`);
  runtimeLog(`uncaughtException pid=${process.pid} error=${error && error.stack ? error.stack : error}`);
  state.recordEvent("uncaught_exception", {
    pid: process.pid,
    error: String(error && error.stack ? error.stack : error)
  });
});

process.on("unhandledRejection", (reason) => {
  trace(`unhandledRejection pid=${process.pid} reason=${reason && reason.stack ? reason.stack : reason}`);
  runtimeLog(`unhandledRejection pid=${process.pid} reason=${reason && reason.stack ? reason.stack : reason}`);
  state.recordEvent("unhandled_rejection", {
    pid: process.pid,
    reason: String(reason && reason.stack ? reason.stack : reason)
  });
});

process.on("beforeExit", (code) => {
  trace(`beforeExit pid=${process.pid} code=${code}`);
  runtimeLog(`beforeExit pid=${process.pid} code=${code}`);
  state.recordEvent("before_exit", { pid: process.pid, code });
});

process.on("exit", (code) => {
  trace(`exit pid=${process.pid} code=${code}`);
  runtimeLog(`exit pid=${process.pid} code=${code}`);
  state.recordEvent("exit", { pid: process.pid, code });
});

process.on("SIGTERM", () => {
  trace(`signal pid=${process.pid} sig=SIGTERM`);
  runtimeLog(`signal pid=${process.pid} sig=SIGTERM`);
  state.recordEvent("signal", { pid: process.pid, signal: "SIGTERM" });
});

process.on("SIGINT", () => {
  trace(`signal pid=${process.pid} sig=SIGINT`);
  runtimeLog(`signal pid=${process.pid} sig=SIGINT`);
  state.recordEvent("signal", { pid: process.pid, signal: "SIGINT" });
});

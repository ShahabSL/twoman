import type { ClientProfile } from "@/lib/types";

const PROFILE_SHARE_PREFIX = "twoman://profile?data=";
const DEFAULT_HTTP_PORT = 28167;
const DEFAULT_SOCKS_PORT = 21167;

function encodeBase64Url(input: string) {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string) {
  const padded = input + "=".repeat((4 - (input.length % 4 || 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function exportProfileShare(profile: ClientProfile) {
  const payload: Record<string, unknown> = {
    name: profile.name,
    brokerBaseUrl: profile.brokerBaseUrl,
    clientToken: profile.clientToken,
    targetAgentPeerLabel: profile.targetAgentPeerLabel,
    verifyTls: profile.verifyTls,
    http2Ctl: profile.http2Ctl,
    http2Data: profile.http2Data,
    httpTimeoutSeconds: profile.httpTimeoutSeconds,
    idleRepollCtlSeconds: profile.idleRepollCtlSeconds,
    idleRepollDataSeconds: profile.idleRepollDataSeconds,
    traceEnabled: profile.traceEnabled,
  };
  if (profile.httpPort > 0) payload.httpPort = profile.httpPort;
  if (profile.socksPort > 0) payload.socksPort = profile.socksPort;
  if (profile.maxBatchBytes > 0) payload.maxBatchBytes = profile.maxBatchBytes;
  if (profile.dataUploadMaxBatchBytes > 0) payload.dataUploadMaxBatchBytes = profile.dataUploadMaxBatchBytes;
  if (profile.dataUploadFlushDelaySeconds > 0) {
    payload.dataUploadFlushDelaySeconds = profile.dataUploadFlushDelaySeconds;
  }
  return `${PROFILE_SHARE_PREFIX}${encodeBase64Url(JSON.stringify(payload))}`;
}

export function importProfileShare(rawText: string): ClientProfile {
  const trimmed = rawText.trim();
  const payloadText = trimmed.startsWith(PROFILE_SHARE_PREFIX)
    ? decodeBase64Url(trimmed.slice(PROFILE_SHARE_PREFIX.length))
    : trimmed.startsWith("{")
      ? trimmed
      : decodeBase64Url(trimmed);
  const payload = JSON.parse(payloadText) as Partial<ClientProfile>;
  return {
    id: crypto.randomUUID(),
    name: payload.name?.trim() || "Imported profile",
    brokerBaseUrl: payload.brokerBaseUrl?.trim() || "",
    clientToken: payload.clientToken?.trim() || "",
    targetAgentPeerLabel: payload.targetAgentPeerLabel?.trim() || "",
    verifyTls: payload.verifyTls ?? false,
    http2Ctl: payload.http2Ctl ?? true,
    http2Data: payload.http2Data ?? false,
    httpPort: stableImportedPort(payload.httpPort, DEFAULT_HTTP_PORT),
    socksPort: stableImportedPort(payload.socksPort, DEFAULT_SOCKS_PORT),
    httpTimeoutSeconds: payload.httpTimeoutSeconds ?? 30,
    flushDelaySeconds: payload.flushDelaySeconds ?? 0.01,
    maxBatchBytes: legacyAutoBatch(payload.maxBatchBytes ?? 0),
    dataUploadMaxBatchBytes: legacyAutoBatch(payload.dataUploadMaxBatchBytes ?? 0),
    dataUploadFlushDelaySeconds: payload.dataUploadFlushDelaySeconds ?? 0,
    idleRepollCtlSeconds: payload.idleRepollCtlSeconds ?? 0.05,
    idleRepollDataSeconds: payload.idleRepollDataSeconds ?? 0.1,
    traceEnabled: payload.traceEnabled ?? false,
  };
}

function legacyAutoBatch(value: number) {
  return value === 65536 ? 0 : value;
}

function stableImportedPort(value: number | undefined, fallback: number) {
  return value && value > 0 ? value : fallback;
}

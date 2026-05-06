import type { ClientProfile } from "@/lib/types";

const PROFILE_SHARE_PREFIX = "twoman://profile?data=";

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
  const payload = {
    name: profile.name,
    brokerBaseUrl: profile.brokerBaseUrl,
    clientToken: profile.clientToken,
    targetAgentPeerLabel: profile.targetAgentPeerLabel,
    verifyTls: profile.verifyTls,
    http2Ctl: profile.http2Ctl,
    http2Data: profile.http2Data,
    httpPort: profile.httpPort,
    socksPort: profile.socksPort,
    httpTimeoutSeconds: profile.httpTimeoutSeconds,
    flushDelaySeconds: profile.flushDelaySeconds,
    maxBatchBytes: profile.maxBatchBytes,
    dataUploadMaxBatchBytes: profile.dataUploadMaxBatchBytes,
    dataUploadFlushDelaySeconds: profile.dataUploadFlushDelaySeconds,
    idleRepollCtlSeconds: profile.idleRepollCtlSeconds,
    idleRepollDataSeconds: profile.idleRepollDataSeconds,
    traceEnabled: profile.traceEnabled,
  };
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
    httpPort: payload.httpPort ?? 28167,
    socksPort: payload.socksPort ?? 21167,
    httpTimeoutSeconds: payload.httpTimeoutSeconds ?? 30,
    flushDelaySeconds: payload.flushDelaySeconds ?? 0.01,
    maxBatchBytes: payload.maxBatchBytes ?? 65536,
    dataUploadMaxBatchBytes: payload.dataUploadMaxBatchBytes ?? 65536,
    dataUploadFlushDelaySeconds: payload.dataUploadFlushDelaySeconds ?? 0.004,
    idleRepollCtlSeconds: payload.idleRepollCtlSeconds ?? 0.05,
    idleRepollDataSeconds: payload.idleRepollDataSeconds ?? 0.1,
    traceEnabled: payload.traceEnabled ?? false,
  };
}

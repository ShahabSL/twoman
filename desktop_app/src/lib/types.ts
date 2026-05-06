export type ConnectionMode = "proxy" | "system" | "tunnel";
export type SharedProxyProtocol = "socks" | "http";
export type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";

export type ClientProfile = {
  id: string;
  name: string;
  brokerBaseUrl: string;
  clientToken: string;
  targetAgentPeerLabel: string;
  verifyTls: boolean;
  http2Ctl: boolean;
  http2Data: boolean;
  httpPort: number;
  socksPort: number;
  httpTimeoutSeconds: number;
  flushDelaySeconds: number;
  maxBatchBytes: number;
  dataUploadMaxBatchBytes: number;
  dataUploadFlushDelaySeconds: number;
  idleRepollCtlSeconds: number;
  idleRepollDataSeconds: number;
  traceEnabled: boolean;
};

export type SharedProxy = {
  id: string;
  name: string;
  protocol: SharedProxyProtocol;
  listenHost: string;
  listenPort: number;
  username: string;
  password: string;
};

export type PlatformInfo = {
  os: string;
  systemModeSupported: boolean;
  tunnelModeSupported: boolean;
};

export type ConnectionStatus = {
  phase: ConnectionPhase;
  mode: ConnectionMode;
  activeProfileId: string | null;
  helperPid: number | null;
  tunnelPid: number | null;
  httpPort: number | null;
  socksPort: number | null;
  systemProxyEnabled: boolean;
  tunnelActive: boolean;
  tunnelInterfaceName: string | null;
  message: string;
};

export type ShareStatus = {
  shareId: string;
  running: boolean;
  pid: number | null;
  listenHost: string;
  listenPort: number;
  addresses: string[];
  message: string;
};

export type ShareLogTail = {
  shareId: string;
  tail: string;
};

export type DesktopSnapshot = {
  platform: PlatformInfo;
  selectedProfileId: string | null;
  connectionMode: ConnectionMode;
  profiles: ClientProfile[];
  shares: SharedProxy[];
  connection: ConnectionStatus;
  shareStatuses: ShareStatus[];
  helperLogTail: string;
  tunnelLogTail: string;
  shareLogTails: ShareLogTail[];
  logsDir: string;
  configDir: string;
};

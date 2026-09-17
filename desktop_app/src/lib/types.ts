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
  helperPeerId: string;
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

export type DeploymentBackend =
  | "auto"
  | "cloudlinux_node_selector"
  | "cpanel_runtime_bridge"
  | "passenger_python";

export type DeploymentHiddenTarget = "local" | "remote";
export type DeploymentUiMode = "automatic" | "advanced";

export type DeploymentRequest = {
  instanceName: string;
  releaseVersion: string;
  repoRef: string;
  siteName: string;
  publicOrigin: string;
  cpanelBaseUrl: string;
  cpanelUsername: string;
  cpanelPassword: string;
  cpanelHome: string;
  cpanelProxyUrl: string;
  publicProxyUrl: string;
  backend: DeploymentBackend;
  hiddenTarget: DeploymentHiddenTarget;
  serverHost: string;
  serverPort: number;
  serverUser: string;
  serverPassword: string;
  serverSshKey: string;
  sudoPassword: string;
  controlRoot: string;
  installRoot: string;
  publicBasePath: string;
  bridgePublicBasePath: string;
  passengerAppName: string;
  passengerAppRoot: string;
  nodeAppRoot: string;
  nodeAppUri: string;
  adminScriptName: string;
  hiddenServiceName: string;
  hiddenServiceUser: string;
  hiddenServiceGroup: string;
  watchdogServiceName: string;
  watchdogTimerName: string;
  hiddenUpstreamProxyUrl: string;
  hiddenUpstreamProxyLabel: string;
  hiddenOutboundProxyUrl: string;
  hiddenOutboundProxyLabel: string;
  verifyTls: boolean | null;
  skipHelperProbe: boolean;
};

export type DeploymentRollbackRequest = {
  instanceName: string;
  sudoPassword: string;
  controlRoot: string;
  launcherPath: string;
  purgeHost: boolean;
  purgeHidden: boolean;
  keepState: boolean;
};

export type DeploymentMonitorRequest = {
  instanceName: string;
  sudoPassword: string;
  controlRoot: string;
  launcherPath: string;
  includeLogs: boolean;
};

export type DeploymentResult = {
  ok: boolean;
  summary: string;
  profileShareText: string;
  output: string;
  commandLabel: string;
  startedAt: string;
  finishedAt: string;
};

export type DeploymentMonitorSnapshot = {
  ok: boolean;
  summary: string;
  statusOutput: string;
  logsOutput: string;
  profileShareText: string;
  commandLabel: string;
  checkedAt: string;
};

import type {
  ClientProfile,
  ConnectionMode,
  ConnectionPhase,
  ConnectionStatus,
  DesktopSnapshot,
  ShareStatus,
  SharedProxy,
} from "@/lib/types";

function makeProfile(partial: Partial<ClientProfile> & Pick<ClientProfile, "id" | "name">): ClientProfile {
  return {
    id: partial.id,
    name: partial.name,
    brokerBaseUrl: partial.brokerBaseUrl ?? "https://broker.example.net/connect",
    clientToken: partial.clientToken ?? "demo-token",
    targetAgentPeerLabel: partial.targetAgentPeerLabel ?? "",
    verifyTls: partial.verifyTls ?? false,
    http2Ctl: partial.http2Ctl ?? true,
    http2Data: partial.http2Data ?? false,
    httpPort: partial.httpPort ?? 28167,
    socksPort: partial.socksPort ?? 21167,
    httpTimeoutSeconds: partial.httpTimeoutSeconds ?? 30,
    flushDelaySeconds: partial.flushDelaySeconds ?? 0.01,
    maxBatchBytes: partial.maxBatchBytes ?? 0,
    dataUploadMaxBatchBytes: partial.dataUploadMaxBatchBytes ?? 0,
    dataUploadFlushDelaySeconds: partial.dataUploadFlushDelaySeconds ?? 0,
    idleRepollCtlSeconds: partial.idleRepollCtlSeconds ?? 0.05,
    idleRepollDataSeconds: partial.idleRepollDataSeconds ?? 0.1,
    traceEnabled: partial.traceEnabled ?? false,
  };
}

function makeShare(partial: Partial<SharedProxy> & Pick<SharedProxy, "id" | "name">): SharedProxy {
  return {
    id: partial.id,
    name: partial.name,
    protocol: partial.protocol ?? "socks",
    listenHost: partial.listenHost ?? "0.0.0.0",
    listenPort: partial.listenPort ?? 31080,
    username: partial.username ?? "guest",
    password: partial.password ?? "change-me",
  };
}

type MockState = {
  connectionMode: ConnectionMode;
  selectedProfileId: string | null;
  profiles: ClientProfile[];
  shares: SharedProxy[];
  connection: ConnectionStatus;
  shareStatuses: ShareStatus[];
  helperLogTail: string;
  tunnelLogTail: string;
  shareLogTails: Array<{ shareId: string; tail: string }>;
};

const mockState: MockState = {
  connectionMode: "proxy",
  selectedProfileId: "profile-default",
  profiles: [
    makeProfile({
      id: "profile-default",
      name: "Default",
      brokerBaseUrl: "https://broker.example.net/clpersist",
    }),
    makeProfile({
      id: "profile-alt",
      name: "Work relay",
      brokerBaseUrl: "https://edge.example.org/route",
      http2Ctl: false,
      socksPort: 22167,
      httpPort: 29167,
    }),
    makeProfile({
      id: "profile-lab",
      name: "Lab backup",
      brokerBaseUrl: "https://fallback.example.com/twoman",
      verifyTls: true,
      socksPort: 23167,
      httpPort: 30167,
    }),
  ],
  shares: [
    makeShare({
      id: "share-home",
      name: "Home share",
      protocol: "socks",
      listenPort: 31888,
      username: "home-user",
      password: "home-pass-01",
    }),
    makeShare({
      id: "share-lab",
      name: "Lab HTTP",
      protocol: "http",
      listenPort: 32888,
      username: "lab-user",
      password: "lab-pass-02",
    }),
  ],
  connection: {
    phase: "connected",
    mode: "proxy",
    activeProfileId: "profile-default",
    helperPid: 24816,
    tunnelPid: null,
    httpPort: 28167,
    socksPort: 21167,
    systemProxyEnabled: false,
    tunnelActive: false,
    tunnelInterfaceName: null,
    message: "Connected via Default",
  },
  shareStatuses: [
    {
      shareId: "share-home",
      running: true,
      pid: 24840,
      listenHost: "0.0.0.0",
      listenPort: 31888,
      addresses: ["192.168.1.25:31888", "10.0.0.22:31888"],
      message: "Running",
    },
    {
      shareId: "share-lab",
      running: false,
      pid: null,
      listenHost: "0.0.0.0",
      listenPort: 32888,
      addresses: [],
      message: "Stopped",
    },
  ],
  helperLogTail:
    "[Desktop]\\n2026-03-29 16:02:11 INFO connect requested\\n[Helper]\\n2026-03-29 16:02:12 INFO helper started transport=http\\n2026-03-29 16:02:14 INFO proxy ready socks=21167 http=28167\\n",
  tunnelLogTail:
    "[Tunnel]\\n2026-03-29 16:02:14 INFO sing-box started\\n2026-03-29 16:02:14 INFO inbound/tun[tun-in]: started at Twoman Tunnel\\n",
  shareLogTails: [
    {
      shareId: "share-home",
      tail:
        "[Share]\\n2026-03-29 16:03:01 INFO gateway started listen=0.0.0.0:31888\\n2026-03-29 16:03:08 INFO connect ok peer=('192.168.1.9', 51422)\\n",
    },
    {
      shareId: "share-lab",
      tail: "[Share]\\nNo output yet.\\n",
    },
  ],
};

function snapshotFromState(): DesktopSnapshot {
  return {
    platform: {
      os: "windows",
      systemModeSupported: true,
      tunnelModeSupported: true,
    },
    selectedProfileId: mockState.selectedProfileId,
    connectionMode: mockState.connectionMode,
    profiles: mockState.profiles,
    shares: mockState.shares,
    connection: mockState.connection,
    shareStatuses: mockState.shareStatuses,
    helperLogTail: mockState.helperLogTail,
    tunnelLogTail: mockState.tunnelLogTail,
    shareLogTails: mockState.shareLogTails,
    logsDir: "C:\\Twoman\\portable-data\\twoman-logs",
    configDir: "C:\\Twoman\\portable-data\\config",
  };
}

function updateConnection(phase: ConnectionPhase, message: string) {
  const activeProfile =
    mockState.profiles.find((profile) => profile.id === mockState.selectedProfileId) ?? null;
  mockState.connection = {
    ...mockState.connection,
    phase,
    mode: mockState.connectionMode,
    activeProfileId: activeProfile?.id ?? null,
    socksPort: activeProfile?.socksPort ?? null,
    httpPort: activeProfile?.httpPort ?? null,
    message,
    systemProxyEnabled: mockState.connectionMode === "system" && phase === "connected",
    tunnelActive: mockState.connectionMode === "tunnel" && phase === "connected",
    tunnelPid: mockState.connectionMode === "tunnel" && phase === "connected" ? 24870 : null,
    tunnelInterfaceName:
      mockState.connectionMode === "tunnel" && phase === "connected" ? "Twoman Tunnel" : null,
  };
}

export const mockDesktopApi = {
  async loadSnapshot() {
    return snapshotFromState();
  },
  async saveProfile(profile: ClientProfile) {
    const index = mockState.profiles.findIndex((entry) => entry.id === profile.id);
    if (index >= 0) {
      mockState.profiles[index] = profile;
    } else {
      mockState.profiles.unshift(profile);
    }
    mockState.selectedProfileId = profile.id;
    updateConnection(mockState.connection.phase, `Updated ${profile.name}`);
    return snapshotFromState();
  },
  async deleteProfile(profileId: string) {
    mockState.profiles = mockState.profiles.filter((profile) => profile.id !== profileId);
    if (mockState.selectedProfileId === profileId) {
      mockState.selectedProfileId = mockState.profiles[0]?.id ?? null;
    }
    updateConnection("disconnected", "Disconnected");
    return snapshotFromState();
  },
  async setSelectedProfile(profileId: string | null) {
    mockState.selectedProfileId = profileId;
    const selected =
      mockState.profiles.find((profile) => profile.id === profileId)?.name ?? "No profile";
    updateConnection(
      mockState.connection.phase === "connected" ? "connected" : "disconnected",
      mockState.connection.phase === "connected" ? `Connected via ${selected}` : "Disconnected",
    );
    return snapshotFromState();
  },
  async saveShare(share: SharedProxy) {
    const index = mockState.shares.findIndex((entry) => entry.id === share.id);
    if (index >= 0) {
      mockState.shares[index] = share;
    } else {
      mockState.shares.unshift(share);
      mockState.shareStatuses.unshift({
        shareId: share.id,
        running: false,
        pid: null,
        listenHost: share.listenHost,
        listenPort: share.listenPort,
        addresses: [],
        message: "Stopped",
      });
      mockState.shareLogTails.unshift({ shareId: share.id, tail: "[Share]\\nNo output yet.\\n" });
    }
    return snapshotFromState();
  },
  async deleteShare(shareId: string) {
    mockState.shares = mockState.shares.filter((share) => share.id !== shareId);
    mockState.shareStatuses = mockState.shareStatuses.filter((status) => status.shareId !== shareId);
    mockState.shareLogTails = mockState.shareLogTails.filter((tail) => tail.shareId !== shareId);
    return snapshotFromState();
  },
  async setConnectionMode(mode: ConnectionMode) {
    mockState.connectionMode = mode;
    updateConnection(
      mockState.connection.phase,
      mockState.connection.phase === "connected"
        ? `Connected via ${mode === "proxy" ? "proxy mode" : mode === "system" ? "system proxy" : "tunnel mode"}`
        : "Disconnected",
    );
    return snapshotFromState();
  },
  async connect() {
    const selected =
      mockState.profiles.find((profile) => profile.id === mockState.selectedProfileId) ?? null;
    updateConnection("connected", `Connected via ${selected?.name ?? "route"}`);
    return snapshotFromState();
  },
  async disconnect() {
    updateConnection("disconnected", "Disconnected");
    return snapshotFromState();
  },
  async startShare(shareId: string) {
    const share = mockState.shares.find((entry) => entry.id === shareId);
    mockState.shareStatuses = mockState.shareStatuses.map((status) =>
      status.shareId === shareId
        ? {
            ...status,
            running: true,
            pid: 25100,
            addresses:
              share?.protocol === "http"
                ? [`http://192.168.1.25:${status.listenPort}`]
                : [`192.168.1.25:${status.listenPort}`],
            message: "Running",
          }
        : status,
    );
    return snapshotFromState();
  },
  async stopShare(shareId: string) {
    mockState.shareStatuses = mockState.shareStatuses.map((status) =>
      status.shareId === shareId
        ? { ...status, running: false, pid: null, addresses: [], message: "Stopped" }
        : status,
    );
    return snapshotFromState();
  },
};

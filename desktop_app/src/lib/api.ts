import { invoke } from "@tauri-apps/api/core";
import { mockDesktopApi } from "@/lib/mock-desktop-api";

import type {
  ClientProfile,
  ConnectionMode,
  DeploymentMonitorRequest,
  DeploymentMonitorSnapshot,
  DeploymentRequest,
  DeploymentResult,
  DeploymentRollbackRequest,
  DesktopSnapshot,
  SharedProxy,
} from "@/lib/types";

type CommandArgs = Record<string, unknown> | undefined;

const mockCommandMap = {
  load_snapshot: mockDesktopApi.loadSnapshot,
  save_profile: mockDesktopApi.saveProfile,
  delete_profile: mockDesktopApi.deleteProfile,
  set_selected_profile: mockDesktopApi.setSelectedProfile,
  save_share: mockDesktopApi.saveShare,
  delete_share: mockDesktopApi.deleteShare,
  set_connection_mode: mockDesktopApi.setConnectionMode,
  connect: mockDesktopApi.connect,
  disconnect: mockDesktopApi.disconnect,
  start_share: mockDesktopApi.startShare,
  stop_share: mockDesktopApi.stopShare,
  run_deployment: mockDesktopApi.runDeployment,
  rollback_deployment: mockDesktopApi.rollbackDeployment,
  load_deployment_monitor: mockDesktopApi.loadDeploymentMonitor,
} as const;

async function call<T>(command: string, args?: CommandArgs) {
  if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    const handler = (mockCommandMap as unknown as Record<
      string,
      (...values: unknown[]) => Promise<T>
    >)[command];
    if (!handler) {
      throw new Error(`No mock desktop command for ${command}`);
    }
    if (!args) {
      return handler();
    }
    const orderedValues = Object.values(args);
    return handler(...orderedValues);
  }
  return invoke<T>(command, args);
}

export const desktopApi = {
  loadSnapshot() {
    return call<DesktopSnapshot>("load_snapshot");
  },
  saveProfile(profile: ClientProfile) {
    return call<DesktopSnapshot>("save_profile", { profile });
  },
  deleteProfile(profileId: string) {
    return call<DesktopSnapshot>("delete_profile", { profileId });
  },
  setSelectedProfile(profileId: string | null) {
    return call<DesktopSnapshot>("set_selected_profile", { profileId });
  },
  saveShare(share: SharedProxy) {
    return call<DesktopSnapshot>("save_share", { share });
  },
  deleteShare(shareId: string) {
    return call<DesktopSnapshot>("delete_share", { shareId });
  },
  setConnectionMode(mode: ConnectionMode) {
    return call<DesktopSnapshot>("set_connection_mode", { mode });
  },
  connect() {
    return call<DesktopSnapshot>("connect");
  },
  disconnect() {
    return call<DesktopSnapshot>("disconnect");
  },
  startShare(shareId: string) {
    return call<DesktopSnapshot>("start_share", { shareId });
  },
  stopShare(shareId: string) {
    return call<DesktopSnapshot>("stop_share", { shareId });
  },
  runDeployment(request: DeploymentRequest) {
    return call<DeploymentResult>("run_deployment", { request });
  },
  rollbackDeployment(request: DeploymentRollbackRequest) {
    return call<DeploymentResult>("rollback_deployment", { request });
  },
  loadDeploymentMonitor(request: DeploymentMonitorRequest) {
    return call<DeploymentMonitorSnapshot>("load_deployment_monitor", { request });
  },
};

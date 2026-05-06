import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Globe,
  Import,
  LaptopMinimalCheck,
  LoaderCircle,
  Logs,
  Network,
  Pencil,
  PlugZap,
  Plus,
  Power,
  Share2,
  Shield,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

import logo from "@/assets/logo.png";
import { desktopApi } from "@/lib/api";
import { exportProfileShare, importProfileShare } from "@/lib/profile-share";
import type {
  ClientProfile,
  ConnectionMode,
  ConnectionPhase,
  DesktopSnapshot,
  SharedProxy,
  SharedProxyProtocol,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";

type ProfileDialogState =
  | { open: false }
  | { open: true; mode: "create" | "edit"; draft: ClientProfile };

type ImportDialogState =
  | { open: false }
  | { open: true; rawText: string };

type ShareDialogState =
  | { open: false }
  | { open: true; mode: "create" | "edit"; draft: SharedProxy };

function blankProfile(): ClientProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    brokerBaseUrl: "",
    clientToken: "",
    targetAgentPeerLabel: "",
    verifyTls: false,
    http2Ctl: true,
    http2Data: false,
    httpPort: 28167,
    socksPort: 21167,
    httpTimeoutSeconds: 30,
    flushDelaySeconds: 0.01,
    maxBatchBytes: 65536,
    dataUploadMaxBatchBytes: 65536,
    dataUploadFlushDelaySeconds: 0.004,
    idleRepollCtlSeconds: 0.05,
    idleRepollDataSeconds: 0.1,
    traceEnabled: false,
  };
}

function blankShare(targetPort: number, protocol: SharedProxyProtocol = "socks"): SharedProxy {
  return {
    id: crypto.randomUUID(),
    name: "",
    protocol,
    listenHost: "0.0.0.0",
    listenPort: targetPort + 10000,
    username: `user-${Math.random().toString(16).slice(2, 8)}`,
    password: crypto.randomUUID().replace(/-/g, "").slice(0, 18),
  };
}

function phaseLabel(phase: ConnectionPhase) {
  switch (phase) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "disconnecting":
      return "Disconnecting";
    case "error":
      return "Needs attention";
    default:
      return "Disconnected";
  }
}

function shareProtocolLabel(protocol: SharedProxyProtocol) {
  return protocol === "http" ? "HTTP" : "SOCKS";
}

function connectionModeLabel(mode: ConnectionMode) {
  switch (mode) {
    case "system":
      return "System proxy";
    case "tunnel":
      return "Tunnel";
    default:
      return "Proxy";
  }
}

function desktopClientLabel(os?: string) {
  switch ((os ?? "").toLowerCase()) {
    case "windows":
      return "Windows client";
    case "linux":
      return "Linux client";
    case "macos":
      return "macOS client";
    default:
      return "Desktop client";
  }
}

function formatShareAddress(protocol: SharedProxyProtocol, address: string) {
  return protocol === "http" ? `http://${address}` : address;
}

function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [error, setError] = useState("");
  const [errorVisible, setErrorVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeShareAction, setActiveShareAction] = useState<{
    action: "start" | "stop";
    shareId: string;
  } | null>(null);
  const [shareErrors, setShareErrors] = useState<Record<string, string>>({});
  const [profileDialog, setProfileDialog] = useState<ProfileDialogState>({ open: false });
  const [importDialog, setImportDialog] = useState<ImportDialogState>({ open: false });
  const [shareDialog, setShareDialog] = useState<ShareDialogState>({ open: false });
  const [activeLogTarget, setActiveLogTarget] = useState<"helper" | "tunnel" | string>("helper");

  function clearError() {
    setErrorVisible(false);
    setError("");
  }

  function showError(message: string) {
    setError(message);
    setErrorVisible(true);
  }

  function dismissError() {
    const activeError = error;
    setErrorVisible(false);
    window.setTimeout(() => {
      setError((current) => (current === activeError ? "" : current));
    }, 220);
  }

  async function refreshState() {
    try {
      const nextSnapshot = await desktopApi.loadSnapshot();
      setSnapshot(nextSnapshot);
    } catch (nextError) {
      showError(normalizeError(nextError));
    }
  }

  useEffect(() => {
    void refreshState();
    const timer = window.setInterval(() => {
      void refreshState();
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!error) {
      return;
    }
    setErrorVisible(true);
    const hideTimer = window.setTimeout(() => setErrorVisible(false), 4400);
    const clearTimer = window.setTimeout(() => setError(""), 4680);
    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, [error]);

  const selectedProfile = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    return (
      snapshot.profiles.find((profile) => profile.id === snapshot.selectedProfileId) ??
      snapshot.profiles[0] ??
      null
    );
  }, [snapshot]);

  const connection = snapshot?.connection;
  const selectedMode = snapshot?.connectionMode ?? "proxy";
  const activeLogTail = useMemo(() => {
    if (!snapshot) {
      return "";
    }
    if (activeLogTarget === "helper") {
      return snapshot.helperLogTail;
    }
    if (activeLogTarget === "tunnel") {
      return snapshot.tunnelLogTail;
    }
    return snapshot.shareLogTails.find((entry) => entry.shareId === activeLogTarget)?.tail ?? "";
  }, [activeLogTarget, snapshot]);
  async function runAction(action: () => Promise<DesktopSnapshot>) {
    setBusy(true);
    try {
      const nextSnapshot = await action();
      setSnapshot(nextSnapshot);
      clearError();
    } catch (nextError) {
      showError(normalizeError(nextError));
      try {
        const latestSnapshot = await desktopApi.loadSnapshot();
        setSnapshot(latestSnapshot);
      } catch {
        // Keep the current UI state if the runtime snapshot cannot be refreshed.
      }
    } finally {
      setBusy(false);
    }
  }

  async function runShareAction(shareId: string, action: "start" | "stop") {
    setActiveShareAction({ action, shareId });
    setShareErrors((current) => {
      const next = { ...current };
      delete next[shareId];
      return next;
    });
    try {
      const nextSnapshot =
        action === "start"
          ? await desktopApi.startShare(shareId)
          : await desktopApi.stopShare(shareId);
      setSnapshot(nextSnapshot);
      clearError();
    } catch (nextError) {
      const message = normalizeError(nextError);
      showError(message);
      setShareErrors((current) => ({ ...current, [shareId]: message }));
    } finally {
      setActiveShareAction(null);
    }
  }

  async function handleSaveProfile(draft: ClientProfile) {
    setBusy(true);
    try {
      const nextSnapshot = await desktopApi.saveProfile(draft);
      setSnapshot(nextSnapshot);
      clearError();
      setProfileDialog({ open: false });
    } catch (nextError) {
      showError(normalizeError(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveShare(draft: SharedProxy) {
    setBusy(true);
    try {
      const nextSnapshot = await desktopApi.saveShare(draft);
      setSnapshot(nextSnapshot);
      clearError();
      setShareDialog({ open: false });
    } catch (nextError) {
      showError(normalizeError(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectToggle() {
    if (!snapshot || connection?.phase === "disconnecting") {
      return;
    }
    if (connection?.phase === "connected" || connection?.phase === "connecting") {
      await runAction(() => desktopApi.disconnect());
      return;
    }
    await runAction(() => desktopApi.connect());
  }

  async function handleModeChange(mode: ConnectionMode) {
    if (!snapshot || busy || mode === selectedMode) {
      return;
    }
    if (mode === "system" && !snapshot.platform.systemModeSupported) {
      return;
    }
    if (mode === "tunnel" && !snapshot.platform.tunnelModeSupported) {
      return;
    }
    await runAction(() => desktopApi.setConnectionMode(mode));
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      clearError();
    } catch (nextError) {
      showError(normalizeError(nextError));
    }
  }

  return (
    <TooltipProvider>
      <main className="app-shell">
        {error ? (
          <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
            <div
              aria-live="polite"
              className={cn(
                "pointer-events-auto w-full max-w-[720px] rounded-[22px] border border-rose-300/28 bg-[#1a1014]/96 px-4 py-3 text-left shadow-[0_22px_50px_rgba(255,122,157,0.2)] backdrop-blur-xl transition-[transform,opacity] duration-200 ease-out",
                errorVisible ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0",
              )}
              role="status"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-full border border-rose-200/18 bg-rose-300/12 p-1.5">
                  <AlertCircle className="h-4 w-4 text-rose-100" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-rose-100/70">
                    Needs attention
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-rose-50/92">{error}</p>
                </div>
                <button
                  className="rounded-full border border-white/10 bg-white/4 p-1.5 text-white/58 transition-colors duration-150 hover:bg-white/10 hover:text-white"
                  onClick={dismissError}
                  type="button"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Dismiss</span>
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="app-frame">
          <aside className="app-sidebar">
            <div className="flex min-h-0 flex-col gap-3 lg:overflow-hidden">
              <Card className="panel-shell shrink-0">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-center gap-4">
                    <img
                      alt="Twoman"
                      className="h-[76px] w-[76px] shrink-0 rounded-[22px] border border-white/8 bg-black object-cover p-2 shadow-[0_18px_40px_rgba(0,0,0,0.34)] [image-rendering:pixelated]"
                      src={logo}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-3">
                        <h1 className="truncate text-[1.85rem] font-semibold tracking-[-0.05em]">
                          Twoman
                        </h1>
                        <StatusBadge phase={connection?.phase ?? "disconnected"} />
                      </div>
                      <p className="mt-1 text-sm text-white/68">
                        {desktopClientLabel(snapshot?.platform.os)}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
                    <EndpointSurface
                      icon={<PlugZap className="h-4 w-4" />}
                      label="SOCKS"
                      value={
                        connection?.socksPort ? `127.0.0.1:${connection.socksPort}` : "Offline"
                      }
                    />
                    <EndpointSurface
                      icon={<Globe className="h-4 w-4" />}
                      label="HTTP"
                      value={
                        connection?.httpPort ? `127.0.0.1:${connection.httpPort}` : "Offline"
                      }
                    />
                  </div>
                </CardContent>
              </Card>

              <Card className="panel-shell min-h-0 flex-1">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="section-kicker">Profiles</p>
                      <CardTitle className="mt-2 text-[1.65rem] tracking-[-0.04em]">Saved routes</CardTitle>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="h-10 rounded-full"
                        onClick={() =>
                          setProfileDialog({ open: true, mode: "create", draft: blankProfile() })
                        }
                        size="sm"
                        variant="secondary"
                      >
                        <Plus className="h-4 w-4" />
                        Add
                      </Button>
                      <Button
                        className="h-10 rounded-full"
                        onClick={() => setImportDialog({ open: true, rawText: "" })}
                        size="sm"
                        variant="outline"
                      >
                        <Import className="h-4 w-4" />
                        Import
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3">
                  <div className="min-h-[220px] overflow-y-auto rounded-[24px] border border-white/8 bg-[#0b0c0f] p-3">
                    {snapshot?.profiles.length ? (
                      <div className="space-y-3">
                        {snapshot.profiles.map((profile) => {
                          const active = snapshot.selectedProfileId === profile.id;
                          return (
                            <div
                              className="list-item"
                              data-selected={active}
                              key={profile.id}
                            >
                              <button
                                className="block w-full text-left"
                                onClick={() =>
                                  void runAction(() => desktopApi.setSelectedProfile(profile.id))
                                }
                                type="button"
                              >
                                <div className="flex min-w-0 items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-base font-medium">{profile.name}</p>
                                    <p
                                      className={cn(
                                        "mt-1 line-clamp-2 break-all text-xs font-mono",
                                        active ? "text-black/64" : "text-white/48",
                                      )}
                                    >
                                      {profile.brokerBaseUrl}
                                    </p>
                                  </div>
                                  <Badge
                                    className={cn(
                                      "shrink-0 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]",
                                      active
                                        ? "border-black/12 bg-black/8 text-black"
                                        : "border-white/10 bg-white/[0.04] text-white/70",
                                    )}
                                    variant="outline"
                                  >
                                    {profile.http2Ctl ? "H2 ctl" : "H1 ctl"}
                                  </Badge>
                                </div>
                              </button>

                              {active ? (
                                <div className="mt-4 flex flex-wrap gap-2">
                                  <CompactButton
                                    icon={<Pencil className="h-4 w-4" />}
                                    label="Edit"
                                    onClick={() =>
                                      setProfileDialog({
                                        open: true,
                                        mode: "edit",
                                        draft: { ...profile },
                                      })
                                    }
                                  />
                                  <CompactButton
                                    icon={<Share2 className="h-4 w-4" />}
                                    label="Copy"
                                    onClick={() => void handleCopy(exportProfileShare(profile))}
                                  />
                                  <CompactButton
                                    icon={<Trash2 className="h-4 w-4" />}
                                    label="Delete"
                                    onClick={() =>
                                      void runAction(() => desktopApi.deleteProfile(profile.id))
                                    }
                                  />
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <EmptyState
                        action="Add a profile"
                        description="Create one route before connecting."
                        title="No profiles"
                      />
                    )}
                  </div>
                </CardContent>
              </Card>

            </div>
          </aside>

          <section className="app-workspace flex min-h-0 flex-col gap-4">
            <Card className="panel-shell shrink-0">
              <CardContent className="space-y-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="section-kicker">Connection</p>
                    <h2 className="mt-2 text-[1.8rem] font-semibold tracking-[-0.05em]">
                      Connect this device
                    </h2>
                    <p className="mt-1.5 text-sm text-white/56">
                      Choose a route, then connect in proxy, system proxy, or tunnel mode.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#0b0c0f] p-1">
                    <ModeButton
                      active={selectedMode === "proxy"}
                      disabled={busy}
                      icon={<PlugZap className="h-4 w-4" />}
                      label="Proxy"
                      onClick={() => void handleModeChange("proxy")}
                    />
                    <ModeButton
                      active={selectedMode === "system"}
                      disabled={busy || !snapshot?.platform.systemModeSupported}
                      icon={<LaptopMinimalCheck className="h-4 w-4" />}
                      label="System proxy"
                      onClick={() => void handleModeChange("system")}
                    />
                    <ModeButton
                      active={selectedMode === "tunnel"}
                      disabled={busy || !snapshot?.platform.tunnelModeSupported}
                      icon={<Network className="h-4 w-4" />}
                      label="Tunnel"
                      onClick={() => void handleModeChange("tunnel")}
                    />
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_285px]">
                  <div className="panel-inset p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="section-kicker">Selected profile</p>
                        <h3 className="mt-2 truncate text-[1.7rem] font-semibold tracking-[-0.05em]">
                          {selectedProfile?.name ?? "No profile selected"}
                        </h3>
                        <p className="mt-2 break-all font-mono text-xs text-white/52">
                          {selectedProfile?.brokerBaseUrl ?? "Add a profile to continue."}
                        </p>
                      </div>
                      {selectedProfile ? (
                        <Button
                          className="h-10 rounded-full"
                          onClick={() =>
                            setProfileDialog({
                              open: true,
                              mode: "edit",
                              draft: { ...selectedProfile },
                            })
                          }
                          variant="outline"
                        >
                          <Pencil className="h-4 w-4" />
                          Edit
                        </Button>
                      ) : null}
                    </div>

                    <Button
                      className={cn(
                        "mt-5 h-13 w-full rounded-[18px] text-base font-semibold transition-[background-color,border-color,box-shadow,opacity] duration-200 ease-out",
                        connectButtonClass(connection?.phase ?? "disconnected"),
                      )}
                      disabled={busy || !selectedProfile}
                      onClick={() => void handleConnectToggle()}
                    >
                      <ConnectionButtonIcon phase={connection?.phase ?? "disconnected"} />
                      {connectButtonLabel(connection?.phase ?? "disconnected")}
                    </Button>
                  </div>

                  <div className="panel-inset p-5">
                    <p className="section-kicker">Status</p>
                    <dl className="mt-3">
                      <DetailRow
                        label="State"
                        value={phaseLabel(connection?.phase ?? "disconnected")}
                      />
                      <DetailRow label="Mode" value={connectionModeLabel(selectedMode)} />
                      {selectedMode === "system" ? (
                        <DetailRow
                          label="Windows proxy"
                          value={connection?.systemProxyEnabled ? "On" : "Off"}
                        />
                      ) : null}
                      {selectedMode === "tunnel" ? (
                        <DetailRow
                          label="Tunnel"
                          value={
                            connection?.tunnelActive
                              ? connection.tunnelInterfaceName ?? "Active"
                              : "Off"
                          }
                        />
                      ) : null}
                      {connection?.phase === "error" && connection.message ? (
                        <DetailRow label="Last error" value={connection.message} />
                      ) : null}
                    </dl>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_350px]">
              <Card className="panel-shell min-h-0 h-full overflow-hidden">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="section-kicker">Logs</p>
                      <CardTitle className="mt-2 text-lg">Runtime output</CardTitle>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        className="h-10 rounded-full"
                        onClick={() => void handleCopy(activeLogTail)}
                        size="sm"
                        variant="outline"
                      >
                        <Copy className="h-4 w-4" />
                        Copy
                      </Button>
                      <Button
                        className="h-10 rounded-full"
                        onClick={() => setActiveLogTarget("helper")}
                        size="sm"
                        variant={activeLogTarget === "helper" ? "secondary" : "outline"}
                      >
                        <Logs className="h-4 w-4" />
                        Helper
                      </Button>
                      {snapshot?.platform.tunnelModeSupported ? (
                        <Button
                          className="h-10 rounded-full"
                          onClick={() => setActiveLogTarget("tunnel")}
                          size="sm"
                          variant={activeLogTarget === "tunnel" ? "secondary" : "outline"}
                        >
                          <Network className="h-4 w-4" />
                          Tunnel
                        </Button>
                      ) : null}
                      {snapshot?.shareStatuses.map((shareStatus) => (
                        <Button
                          className="h-10 rounded-full"
                          key={shareStatus.shareId}
                          onClick={() => setActiveLogTarget(shareStatus.shareId)}
                          size="sm"
                          variant={activeLogTarget === shareStatus.shareId ? "secondary" : "outline"}
                        >
                          <Share2 className="h-4 w-4" />
                          {snapshot.shares.find((share) => share.id === shareStatus.shareId)?.name ??
                            "Share"}
                        </Button>
                      ))}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-hidden">
                    <div className="h-full min-h-[220px] max-h-[38vh] overflow-y-auto overscroll-contain rounded-[24px] border border-white/8 bg-[#0b0c0f]">
                      <pre className="min-h-full select-text whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-white/86">
                        {activeLogTail || "No output yet."}
                      </pre>
                  </div>
                </CardContent>
              </Card>

              <div className="flex min-h-0 flex-col gap-3">
                <Card className="panel-shell min-h-0 h-full">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="section-kicker">Shared proxies</p>
                        <CardTitle className="mt-2 text-lg">Public proxies</CardTitle>
                      </div>
                      <Button
                        className="h-10 rounded-full"
                        onClick={() =>
                          setShareDialog({
                            open: true,
                            mode: "create",
                            draft: blankShare(selectedProfile?.socksPort ?? 21167, "socks"),
                          })
                        }
                        size="sm"
                        variant="secondary"
                      >
                        <Plus className="h-4 w-4" />
                        Add
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="min-h-0 flex-1 overflow-hidden">
                    <div className="h-full min-h-[240px] overflow-y-auto rounded-[24px] border border-white/8 bg-[#0b0c0f] p-3">
                      {snapshot?.shares.length ? (
                        <div className="space-y-3">
                          {snapshot.shares.map((share) => {
                            const status = snapshot.shareStatuses.find(
                              (entry) => entry.shareId === share.id,
                            );
                            const running = status?.running ?? false;
                            const pendingAction =
                              activeShareAction?.shareId === share.id
                                ? activeShareAction.action
                                : null;
                            const inlineMessage = pendingAction
                              ? pendingAction === "start"
                                ? "Starting listener"
                                : "Stopping listener"
                              : shareErrors[share.id] ??
                                status?.message ??
                                (running ? "Sharing" : "Stopped");
                            return (
                              <div className="list-item space-y-3" data-selected={false} key={share.id}>
                                <div className="space-y-2">
                                  <div className="min-w-0">
                                    <p className="truncate text-base font-medium">{share.name}</p>
                                    <p className="mt-1 break-all text-xs font-mono text-white/52">
                                      {share.listenHost}:{share.listenPort}
                                    </p>
                                  </div>

                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge
                                        className={cn(
                                          "rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]",
                                          "border-white/10 bg-transparent text-white/72",
                                        )}
                                        variant="outline"
                                      >
                                        {shareProtocolLabel(share.protocol)}
                                      </Badge>
                                      <Badge
                                        className={cn(
                                          "rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]",
                                          pendingAction && "border-white/14 bg-white/10 text-white",
                                          !pendingAction &&
                                            running &&
                                            "border-emerald-300/20 bg-emerald-300/90 text-black",
                                          !pendingAction &&
                                            !running &&
                                            shareErrors[share.id] &&
                                            "border-rose-300/20 bg-rose-300/16 text-rose-100",
                                          !pendingAction &&
                                            !running &&
                                            !shareErrors[share.id] &&
                                            "border-white/10 bg-transparent text-white/72",
                                        )}
                                        variant="outline"
                                      >
                                        {pendingAction
                                          ? pendingAction === "start"
                                            ? "Starting"
                                            : "Stopping"
                                          : running
                                            ? "Active"
                                            : shareErrors[share.id]
                                              ? "Error"
                                              : "Stopped"}
                                      </Badge>
                                    </div>
                                    <Button
                                      className="h-9 rounded-full"
                                      disabled={
                                        busy ||
                                        pendingAction !== null ||
                                        (!running && connection?.phase !== "connected")
                                      }
                                      onClick={() => void runShareAction(share.id, running ? "stop" : "start")}
                                      size="sm"
                                      variant={running ? "outline" : "secondary"}
                                    >
                                      {pendingAction ? (
                                        <LoaderCircle className="h-4 w-4 animate-spin" />
                                      ) : running ? (
                                        <WifiOff className="h-4 w-4" />
                                      ) : (
                                        <Wifi className="h-4 w-4" />
                                      )}
                                      {pendingAction
                                        ? pendingAction === "start"
                                          ? "Starting"
                                          : "Stopping"
                                        : running
                                          ? "Stop"
                                          : "Start"}
                                    </Button>
                                  </div>

                                  <p
                                    className={cn(
                                      "text-xs",
                                      shareErrors[share.id] ? "text-rose-200" : "text-white/60",
                                    )}
                                  >
                                    {inlineMessage}
                                  </p>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-2">
                                  <InfoTile label="Username" value={share.username} />
                                  <InfoTile label="Password" value={share.password} />
                                </div>

                                {status?.addresses.length ? (
                                  <div className="rounded-[18px] border border-white/10 bg-black/50 p-3">
                                    <p className="section-kicker mb-2">
                                      {running ? "Reachable now" : "Will listen on"}
                                    </p>
                                    <div className="space-y-1 font-mono text-xs text-white/84">
                                      {status.addresses.map((address) => (
                                        <div className="break-all" key={address}>
                                          {formatShareAddress(share.protocol, address)}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : null}

                                <div className="flex flex-wrap gap-2">
                                  <CompactButton
                                    icon={<Pencil className="h-4 w-4" />}
                                    label="Edit"
                                    onClick={() =>
                                      setShareDialog({
                                        open: true,
                                        mode: "edit",
                                        draft: { ...share },
                                      })
                                    }
                                  />
                                  <CompactButton
                                    icon={<Trash2 className="h-4 w-4" />}
                                    label="Delete"
                                    onClick={() =>
                                      void runAction(() => desktopApi.deleteShare(share.id))
                                    }
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <EmptyState
                          action={
                            connection?.phase === "connected"
                              ? "Add a public proxy"
                              : "Connect first to enable listeners"
                          }
                          description={
                            connection?.phase === "connected"
                              ? "Expose the local SOCKS or HTTP proxy with auth."
                              : "Public listeners are available after the helper is connected."
                          }
                          title="No public proxies"
                        />
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </section>
        </div>

        <ProfileDialog
          onClose={() => setProfileDialog({ open: false })}
          onSave={(draft) => void handleSaveProfile(draft)}
          state={profileDialog}
        />
        <ImportProfileDialog
          onClose={() => setImportDialog({ open: false })}
          onImport={(rawText) => {
            try {
              const imported = importProfileShare(rawText);
              setImportDialog({ open: false });
              void runAction(() => desktopApi.saveProfile(imported));
            } catch (nextError) {
              showError(normalizeError(nextError));
            }
          }}
          state={importDialog}
        />
        <ShareDialog
          onClose={() => setShareDialog({ open: false })}
          onSave={(draft) => void handleSaveShare(draft)}
          state={shareDialog}
        />
      </main>
    </TooltipProvider>
  );
}

function StatusBadge(props: { phase: ConnectionPhase }) {
  return (
    <Badge
      className={cn(
        "status-pill",
        props.phase === "connected" && "border-emerald-300/20 bg-emerald-300/90 text-black",
        (props.phase === "connecting" || props.phase === "disconnecting") &&
          "border-white/14 bg-white/10 text-white",
        props.phase === "error" && "border-rose-300/20 bg-rose-300/16 text-rose-100",
        props.phase === "disconnected" && "border-white/10 bg-transparent text-white/82",
      )}
      variant="outline"
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          props.phase === "connected" && "bg-black",
          (props.phase === "connecting" || props.phase === "disconnecting") &&
            "bg-white animate-pulse",
          props.phase === "error" && "bg-rose-200",
          props.phase === "disconnected" && "bg-white/35",
        )}
      />
      {phaseLabel(props.phase)}
    </Badge>
  );
}

function EndpointSurface(props: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="surface-chip min-w-0">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-white/45">
        {props.icon}
        {props.label}
      </div>
      <div className="min-w-0 break-all font-mono text-[13px] leading-5 text-white/86">
        {props.value}
      </div>
    </div>
  );
}

function ModeButton(props: {
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="mode-toggle"
      data-active={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      type="button"
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function CompactButton(props: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      className="h-10 rounded-full border-white/12 bg-[#0d0f12] text-white hover:bg-[#171a1e]"
      disabled={props.disabled}
      onClick={props.onClick}
      size="sm"
      variant="outline"
    >
      {props.icon}
      <span>{props.label}</span>
    </Button>
  );
}

function InfoTile(props: { label: string; value: string }) {
  return (
    <div className="surface-chip min-w-0">
      <p className="section-kicker">{props.label}</p>
      <p className="mt-3 break-all font-mono text-[13px] leading-5 text-white/92">{props.value}</p>
    </div>
  );
}

function DetailRow(props: { label: string; value: string }) {
  return (
    <div className="key-value-row">
      <dt>{props.label}</dt>
      <dd className="break-all">{props.value}</dd>
    </div>
  );
}

function ConnectionButtonIcon(props: { phase: ConnectionPhase }) {
  if (props.phase === "connecting" || props.phase === "disconnecting") {
    return <LoaderCircle className="h-5 w-5 animate-spin" />;
  }
  if (props.phase === "connected") {
    return <CheckCircle2 className="h-5 w-5" />;
  }
  if (props.phase === "error") {
    return <Shield className="h-5 w-5" />;
  }
  return <Power className="h-5 w-5" />;
}

function connectButtonLabel(phase: ConnectionPhase) {
  switch (phase) {
    case "connected":
      return "Disconnect";
    case "connecting":
      return "Connecting";
    case "disconnecting":
      return "Disconnecting";
    case "error":
      return "Reconnect";
    default:
      return "Connect";
  }
}

function connectButtonClass(phase: ConnectionPhase) {
  switch (phase) {
    case "connected":
      return "bg-white text-black hover:bg-white/92";
    case "connecting":
    case "disconnecting":
      return "bg-[#f1f2f3] text-black";
    case "error":
      return "border border-rose-300/20 bg-rose-300/12 text-rose-50 hover:bg-rose-300/18";
    default:
      return "bg-white text-black hover:bg-white/92";
  }
}

function EmptyState(props: { title: string; description: string; action: string }) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-[22px] border border-dashed border-white/10 bg-black/30 px-8 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04]">
        <Shield className="h-5 w-5 text-white/70" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-white">{props.title}</p>
        <p className="text-sm text-white/50">{props.description}</p>
      </div>
      <p className="text-[11px] uppercase tracking-[0.28em] text-white/35">{props.action}</p>
    </div>
  );
}

function ProfileDialog(props: {
  state: ProfileDialogState;
  onClose: () => void;
  onSave: (draft: ClientProfile) => void;
}) {
  const [draft, setDraft] = useState<ClientProfile>(blankProfile());

  useEffect(() => {
    if (props.state.open) {
      setDraft(structuredClone(props.state.draft));
    }
  }, [props.state]);

  if (!props.state.open) {
    return null;
  }

  return (
    <Dialog onOpenChange={(open) => !open && props.onClose()} open>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>{props.state.mode === "create" ? "Add profile" : "Edit profile"}</DialogTitle>
          <DialogDescription>Broker settings and local ports.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid gap-2.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              onChange={(event) => setDraft((current) => ({ ...current, name: event.currentTarget.value }))}
              value={draft.name}
            />
          </div>

          <div className="grid gap-2.5">
            <Label htmlFor="profile-url">Broker URL</Label>
            <Input
              id="profile-url"
              onChange={(event) =>
                setDraft((current) => ({ ...current, brokerBaseUrl: event.currentTarget.value }))
              }
              placeholder="https://example.com/route"
              value={draft.brokerBaseUrl}
            />
          </div>

          <div className="grid gap-2.5">
            <Label htmlFor="profile-token">Client token</Label>
            <Textarea
              className="min-h-[120px]"
              id="profile-token"
              onChange={(event) =>
                setDraft((current) => ({ ...current, clientToken: event.currentTarget.value }))
              }
              value={draft.clientToken}
            />
          </div>

          <div className="grid gap-2.5">
            <Label htmlFor="profile-target-agent">Target agent label</Label>
            <Input
              id="profile-target-agent"
              onChange={(event) =>
                setDraft((current) => ({ ...current, targetAgentPeerLabel: event.currentTarget.value }))
              }
              placeholder="Leave empty for automatic failover"
              value={draft.targetAgentPeerLabel}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <NumberField
              defaultValue={draft.socksPort}
              label="SOCKS port"
              onValueChange={(value) => setDraft((current) => ({ ...current, socksPort: value }))}
            />
            <NumberField
              defaultValue={draft.httpPort}
              label="HTTP port"
              onValueChange={(value) => setDraft((current) => ({ ...current, httpPort: value }))}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <ToggleField
              checked={draft.http2Ctl}
              label="HTTP/2 control"
              onCheckedChange={(checked) => setDraft((current) => ({ ...current, http2Ctl: checked }))}
            />
            <ToggleField
              checked={draft.http2Data}
              label="HTTP/2 data"
              onCheckedChange={(checked) => setDraft((current) => ({ ...current, http2Data: checked }))}
            />
            <ToggleField
              checked={draft.verifyTls}
              label="Verify TLS"
              onCheckedChange={(checked) => setDraft((current) => ({ ...current, verifyTls: checked }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button className="min-w-[120px]" onClick={() => props.onSave(draft)}>
            Save profile
          </Button>
          <Button className="min-w-[110px]" onClick={props.onClose} variant="outline">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportProfileDialog(props: {
  state: ImportDialogState;
  onClose: () => void;
  onImport: (rawText: string) => void;
}) {
  const [rawText, setRawText] = useState("");

  useEffect(() => {
    if (props.state.open) {
      setRawText(props.state.rawText);
    }
  }, [props.state]);

  if (!props.state.open) {
    return null;
  }

  return (
    <Dialog onOpenChange={(open) => !open && props.onClose()} open>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Import profile</DialogTitle>
          <DialogDescription>Paste profile text or raw JSON.</DialogDescription>
        </DialogHeader>

        <Textarea
          className="min-h-[220px]"
          onChange={(event) => setRawText(event.currentTarget.value)}
          placeholder="twoman://profile?data=..."
          value={rawText}
        />

        <DialogFooter>
          <Button className="min-w-[120px]" onClick={() => props.onImport(rawText)}>
            Import
          </Button>
          <Button className="min-w-[110px]" onClick={props.onClose} variant="outline">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareDialog(props: {
  state: ShareDialogState;
  onClose: () => void;
  onSave: (draft: SharedProxy) => void;
}) {
  const [draft, setDraft] = useState<SharedProxy>(blankShare(21167, "socks"));

  useEffect(() => {
    if (props.state.open) {
      setDraft(structuredClone(props.state.draft));
    }
  }, [props.state]);

  if (!props.state.open) {
    return null;
  }

  return (
    <Dialog onOpenChange={(open) => !open && props.onClose()} open>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {props.state.mode === "create" ? "Add public proxy" : "Edit public proxy"}
          </DialogTitle>
          <DialogDescription>Create an authenticated SOCKS or HTTP listener.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#0b0c0f] p-1">
            <ModeButton
              active={draft.protocol === "socks"}
              icon={<PlugZap className="h-4 w-4" />}
              label="SOCKS"
              onClick={() => setDraft((current) => ({ ...current, protocol: "socks" }))}
            />
            <ModeButton
              active={draft.protocol === "http"}
              icon={<Globe className="h-4 w-4" />}
              label="HTTP"
              onClick={() => setDraft((current) => ({ ...current, protocol: "http" }))}
            />
          </div>

          <div className="grid gap-2.5">
            <Label htmlFor="share-name">Name</Label>
            <Input
              id="share-name"
              onChange={(event) => setDraft((current) => ({ ...current, name: event.currentTarget.value }))}
              value={draft.name}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2.5">
              <Label htmlFor="share-host">Listen host</Label>
              <Input
                id="share-host"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, listenHost: event.currentTarget.value }))
                }
                value={draft.listenHost}
              />
            </div>
            <NumberField
              defaultValue={draft.listenPort}
              label="Listen port"
              onValueChange={(value) => setDraft((current) => ({ ...current, listenPort: value }))}
            />
          </div>

          <div className="grid gap-4">
            <div className="grid gap-2.5">
              <Label htmlFor="share-username">Username</Label>
              <Input
                id="share-username"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, username: event.currentTarget.value }))
                }
                value={draft.username}
              />
            </div>
            <div className="grid gap-2.5">
              <Label htmlFor="share-password">Password</Label>
              <Input
                id="share-password"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, password: event.currentTarget.value }))
                }
                value={draft.password}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button className="min-w-[120px]" onClick={() => props.onSave(draft)}>
            Save share
          </Button>
          <Button className="min-w-[110px]" onClick={props.onClose} variant="outline">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberField(props: {
  defaultValue: number;
  label: string;
  onValueChange: (value: number) => void;
}) {
  return (
    <div className="grid gap-2.5">
      <Label>{props.label}</Label>
      <Input
        defaultValue={String(props.defaultValue)}
        inputMode="numeric"
        onChange={(event) => props.onValueChange(Number(event.currentTarget.value || 0))}
      />
    </div>
  );
}

function ToggleField(props: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-[18px] border border-white/10 bg-[#111316] px-4 py-3">
      <p className="text-sm font-medium">{props.label}</p>
      <Switch checked={props.checked} onCheckedChange={props.onCheckedChange} />
    </div>
  );
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error, null, 2);
}

export default App;

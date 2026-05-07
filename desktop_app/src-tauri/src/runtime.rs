use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    net::{TcpListener, TcpStream, ToSocketAddrs, UdpSocket},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::{
    models::{
        ClientProfile, ConnectionMode, ConnectionPhase, ConnectionStatus, DesktopSnapshot,
        PlatformInfo, ShareLogTail, ShareStatus, SharedProxy, SharedProxyProtocol,
    },
    storage::{
        helper_config_path, helper_listen_state_path, helper_log_path, helper_pid_path,
        load_profiles, load_settings, load_shares, normalize_mode_for_platform, normalize_settings,
        read_log_tail, save_profiles, save_settings, save_shares, share_config_path,
        share_log_path, share_pid_path, tunnel_config_path, tunnel_log_path, tunnel_pid_path,
        tunnel_work_dir, validate_profile, validate_share, AppPaths,
    },
    system_proxy::SystemProxyManager,
};
use serde::Deserialize;
use serde_json::json;

const PORT_WAIT_TIMEOUT: Duration = Duration::from_secs(12);
const PORT_TEARDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const LOG_TAIL_LINES: usize = 40;
const TUNNEL_WAIT_TIMEOUT: Duration = Duration::from_secs(18);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug)]
struct ManagedHelper {
    child: Child,
    profile_id: String,
    mode: ConnectionMode,
    http_port: u16,
    socks_port: u16,
    log_path: PathBuf,
    pid_path: PathBuf,
    system_proxy_enabled: bool,
}

#[derive(Debug)]
struct ManagedTunnel {
    child: Child,
    log_path: PathBuf,
    pid_path: PathBuf,
    interface_name: String,
}

#[derive(Debug)]
struct ManagedShare {
    child: Child,
    listen_host: String,
    listen_port: u16,
    pid_path: PathBuf,
}

#[derive(Debug)]
struct RuntimeState {
    phase: ConnectionPhase,
    message: String,
    helper: Option<ManagedHelper>,
    tunnel: Option<ManagedTunnel>,
    shares: HashMap<String, ManagedShare>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            phase: ConnectionPhase::Disconnected,
            message: String::new(),
            helper: None,
            tunnel: None,
            shares: HashMap::new(),
        }
    }
}

pub struct DesktopRuntime {
    pub paths: AppPaths,
    resource_dir: Option<PathBuf>,
    inner: Mutex<RuntimeState>,
}

impl DesktopRuntime {
    pub fn new(paths: AppPaths, resource_dir: Option<PathBuf>) -> Self {
        Self {
            paths,
            resource_dir,
            inner: Mutex::new(RuntimeState::default()),
        }
    }

    pub fn snapshot(&self) -> Result<DesktopSnapshot, String> {
        let mut profiles = load_profiles(&self.paths)?;
        let shares = load_shares(&self.paths)?;
        let mut settings = load_settings(&self.paths)?;
        normalize_settings(&mut settings, &profiles);
        settings.connection_mode = normalize_mode_for_platform(settings.connection_mode);
        save_settings(&self.paths, &settings)?;
        profiles.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

        let helper_log_path = helper_log_path(&self.paths);
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "runtime lock poisoned".to_string())?;
        self.refresh_locked(&mut state)?;

        let connection = if let Some(helper) = state.helper.as_ref() {
            ConnectionStatus {
                phase: state.phase.clone(),
                mode: helper.mode.clone(),
                active_profile_id: Some(helper.profile_id.clone()),
                helper_pid: Some(helper.child.id()),
                tunnel_pid: state.tunnel.as_ref().map(|tunnel| tunnel.child.id()),
                http_port: Some(helper.http_port),
                socks_port: Some(helper.socks_port),
                system_proxy_enabled: helper.system_proxy_enabled,
                tunnel_active: state.tunnel.is_some(),
                tunnel_interface_name: state
                    .tunnel
                    .as_ref()
                    .map(|tunnel| tunnel.interface_name.clone()),
                message: state.message.clone(),
            }
        } else {
            ConnectionStatus {
                phase: state.phase.clone(),
                mode: settings.connection_mode.clone(),
                active_profile_id: None,
                helper_pid: None,
                tunnel_pid: None,
                http_port: None,
                socks_port: None,
                system_proxy_enabled: false,
                tunnel_active: false,
                tunnel_interface_name: None,
                message: state.message.clone(),
            }
        };

        let share_statuses = shares
            .iter()
            .map(|share| {
                if let Some(runtime_share) = state.shares.get(&share.id) {
                    ShareStatus {
                        share_id: share.id.clone(),
                        running: true,
                        pid: Some(runtime_share.child.id()),
                        listen_host: share.listen_host.clone(),
                        listen_port: share.listen_port,
                        addresses: discover_share_addresses(&share.listen_host, share.listen_port),
                        message: "Sharing".into(),
                    }
                } else {
                    ShareStatus {
                        share_id: share.id.clone(),
                        running: false,
                        pid: None,
                        listen_host: share.listen_host.clone(),
                        listen_port: share.listen_port,
                        addresses: discover_share_addresses(&share.listen_host, share.listen_port),
                        message: "Stopped".into(),
                    }
                }
            })
            .collect::<Vec<_>>();

        let share_log_tails = shares
            .iter()
            .map(|share| ShareLogTail {
                share_id: share.id.clone(),
                tail: read_log_tail(&share_log_path(&self.paths, &share.id), LOG_TAIL_LINES),
            })
            .collect::<Vec<_>>();

        let platform = PlatformInfo {
            os: std::env::consts::OS.to_string(),
            system_mode_supported: cfg!(windows),
            tunnel_mode_supported: cfg!(windows),
        };

        let helper_tail = read_log_tail(&helper_log_path, LOG_TAIL_LINES);
        let tunnel_tail = read_log_tail(&tunnel_log_path(&self.paths), LOG_TAIL_LINES);
        Ok(DesktopSnapshot {
            platform,
            selected_profile_id: settings.selected_profile_id,
            connection_mode: settings.connection_mode,
            profiles,
            shares,
            connection,
            share_statuses,
            helper_log_tail: helper_tail,
            tunnel_log_tail: tunnel_tail,
            share_log_tails,
            logs_dir: self.paths.logs_dir.display().to_string(),
            config_dir: self.paths.config_dir.display().to_string(),
        })
    }

    pub fn save_profile(&self, profile: ClientProfile) -> Result<(), String> {
        validate_profile(&profile)?;
        let mut profiles = load_profiles(&self.paths)?;
        upsert_by_id(&mut profiles, profile, |candidate| candidate.id.as_str());
        save_profiles(&self.paths, &profiles)?;

        let mut settings = load_settings(&self.paths)?;
        if settings.selected_profile_id.is_none() {
            settings.selected_profile_id = profiles.first().map(|item| item.id.clone());
        }
        save_settings(&self.paths, &settings)
    }

    pub fn delete_profile(&self, profile_id: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "runtime lock poisoned".to_string())?;
        if state
            .helper
            .as_ref()
            .map(|helper| helper.profile_id.as_str() == profile_id)
            .unwrap_or(false)
        {
            self.disconnect_locked(&mut state)?;
        }
        drop(state);

        let mut profiles = load_profiles(&self.paths)?;
        profiles.retain(|profile| profile.id != profile_id);
        save_profiles(&self.paths, &profiles)?;
        let mut settings = load_settings(&self.paths)?;
        normalize_settings(&mut settings, &profiles);
        save_settings(&self.paths, &settings)
    }

    pub fn save_share(&self, share: SharedProxy) -> Result<(), String> {
        validate_share(&share)?;
        let mut shares = load_shares(&self.paths)?;
        upsert_by_id(&mut shares, share, |candidate| candidate.id.as_str());
        save_shares(&self.paths, &shares)
    }

    pub fn delete_share(&self, share_id: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "runtime lock poisoned".to_string())?;
        if state.shares.contains_key(share_id) {
            self.stop_share_locked(&mut state, share_id)?;
        }
        drop(state);

        let mut shares = load_shares(&self.paths)?;
        shares.retain(|share| share.id != share_id);
        save_shares(&self.paths, &shares)
    }

    pub fn set_selected_profile(&self, profile_id: Option<String>) -> Result<(), String> {
        let profiles = load_profiles(&self.paths)?;
        let mut settings = load_settings(&self.paths)?;
        if let Some(selected) = &profile_id {
            if !profiles.iter().any(|profile| &profile.id == selected) {
                return Err("selected profile does not exist".into());
            }
        }
        settings.selected_profile_id = profile_id;
        save_settings(&self.paths, &settings)
    }

    pub fn set_mode(&self, mode: ConnectionMode) -> Result<(), String> {
        let mut settings = load_settings(&self.paths)?;
        settings.connection_mode = normalize_mode_for_platform(mode);
        save_settings(&self.paths, &settings)
    }

    pub fn connect(&self) -> Result<(), String> {
        let profiles = load_profiles(&self.paths)?;
        let mut settings = load_settings(&self.paths)?;
        normalize_settings(&mut settings, &profiles);
        settings.connection_mode = normalize_mode_for_platform(settings.connection_mode);
        save_settings(&self.paths, &settings)?;
        let selected_id = settings
            .selected_profile_id
            .clone()
            .ok_or_else(|| "add a profile before connecting".to_string())?;
        let profile = profiles
            .into_iter()
            .find(|candidate| candidate.id == selected_id)
            .ok_or_else(|| "selected profile is missing".to_string())?;
        validate_profile(&profile)?;

        let mut state = self
            .inner
            .lock()
            .map_err(|_| "runtime lock poisoned".to_string())?;
        self.disconnect_locked(&mut state)?;
        state.phase = ConnectionPhase::Connecting;
        state.message = format!("Starting {}", profile.name);

        let connection_result = (|| -> Result<
            (
                SpawnedProcess,
                Option<SpawnedProcess>,
                String,
                ConnectionMode,
                String,
            ),
            String,
        > {
            if matches!(settings.connection_mode, ConnectionMode::Tunnel) && !windows_supports_tunnel()
            {
                return Err(
                    format!(
                        "Tunnel mode requires Administrator on Windows. Reopen {} as Administrator to create the TUN interface.",
                        desktop_display_name()
                    )
                        .into(),
                );
            }

            let helper = self.spawn_helper(&profile, settings.connection_mode.clone())?;
            if matches!(settings.connection_mode, ConnectionMode::System) {
                SystemProxyManager::enable(&self.paths, helper.http_port)?;
            }
            let tunnel = if matches!(settings.connection_mode, ConnectionMode::Tunnel) {
                Some(self.spawn_tunnel(&profile, helper.socks_port)?)
            } else {
                None
            };

            let connected_message = format!("Connected via {}", profile.name);

            Ok((
                helper,
                tunnel,
                connected_message,
                settings.connection_mode.clone(),
                profile.id.clone(),
            ))
        })();

        match connection_result {
            Ok((helper, tunnel, connected_message, mode, profile_id)) => {
                state.helper = Some(ManagedHelper {
                    child: helper.child,
                    profile_id,
                    mode: mode.clone(),
                    http_port: helper.http_port,
                    socks_port: helper.socks_port,
                    log_path: helper.log_path,
                    pid_path: helper.pid_path,
                    system_proxy_enabled: matches!(mode, ConnectionMode::System),
                });
                state.tunnel = tunnel.map(|runtime_tunnel| ManagedTunnel {
                    child: runtime_tunnel.child,
                    log_path: runtime_tunnel.log_path,
                    pid_path: runtime_tunnel.pid_path,
                    interface_name: tunnel_interface_name(),
                });
                state.phase = ConnectionPhase::Connected;
                state.message = connected_message;
                Ok(())
            }
            Err(error) => {
                let _ = self.disconnect_locked(&mut state);
                state.phase = ConnectionPhase::Error;
                state.message = error.clone();
                Err(error)
            }
        }
    }

    pub fn disconnect(&self) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "runtime lock poisoned".to_string())?;
        self.disconnect_locked(&mut state)
    }

    pub fn start_share(&self, share_id: &str) -> Result<(), String> {
        let shares = load_shares(&self.paths)?;
        let share = shares
            .into_iter()
            .find(|candidate| candidate.id == share_id)
            .ok_or_else(|| "share not found".to_string())?;
        validate_share(&share)?;

        let mut state = self
            .inner
            .lock()
            .map_err(|_| "runtime lock poisoned".to_string())?;
        self.refresh_locked(&mut state)?;
        let helper = state
            .helper
            .as_ref()
            .ok_or_else(|| "connect before starting a shared proxy".to_string())?;
        if state.shares.contains_key(share_id) {
            return Ok(());
        }
        let target_port = match share.protocol {
            SharedProxyProtocol::Socks => helper.socks_port,
            SharedProxyProtocol::Http => helper.http_port,
        };
        let runtime_share = self.spawn_share(&share, target_port)?;
        state.shares.insert(
            share.id.clone(),
            ManagedShare {
                child: runtime_share.child,
                listen_host: share.listen_host,
                listen_port: share.listen_port,
                pid_path: runtime_share.pid_path,
            },
        );
        Ok(())
    }

    pub fn stop_share(&self, share_id: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "runtime lock poisoned".to_string())?;
        self.stop_share_locked(&mut state, share_id)
    }

    fn refresh_locked(&self, state: &mut RuntimeState) -> Result<(), String> {
        let helper_died = if let Some(helper) = state.helper.as_mut() {
            match helper.child.try_wait() {
                Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                Ok(None) => None,
                Err(error) => {
                    state.phase = ConnectionPhase::Error;
                    state.message = format!("failed to inspect helper: {error}");
                    Some(-1)
                }
            }
        } else {
            None
        };

        if helper_died.is_some() {
            self.stop_all_shares_locked(state)?;
            if let Some(mut tunnel) = state.tunnel.take() {
                terminate_child(&mut tunnel.child);
                let _ = fs::remove_file(&tunnel.pid_path);
            }
            if let Some(helper) = state.helper.take() {
                if helper.system_proxy_enabled {
                    let _ = SystemProxyManager::disable(&self.paths);
                }
                state.phase = ConnectionPhase::Error;
                state.message = read_log_tail(&helper.log_path, LOG_TAIL_LINES)
                    .lines()
                    .last()
                    .unwrap_or("Helper exited unexpectedly")
                    .to_string();
            }
        }

        let tunnel_died = if let Some(tunnel) = state.tunnel.as_mut() {
            match tunnel.child.try_wait() {
                Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                Ok(None) => None,
                Err(error) => {
                    state.phase = ConnectionPhase::Error;
                    state.message = format!("failed to inspect tunnel: {error}");
                    Some(-1)
                }
            }
        } else {
            None
        };

        if tunnel_died.is_some() {
            self.stop_all_shares_locked(state)?;
            if let Some(mut tunnel) = state.tunnel.take() {
                terminate_child(&mut tunnel.child);
                let _ = fs::remove_file(&tunnel.pid_path);
                state.phase = ConnectionPhase::Error;
                state.message = read_log_tail(&tunnel.log_path, LOG_TAIL_LINES)
                    .lines()
                    .last()
                    .unwrap_or("Tunnel exited unexpectedly")
                    .to_string();
            }
            if let Some(mut helper) = state.helper.take() {
                if helper.system_proxy_enabled {
                    let _ = SystemProxyManager::disable(&self.paths);
                }
                terminate_child(&mut helper.child);
                let _ = fs::remove_file(&helper.pid_path);
            }
        }

        let stale_share_ids = state
            .shares
            .iter_mut()
            .filter_map(
                |(share_id, runtime_share)| match runtime_share.child.try_wait() {
                    Ok(Some(_)) => Some(share_id.clone()),
                    Ok(None) => None,
                    Err(_) => Some(share_id.clone()),
                },
            )
            .collect::<Vec<_>>();
        for share_id in stale_share_ids {
            state.shares.remove(&share_id);
        }

        if state.helper.is_none() && matches!(state.phase, ConnectionPhase::Connected) {
            state.phase = ConnectionPhase::Disconnected;
            state.message = "Disconnected".into();
        }
        Ok(())
    }

    fn disconnect_locked(&self, state: &mut RuntimeState) -> Result<(), String> {
        state.phase = ConnectionPhase::Disconnecting;
        state.message = "Disconnecting".into();
        self.stop_all_shares_locked(state)?;
        if let Some(mut tunnel) = state.tunnel.take() {
            terminate_child(&mut tunnel.child);
            terminate_pid_file(&tunnel.pid_path);
            let _ = fs::remove_file(&tunnel.pid_path);
        }
        if let Some(mut helper) = state.helper.take() {
            if helper.system_proxy_enabled {
                let _ = SystemProxyManager::disable(&self.paths);
            }
            terminate_child(&mut helper.child);
            terminate_pid_file(&helper.pid_path);
            let mut http_cleared =
                wait_for_port_state("127.0.0.1", helper.http_port, false, PORT_TEARDOWN_TIMEOUT);
            let mut socks_cleared =
                wait_for_port_state("127.0.0.1", helper.socks_port, false, PORT_TEARDOWN_TIMEOUT);
            if !http_cleared || !socks_cleared {
                kill_twoman_port_owners(&[helper.http_port, helper.socks_port]);
                http_cleared = wait_for_port_state(
                    "127.0.0.1",
                    helper.http_port,
                    false,
                    PORT_TEARDOWN_TIMEOUT,
                );
                socks_cleared = wait_for_port_state(
                    "127.0.0.1",
                    helper.socks_port,
                    false,
                    PORT_TEARDOWN_TIMEOUT,
                );
            }
            if http_cleared && socks_cleared {
                let _ = fs::remove_file(&helper.pid_path);
            }
        } else {
            let _ = SystemProxyManager::cleanup_stale_proxy(&self.paths);
        }
        let _ = fs::remove_file(helper_listen_state_path(&self.paths));
        state.phase = ConnectionPhase::Disconnected;
        state.message = "Disconnected".into();
        Ok(())
    }

    fn stop_all_shares_locked(&self, state: &mut RuntimeState) -> Result<(), String> {
        let share_ids = state.shares.keys().cloned().collect::<Vec<_>>();
        for share_id in share_ids {
            self.stop_share_locked(state, &share_id)?;
        }
        Ok(())
    }

    fn stop_share_locked(&self, state: &mut RuntimeState, share_id: &str) -> Result<(), String> {
        let Some(mut share) = state.shares.remove(share_id) else {
            return Ok(());
        };
        terminate_child(&mut share.child);
        terminate_pid_file(&share.pid_path);
        let mut share_cleared = wait_for_port_state(
            &share.listen_host,
            share.listen_port,
            false,
            PORT_TEARDOWN_TIMEOUT,
        );
        if !share_cleared {
            kill_twoman_port_owners(&[share.listen_port]);
            share_cleared = wait_for_port_state(
                &share.listen_host,
                share.listen_port,
                false,
                PORT_TEARDOWN_TIMEOUT,
            );
        }
        if share_cleared {
            let _ = fs::remove_file(&share.pid_path);
        }
        Ok(())
    }

    fn spawn_helper(
        &self,
        profile: &ClientProfile,
        mode: ConnectionMode,
    ) -> Result<SpawnedProcess, String> {
        let log_path = helper_log_path(&self.paths);
        let config_path = helper_config_path(&self.paths);
        let pid_path = helper_pid_path(&self.paths);
        let listen_state_path = helper_listen_state_path(&self.paths);
        terminate_pid_file(&pid_path);
        let _ = fs::remove_file(&pid_path);
        let _ = fs::remove_file(&listen_state_path);
        kill_twoman_port_owners(&configured_profile_ports(profile).collect::<Vec<_>>());
        let port_conflicts = [("HTTP", profile.http_port), ("SOCKS", profile.socks_port)]
            .iter()
            .filter_map(|(label, port)| {
                if *port == 0 {
                    return None;
                }
                if port_bound("127.0.0.1", *port) {
                    Some(format!("{label} {port}"))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        if !port_conflicts.is_empty() {
            return Err(format!(
                "configured local port already in use: {}\nUpdate the profile or stop the conflicting process.",
                port_conflicts.join(", ")
            ));
        }
        let mut runtime_config = json!({
                "transport": "http",
                "transport_profile": "auto",
                "broker_base_url": profile.broker_base_url,
                "client_token": profile.client_token,
                "target_agent_peer_label": profile.target_agent_peer_label,
                "listen_host": "127.0.0.1",
                "http_listen_port": profile.http_port,
                "socks_listen_port": profile.socks_port,
                "listen_state_path": listen_state_path,
                "log_path": log_path,
                "pid_file": pid_path,
                "http_timeout_seconds": profile.http_timeout_seconds,
                "flush_delay_seconds": profile.flush_delay_seconds,
                "verify_tls": profile.verify_tls,
                "streaming_up_lanes": [],
                "idle_repoll_delay_seconds": {
                    "ctl": profile.idle_repoll_ctl_seconds,
                    "data": profile.idle_repoll_data_seconds,
                },
                "http2_enabled": {
                    "ctl": profile.http2_ctl,
                    "data": profile.http2_data,
                },
                "trace_enabled": profile.trace_enabled,
        });
        if let Some(config) = runtime_config.as_object_mut() {
            if profile.max_batch_bytes > 0 {
                config.insert("max_batch_bytes".into(), json!(profile.max_batch_bytes));
            }
            let mut data_profile = serde_json::Map::new();
            if profile.data_upload_max_batch_bytes > 0 {
                data_profile.insert(
                    "max_batch_bytes".into(),
                    json!(profile.data_upload_max_batch_bytes),
                );
            }
            if profile.data_upload_flush_delay_seconds > 0.0 {
                data_profile.insert(
                    "flush_delay_seconds".into(),
                    json!(profile.data_upload_flush_delay_seconds),
                );
            }
            if !data_profile.is_empty() {
                config.insert("upload_profiles".into(), json!({ "data": data_profile }));
            }
        }
        fs::write(
            &config_path,
            serde_json::to_vec_pretty(&runtime_config)
                .map_err(|error| format!("failed to serialize helper config: {error}"))?,
        )
        .map_err(|error| format!("failed to write helper config: {error}"))?;

        let mut child = spawn_runtime_command(
            self.runtime_program_kind("helper", &config_path)?,
            &log_path,
        )?;

        let Some(listen_state) = wait_for_helper_listen_state(
            &mut child,
            &log_path,
            &listen_state_path,
            PORT_WAIT_TIMEOUT,
        ) else {
            terminate_child(&mut child);
            return Err(format!(
                "helper failed to start in {} mode\n{}",
                match mode {
                    ConnectionMode::Proxy => "proxy",
                    ConnectionMode::System => "system",
                    ConnectionMode::Tunnel => "tunnel",
                },
                read_log_tail(&log_path, LOG_TAIL_LINES)
            ));
        };
        if !listen_port_matches(profile.http_port, listen_state.http_port)
            || !listen_port_matches(profile.socks_port, listen_state.socks_port)
        {
            terminate_child(&mut child);
            terminate_pid_file(&pid_path);
            return Err(format!(
                "helper bound unexpected local ports (expected HTTP {} / SOCKS {}, got HTTP {} / SOCKS {})",
                listen_port_expectation(profile.http_port),
                listen_port_expectation(profile.socks_port),
                listen_state.http_port,
                listen_state.socks_port
            ));
        }

        Ok(SpawnedProcess {
            child,
            log_path,
            pid_path,
            http_port: listen_state.http_port,
            socks_port: listen_state.socks_port,
        })
    }

    fn spawn_tunnel(
        &self,
        profile: &ClientProfile,
        helper_socks_port: u16,
    ) -> Result<SpawnedProcess, String> {
        let log_path = tunnel_log_path(&self.paths);
        let config_path = tunnel_config_path(&self.paths);
        let pid_path = tunnel_pid_path(&self.paths);
        let work_dir = tunnel_work_dir(&self.paths);
        let mut route_exclude_address = vec![
            "127.0.0.0/8".to_string(),
            "10.0.0.0/8".to_string(),
            "100.64.0.0/10".to_string(),
            "169.254.0.0/16".to_string(),
            "172.16.0.0/12".to_string(),
            "192.168.0.0/16".to_string(),
            "224.0.0.0/4".to_string(),
            "::1/128".to_string(),
            "fc00::/7".to_string(),
            "fe80::/10".to_string(),
        ];
        route_exclude_address.extend(resolve_profile_bypass_cidrs(profile)?);
        terminate_pid_file(&pid_path);
        let _ = fs::remove_file(&pid_path);
        fs::create_dir_all(&work_dir)
            .map_err(|error| format!("failed to create {}: {error}", work_dir.display()))?;
        fs::write(
            &config_path,
            serde_json::to_vec_pretty(&json!({
                "log": {
                    "level": "info",
                    "timestamp": true,
                },
                "dns": {
                    "servers": [
                        {
                            "type": "local",
                            "tag": "local",
                        }
                    ],
                    "final": "local",
                    "strategy": "prefer_ipv4",
                },
                "inbounds": [
                    {
                        "type": "tun",
                        "tag": "tun-in",
                        "interface_name": tunnel_interface_name(),
                        "address": [
                            "172.19.0.1/30",
                            "fdfe:dcba:9876::1/126",
                        ],
                        "auto_route": true,
                        "strict_route": true,
                        "stack": "mixed",
                        "sniff": true,
                        "sniff_override_destination": true,
                        "route_exclude_address": route_exclude_address,
                    }
                ],
                "outbounds": [
                    {
                        "type": "socks",
                        "tag": "proxy",
                        "server": "127.0.0.1",
                        "server_port": helper_socks_port,
                        "version": "5",
                    },
                    {
                        "type": "direct",
                        "tag": "direct",
                    }
                ],
                "route": {
                    "rules": [
                        {
                            "action": "sniff",
                        },
                        {
                            "type": "logical",
                            "mode": "or",
                            "rules": [
                                {
                                    "protocol": "dns",
                                },
                                {
                                    "port": 53,
                                }
                            ],
                            "action": "hijack-dns",
                        },
                        {
                            "network": "udp",
                            "action": "reject",
                        },
                        {
                            "ip_is_private": true,
                            "outbound": "direct",
                        }
                    ],
                    "final": "proxy",
                    "auto_detect_interface": true,
                    "default_domain_resolver": "local",
                }
            }))
            .map_err(|error| format!("failed to serialize tunnel config: {error}"))?,
        )
        .map_err(|error| format!("failed to write tunnel config: {error}"))?;

        let mut child = spawn_runtime_command(
            self.runtime_program_kind("tunnel", &config_path)?,
            &log_path,
        )?;
        if !wait_for_log_marker(
            &mut child,
            &log_path,
            &["sing-box started", "started at"],
            TUNNEL_WAIT_TIMEOUT,
        ) {
            terminate_child(&mut child);
            terminate_pid_file(&pid_path);
            return Err(format!(
                "tunnel failed to start\n{}\nTunnel mode uses a Windows TUN adapter and may require Administrator approval the first time it installs or opens the adapter.",
                read_log_tail(&log_path, LOG_TAIL_LINES)
            ));
        }

        Ok(SpawnedProcess {
            child,
            log_path,
            pid_path,
            http_port: 0,
            socks_port: 0,
        })
    }

    fn spawn_share(&self, share: &SharedProxy, target_port: u16) -> Result<SpawnedProcess, String> {
        kill_twoman_port_owners(&[share.listen_port]);
        if port_bound(&share.listen_host, share.listen_port) {
            return Err(format!(
                "share port already in use: {}:{}\nChoose a different listen port.",
                share.listen_host, share.listen_port
            ));
        }

        let log_path = share_log_path(&self.paths, &share.id);
        let config_path = share_config_path(&self.paths, &share.id);
        let pid_path = share_pid_path(&self.paths, &share.id);
        terminate_pid_file(&pid_path);
        let _ = fs::remove_file(&pid_path);
        fs::write(
            &config_path,
            serde_json::to_vec_pretty(&json!({
                "name": share.name,
                "protocol": share.protocol,
                "listen_host": share.listen_host,
                "listen_port": share.listen_port,
                "target_host": "127.0.0.1",
                "target_port": target_port,
                "username": share.username,
                "password": share.password,
                "log_path": log_path,
                "pid_file": pid_path,
            }))
            .map_err(|error| format!("failed to serialize share config: {error}"))?,
        )
        .map_err(|error| format!("failed to write share config: {error}"))?;

        let mut child = spawn_runtime_command(
            self.runtime_program_kind("gateway", &config_path)?,
            &log_path,
        )?;
        if !wait_for_listener_start(
            &mut child,
            &log_path,
            &share.listen_host,
            share.listen_port,
            "gateway started",
            PORT_WAIT_TIMEOUT,
        ) {
            terminate_child(&mut child);
            terminate_pid_file(&pid_path);
            return Err(format!(
                "share failed to start\n{}",
                read_log_tail(&log_path, LOG_TAIL_LINES)
            ));
        }
        Ok(SpawnedProcess {
            child,
            log_path,
            pid_path,
            http_port: 0,
            socks_port: 0,
        })
    }

    fn runtime_program_kind(&self, kind: &str, config_path: &Path) -> Result<ProgramSpec, String> {
        let env_var = match kind {
            "helper" => "TWOMAN_HELPER_BIN",
            "gateway" => "TWOMAN_GATEWAY_BIN",
            "tunnel" => "TWOMAN_TUNNEL_BIN",
            _ => return Err("unknown runtime kind".into()),
        };
        if let Ok(env_bin) = std::env::var(env_var) {
            return Ok(program_spec_for_kind(
                kind,
                PathBuf::from(env_bin),
                config_path,
                &self.paths,
            ));
        }

        if let Some(sidecar) = self.find_sidecar(kind) {
            return Ok(program_spec_for_kind(
                kind,
                sidecar,
                config_path,
                &self.paths,
            ));
        }

        runtime_program_from_source(kind, config_path)
    }

    fn find_sidecar(&self, kind: &str) -> Option<PathBuf> {
        let executable_name = sidecar_name(kind);
        let mut candidates = Vec::new();
        if let Some(resource_dir) = &self.resource_dir {
            candidates.push(
                resource_dir
                    .join(platform_sidecar_folder())
                    .join(&executable_name),
            );
            candidates.push(resource_dir.join(&executable_name));
            candidates.push(
                resource_dir
                    .join("sidecars")
                    .join(platform_sidecar_folder())
                    .join(&executable_name),
            );
        }
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(parent) = current_exe.parent() {
                candidates.push(
                    parent
                        .join("sidecars")
                        .join(platform_sidecar_folder())
                        .join(&executable_name),
                );
                candidates.push(parent.join(&executable_name));
            }
        }
        candidates.into_iter().find(|candidate| candidate.exists())
    }
}

struct SpawnedProcess {
    child: Child,
    log_path: PathBuf,
    pid_path: PathBuf,
    http_port: u16,
    socks_port: u16,
}

#[derive(Debug, Deserialize)]
struct HelperListenState {
    http_port: u16,
    socks_port: u16,
}

struct ProgramSpec {
    executable: PathBuf,
    args: Vec<String>,
    working_dir: Option<PathBuf>,
}

fn program_spec_for_kind(
    kind: &str,
    executable: PathBuf,
    config_path: &Path,
    paths: &AppPaths,
) -> ProgramSpec {
    match kind {
        "tunnel" => tunnel_program_spec(executable, config_path, tunnel_work_dir(paths)),
        _ => ProgramSpec {
            executable,
            args: vec!["--config".into(), config_path.display().to_string()],
            working_dir: None,
        },
    }
}

fn tunnel_program_spec(
    executable: PathBuf,
    config_path: &Path,
    working_dir: PathBuf,
) -> ProgramSpec {
    ProgramSpec {
        executable,
        args: vec![
            "run".into(),
            "-c".into(),
            config_path.display().to_string(),
            "-D".into(),
            working_dir.display().to_string(),
            "--disable-color".into(),
        ],
        working_dir: None,
    }
}

fn runtime_program_from_source(kind: &str, config_path: &Path) -> Result<ProgramSpec, String> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .map_err(|error| format!("failed to resolve repo root: {error}"))?;
    if kind == "helper" {
        let helper_agent_dir = repo_root.join("helper-agent");
        if !helper_agent_dir.join("go.mod").exists() {
            return Err("Go helper source is missing from helper-agent".into());
        }
        if !go_tool_available() {
            return Err("Go is required to run the Twoman helper from source".into());
        }
        return Ok(ProgramSpec {
            executable: PathBuf::from("go"),
            args: vec![
                "run".into(),
                ".".into(),
                "--config".into(),
                config_path.display().to_string(),
                "--mode".into(),
                "helper".into(),
            ],
            working_dir: Some(helper_agent_dir),
        });
    }
    let (script_path, default_python) = match kind {
        "gateway" => (
            repo_root.join("desktop_client/socks_gateway.py"),
            python_launcher(),
        ),
        "tunnel" => {
            let sidecar_path = repo_root
                .join("desktop_app/src-tauri/resources/sidecars")
                .join(platform_sidecar_folder())
                .join(sidecar_name("tunnel"));
            if sidecar_path.exists() {
                let working_dir = repo_root.join("desktop_app/src-tauri/target/tunnel-runtime");
                fs::create_dir_all(&working_dir).map_err(|error| {
                    format!("failed to create {}: {error}", working_dir.display())
                })?;
                return Ok(tunnel_program_spec(sidecar_path, config_path, working_dir));
            }
            return Err("no source-mode tunnel runtime is available; build or bundle the Windows tunnel sidecar".into());
        }
        _ => return Err("unknown runtime kind".into()),
    };
    if script_path.exists() {
        let mut args = vec![script_path.display().to_string()];
        args.push("--config".into());
        args.push(config_path.display().to_string());
        return Ok(ProgramSpec {
            executable: default_python,
            args,
            working_dir: Some(repo_root),
        });
    }

    Err(format!(
        "no runtime binary or source script found for {kind}"
    ))
}

fn resolve_profile_bypass_cidrs(profile: &ClientProfile) -> Result<Vec<String>, String> {
    let (host, port) = parse_profile_upstream_host_port(&profile.broker_base_url)?;
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve tunnel bypass host {host}:{port}: {error}"))?;
    let mut cidrs = Vec::new();
    for address in addresses {
        let cidr = match address.ip() {
            std::net::IpAddr::V4(ip) => format!("{ip}/32"),
            std::net::IpAddr::V6(ip) => format!("{ip}/128"),
        };
        if !cidrs.contains(&cidr) {
            cidrs.push(cidr);
        }
    }
    if cidrs.is_empty() {
        return Err(format!(
            "tunnel bypass resolution returned no addresses for {}",
            profile.broker_base_url
        ));
    }
    Ok(cidrs)
}

fn parse_profile_upstream_host_port(base_url: &str) -> Result<(String, u16), String> {
    let (scheme, remainder) = base_url
        .split_once("://")
        .ok_or_else(|| format!("invalid broker_base_url: {base_url}"))?;
    let authority = remainder
        .split('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("invalid broker_base_url: {base_url}"))?;
    let default_port = match scheme.to_ascii_lowercase().as_str() {
        "http" => 80,
        "https" => 443,
        other => return Err(format!("unsupported broker scheme {other} in {base_url}")),
    };

    if let Some(rest) = authority.strip_prefix('[') {
        let (host, suffix) = rest
            .split_once(']')
            .ok_or_else(|| format!("invalid IPv6 broker address in {base_url}"))?;
        let port = suffix
            .strip_prefix(':')
            .map(|value| {
                value
                    .parse::<u16>()
                    .map_err(|error| format!("invalid broker port in {base_url}: {error}"))
            })
            .transpose()?
            .unwrap_or(default_port);
        return Ok((host.to_string(), port));
    }

    if let Some((host, port_text)) = authority.rsplit_once(':') {
        if !host.contains(':') {
            let port = port_text
                .parse::<u16>()
                .map_err(|error| format!("invalid broker port in {base_url}: {error}"))?;
            return Ok((host.to_string(), port));
        }
    }

    Ok((authority.to_string(), default_port))
}

fn desktop_display_name() -> &'static str {
    option_env!("TWOMAN_DESKTOP_DISPLAY_NAME").unwrap_or("Twoman")
}

fn tunnel_interface_name() -> String {
    option_env!("TWOMAN_TUNNEL_INTERFACE_NAME")
        .unwrap_or("Twoman Tunnel")
        .to_string()
}

fn sidecar_basename(kind: &str) -> &'static str {
    match kind {
        "helper" => option_env!("TWOMAN_HELPER_BINARY_BASENAME").unwrap_or("twoman-helper"),
        "gateway" => option_env!("TWOMAN_GATEWAY_BINARY_BASENAME").unwrap_or("twoman-gateway"),
        "tunnel" => option_env!("TWOMAN_TUNNEL_BINARY_BASENAME").unwrap_or("twoman-tunnel"),
        _ => "runtime-helper",
    }
}

fn sidecar_name(kind: &str) -> String {
    if cfg!(windows) {
        format!("{}.exe", sidecar_basename(kind))
    } else {
        sidecar_basename(kind).to_string()
    }
}

fn platform_sidecar_folder() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn python_launcher() -> PathBuf {
    if cfg!(windows) {
        return PathBuf::from("py");
    }
    PathBuf::from("python3")
}

fn go_tool_available() -> bool {
    Command::new("go")
        .arg("version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn spawn_runtime_command(program: ProgramSpec, log_path: &Path) -> Result<Child, String> {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| format!("failed to open {}: {error}", log_path.display()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("failed to clone log handle: {error}"))?;

    let mut command = Command::new(&program.executable);
    if cfg!(windows) && program.executable == PathBuf::from("py") {
        command.arg("-3");
    }
    command.args(&program.args);
    if let Some(working_dir) = &program.working_dir {
        command.current_dir(working_dir);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::from(stdout));
    command.stderr(Stdio::from(stderr));
    #[cfg(windows)]
    {
        // Keep helper and share sidecars background-only in the packaged desktop app.
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|error| format!("failed to start {}: {error}", program.executable.display()))
}

#[cfg(windows)]
fn terminate_child(child: &mut Child) {
    let pid = child.id();
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T", "/F"]);
    command.stdin(Stdio::null());
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());
    command.creation_flags(CREATE_NO_WINDOW);
    let _ = command.status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_for_port_state(host: &str, port: u16, expected_bound: bool, timeout: Duration) -> bool {
    if port == 0 {
        return !expected_bound;
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let listening = listener_accepts_connections(host, port);
        let bound = port_bound(host, port);
        let state_matches = if expected_bound {
            listening || bound
        } else {
            !listening && !bound
        };
        if state_matches {
            return true;
        }
        thread::sleep(Duration::from_millis(150));
    }
    false
}

fn wait_for_helper_listen_state(
    child: &mut Child,
    _log_path: &Path,
    state_path: &Path,
    timeout: Duration,
) -> Option<HelperListenState> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) => {}
        }
        let state = fs::read_to_string(state_path)
            .ok()
            .and_then(|content| serde_json::from_str::<HelperListenState>(&content).ok());
        if let Some(state) = state {
            if state.http_port > 0
                && state.socks_port > 0
                && wait_for_port_state("127.0.0.1", state.http_port, true, Duration::from_secs(1))
                && wait_for_port_state("127.0.0.1", state.socks_port, true, Duration::from_secs(1))
            {
                return Some(state);
            }
        }
        thread::sleep(Duration::from_millis(150));
    }
    None
}

fn wait_for_listener_start(
    child: &mut Child,
    log_path: &Path,
    host: &str,
    port: u16,
    success_marker: &str,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return false,
            Ok(None) => {}
        }
        if listener_accepts_connections(host, port) {
            return true;
        }
        if read_log_tail(log_path, 8).contains(success_marker) {
            return true;
        }
        thread::sleep(Duration::from_millis(150));
    }
    false
}

fn wait_for_log_marker(
    child: &mut Child,
    log_path: &Path,
    markers: &[&str],
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return false,
            Ok(None) => {}
        }
        let tail = read_log_tail(log_path, 12);
        if markers.iter().any(|marker| tail.contains(marker)) {
            return true;
        }
        thread::sleep(Duration::from_millis(150));
    }
    false
}

fn port_bound(host: &str, port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let bind_host = if host == "0.0.0.0" || host == "::" {
        "127.0.0.1"
    } else {
        host
    };
    TcpListener::bind((bind_host, port)).is_err()
}

fn listener_accepts_connections(host: &str, port: u16) -> bool {
    if port == 0 {
        return false;
    }
    listener_probe_hosts(host)
        .into_iter()
        .filter_map(|candidate| (candidate.as_str(), port).to_socket_addrs().ok())
        .flatten()
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok())
}

fn configured_profile_ports(profile: &ClientProfile) -> impl Iterator<Item = u16> {
    [profile.http_port, profile.socks_port]
        .into_iter()
        .filter(|port| *port > 0)
}

fn listen_port_matches(configured: u16, bound: u16) -> bool {
    bound > 0 && (configured == 0 || configured == bound)
}

fn listen_port_expectation(configured: u16) -> String {
    if configured == 0 {
        "dynamic".to_string()
    } else {
        configured.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_profile_port_accepts_assigned_port() {
        assert!(listen_port_matches(0, 49152));
        assert!(!listen_port_matches(0, 0));
    }

    #[test]
    fn fixed_profile_port_requires_exact_bound_port() {
        assert!(listen_port_matches(11092, 11092));
        assert!(!listen_port_matches(11092, 1080));
    }

    #[test]
    fn port_zero_is_never_treated_as_a_real_listener() {
        assert!(!port_bound("127.0.0.1", 0));
        assert!(!listener_accepts_connections("127.0.0.1", 0));
        assert!(wait_for_port_state(
            "127.0.0.1",
            0,
            false,
            Duration::from_millis(1)
        ));
        assert!(!wait_for_port_state(
            "127.0.0.1",
            0,
            true,
            Duration::from_millis(1)
        ));
    }
}

fn listener_probe_hosts(host: &str) -> Vec<String> {
    if host == "0.0.0.0" || host == "::" {
        vec!["127.0.0.1".into()]
    } else {
        vec![host.to_string()]
    }
}

fn terminate_pid_file(pid_path: &Path) {
    let Ok(raw_pid) = fs::read_to_string(pid_path) else {
        return;
    };
    let Ok(pid) = raw_pid.trim().parse::<u32>() else {
        return;
    };
    terminate_pid(pid);
}

#[cfg(windows)]
fn kill_twoman_port_owners(ports: &[u16]) {
    let helper_marker = sidecar_basename("helper").to_ascii_lowercase();
    let gateway_marker = sidecar_basename("gateway").to_ascii_lowercase();
    for pid in port_owner_pids(ports) {
        if let Some(name) = process_name_for_pid(pid) {
            let lower = name.to_ascii_lowercase();
            if lower.contains("desktop_app")
                || lower.contains(helper_marker.as_str())
                || lower.contains(gateway_marker.as_str())
            {
                terminate_pid(pid);
            }
        }
    }
}

#[cfg(not(windows))]
fn kill_twoman_port_owners(_ports: &[u16]) {}

#[cfg(windows)]
fn port_owner_pids(ports: &[u16]) -> Vec<u32> {
    let Ok(output) = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pids = Vec::new();
    for line in stdout.lines() {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 5 || !parts[0].eq_ignore_ascii_case("tcp") {
            continue;
        }
        let local = parts[1];
        let state = parts[3];
        let pid = parts[4];
        if !state.eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        let Some((_, raw_port)) = local.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = raw_port.trim().parse::<u16>() else {
            continue;
        };
        if !ports.contains(&port) {
            continue;
        }
        let Ok(pid) = pid.trim().parse::<u32>() else {
            continue;
        };
        if !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    pids
}

#[cfg(windows)]
fn process_name_for_pid(pid: u32) -> Option<String> {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.lines().next()?.trim();
    if first.is_empty() || first.starts_with("INFO:") {
        return None;
    }
    let trimmed = first.trim_matches('"');
    let name = trimmed.split("\",\"").next()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(windows)]
fn terminate_pid(pid: u32) {
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T", "/F"]);
    command.stdin(Stdio::null());
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());
    command.creation_flags(CREATE_NO_WINDOW);
    let _ = command.status();
}

#[cfg(windows)]
fn windows_supports_tunnel() -> bool {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .trim()
            .eq_ignore_ascii_case("true"),
        _ => false,
    }
}

#[cfg(not(windows))]
fn windows_supports_tunnel() -> bool {
    false
}

#[cfg(not(windows))]
fn terminate_pid(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn discover_share_addresses(listen_host: &str, listen_port: u16) -> Vec<String> {
    if listen_host != "0.0.0.0" && listen_host != "::" {
        return vec![format!("{listen_host}:{listen_port}")];
    }
    let mut addresses = vec![format!("127.0.0.1:{listen_port}")];
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:53").is_ok() {
            if let Ok(local_address) = socket.local_addr() {
                let candidate = format!("{}:{listen_port}", local_address.ip());
                if !addresses.contains(&candidate) {
                    addresses.push(candidate);
                }
            }
        }
    }
    addresses.sort();
    addresses
}

fn upsert_by_id<T, F>(items: &mut Vec<T>, value: T, id_fn: F)
where
    F: Fn(&T) -> &str,
{
    if let Some(index) = items
        .iter()
        .position(|candidate| id_fn(candidate) == id_fn(&value))
    {
        items[index] = value;
    } else {
        items.push(value);
    }
}

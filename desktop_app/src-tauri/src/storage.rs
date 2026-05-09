use std::{
    fs,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager, Runtime};

use crate::models::{
    ClientProfile, ConnectionMode, PersistedSettings, SharedProxy, SharedProxyProtocol,
};

const DEFAULT_DESKTOP_HTTP_PORT: u16 = 28_167;
const DEFAULT_DESKTOP_SOCKS_PORT: u16 = 21_167;

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub config_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub profiles_file: PathBuf,
    pub shares_file: PathBuf,
    pub settings_file: PathBuf,
}

impl AppPaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let portable_root = portable_root_from_current_exe();
        let (config_dir, runtime_dir, logs_dir) = if let Some(portable_root) = portable_root {
            (
                portable_root.join("config"),
                portable_root.join("runtime"),
                portable_root.join("twoman-logs"),
            )
        } else {
            let config_dir = app
                .path()
                .app_config_dir()
                .map_err(|error| format!("failed to resolve config dir: {error}"))?;
            let runtime_root = app
                .path()
                .app_local_data_dir()
                .map_err(|error| format!("failed to resolve local data dir: {error}"))?;
            let runtime_dir = runtime_root.join("runtime");
            let logs_dir = runtime_root.join("twoman-logs");
            (config_dir, runtime_dir, logs_dir)
        };

        for directory in [&config_dir, &runtime_dir, &logs_dir] {
            fs::create_dir_all(directory)
                .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
        }

        Ok(Self {
            profiles_file: config_dir.join("profiles.json"),
            shares_file: config_dir.join("shares.json"),
            settings_file: config_dir.join("settings.json"),
            config_dir,
            runtime_dir,
            logs_dir,
        })
    }
}

fn portable_root_from_current_exe() -> Option<PathBuf> {
    if std::env::var("TWOMAN_PORTABLE")
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
    {
        let exe = std::env::current_exe().ok()?;
        let exe_dir = exe.parent()?;
        return Some(exe_dir.join("portable-data"));
    }
    let exe = std::env::current_exe().ok()?;
    portable_root_from_exe_path(&exe)
}

fn portable_root_from_exe_path(exe_path: &Path) -> Option<PathBuf> {
    let exe_dir = exe_path.parent()?;
    let portable_root = exe_dir.join("portable-data");
    if portable_root.exists() || exe_dir.join("twoman-portable").exists() {
        return Some(portable_root);
    }
    None
}

pub fn load_profiles(paths: &AppPaths) -> Result<Vec<ClientProfile>, String> {
    let mut profiles: Vec<ClientProfile> = read_json_list(&paths.profiles_file)?;
    for profile in &mut profiles {
        normalize_profile_transport_tuning(profile);
    }
    Ok(profiles)
}

pub fn save_profiles(paths: &AppPaths, profiles: &[ClientProfile]) -> Result<(), String> {
    write_json(&paths.profiles_file, profiles)
}

pub fn load_shares(paths: &AppPaths) -> Result<Vec<SharedProxy>, String> {
    read_json_list(&paths.shares_file)
}

pub fn save_shares(paths: &AppPaths, shares: &[SharedProxy]) -> Result<(), String> {
    write_json(&paths.shares_file, shares)
}

pub fn load_settings(paths: &AppPaths) -> Result<PersistedSettings, String> {
    if !paths.settings_file.exists() {
        return Ok(PersistedSettings::default());
    }
    let content = fs::read_to_string(&paths.settings_file)
        .map_err(|error| format!("failed to read settings: {error}"))?;
    serde_json::from_str::<PersistedSettings>(&content)
        .map_err(|error| format!("failed to parse settings: {error}"))
}

pub fn save_settings(paths: &AppPaths, settings: &PersistedSettings) -> Result<(), String> {
    write_json(&paths.settings_file, settings)
}

pub fn read_log_tail(path: &Path, line_limit: usize) -> String {
    let Ok(content) = fs::read_to_string(path) else {
        return String::new();
    };
    let mut lines = content.lines().collect::<Vec<_>>();
    if lines.len() > line_limit {
        lines = lines.split_off(lines.len() - line_limit);
    }
    lines.join("\n")
}

pub fn helper_log_path(paths: &AppPaths) -> PathBuf {
    paths.logs_dir.join("helper.log")
}

pub fn share_log_path(paths: &AppPaths, share_id: &str) -> PathBuf {
    paths.logs_dir.join(format!("share-{share_id}.log"))
}

pub fn helper_config_path(paths: &AppPaths) -> PathBuf {
    paths.runtime_dir.join("helper.json")
}

pub fn helper_pid_path(paths: &AppPaths) -> PathBuf {
    paths.runtime_dir.join("helper.pid")
}

pub fn helper_listen_state_path(paths: &AppPaths) -> PathBuf {
    paths.runtime_dir.join("helper-listen-state.json")
}

pub fn tunnel_log_path(paths: &AppPaths) -> PathBuf {
    paths.logs_dir.join("tunnel.log")
}

pub fn tunnel_config_path(paths: &AppPaths) -> PathBuf {
    paths.runtime_dir.join("tunnel.json")
}

pub fn tunnel_pid_path(paths: &AppPaths) -> PathBuf {
    paths.runtime_dir.join("tunnel.pid")
}

pub fn tunnel_work_dir(paths: &AppPaths) -> PathBuf {
    paths.runtime_dir.join("tunnel-data")
}

pub fn share_config_path(paths: &AppPaths, share_id: &str) -> PathBuf {
    paths.runtime_dir.join(format!("share-{share_id}.json"))
}

pub fn share_pid_path(paths: &AppPaths, share_id: &str) -> PathBuf {
    paths.runtime_dir.join(format!("share-{share_id}.pid"))
}

fn read_json_list<T>(path: &Path) -> Result<Vec<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str::<Vec<T>>(&content)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

fn write_json<T>(path: &Path, payload: &T) -> Result<(), String>
where
    T: serde::Serialize + ?Sized,
{
    let content = serde_json::to_string_pretty(payload)
        .map_err(|error| format!("failed to serialize {}: {error}", path.display()))?;
    fs::write(path, content).map_err(|error| format!("failed to write {}: {error}", path.display()))
}

pub fn validate_profile(profile: &ClientProfile) -> Result<(), String> {
    if profile.id.trim().is_empty() {
        return Err("profile id is required".into());
    }
    if profile.name.trim().is_empty() {
        return Err("profile name is required".into());
    }
    if profile.broker_base_url.trim().is_empty() {
        return Err("broker url is required".into());
    }
    if profile.client_token.trim().is_empty() {
        return Err("client token is required".into());
    }
    Ok(())
}

pub fn normalize_profile_transport_tuning(profile: &mut ClientProfile) {
    normalize_profile_helper_peer_id(profile);
    if profile.http_port == 0 {
        profile.http_port = DEFAULT_DESKTOP_HTTP_PORT;
    }
    if profile.socks_port == 0 {
        profile.socks_port = DEFAULT_DESKTOP_SOCKS_PORT;
    }
    if profile.max_batch_bytes == 65_536 {
        profile.max_batch_bytes = 0;
    }
    if profile.data_upload_max_batch_bytes == 65_536 {
        profile.data_upload_max_batch_bytes = 0;
    }
}

fn normalize_profile_helper_peer_id(profile: &mut ClientProfile) {
    let current = sanitize_peer_component(&profile.helper_peer_id);
    if !current.is_empty() {
        profile.helper_peer_id = current;
        return;
    }
    let suffix = sanitize_peer_component(&profile.id);
    let suffix = if suffix.is_empty() {
        "profile".to_string()
    } else {
        suffix
    };
    profile.helper_peer_id = format!("twoman-desktop-{suffix}");
    if profile.helper_peer_id.len() > 80 {
        profile.helper_peer_id.truncate(80);
        while profile.helper_peer_id.ends_with('-') {
            profile.helper_peer_id.pop();
        }
    }
}

fn sanitize_peer_component(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for ch in value.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            output.push(ch);
            previous_dash = false;
        } else if !previous_dash && !output.is_empty() {
            output.push('-');
            previous_dash = true;
        }
    }
    while output.ends_with('-') {
        output.pop();
    }
    output
}

pub fn validate_share(share: &SharedProxy) -> Result<(), String> {
    if share.id.trim().is_empty() {
        return Err("share id is required".into());
    }
    if share.name.trim().is_empty() {
        return Err("share name is required".into());
    }
    if share.listen_host.trim().is_empty() {
        return Err("share host is required".into());
    }
    if share.listen_port == 0 {
        return Err("share port must be greater than zero".into());
    }
    if !matches!(
        share.protocol,
        SharedProxyProtocol::Socks | SharedProxyProtocol::Http
    ) {
        return Err("share protocol is invalid".into());
    }
    if share.username.trim().is_empty() || share.password.trim().is_empty() {
        return Err("share credentials are required".into());
    }
    Ok(())
}

pub fn normalize_settings(settings: &mut PersistedSettings, profiles: &[ClientProfile]) {
    if let Some(selected_profile_id) = &settings.selected_profile_id {
        if profiles
            .iter()
            .any(|profile| &profile.id == selected_profile_id)
        {
            return;
        }
    }
    settings.selected_profile_id = profiles.first().map(|profile| profile.id.clone());
}

pub fn normalize_mode_for_platform(mode: ConnectionMode) -> ConnectionMode {
    if cfg!(windows) {
        return mode;
    }
    ConnectionMode::Proxy
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        normalize_profile_transport_tuning, portable_root_from_exe_path, ClientProfile,
        DEFAULT_DESKTOP_HTTP_PORT, DEFAULT_DESKTOP_SOCKS_PORT,
    };

    fn temp_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        std::env::temp_dir().join(format!("twoman-portable-test-{nonce}"))
    }

    #[test]
    fn portable_mode_uses_portable_data_directory_when_present() {
        let root = temp_root();
        let exe_dir = root.join("portable-app");
        fs::create_dir_all(exe_dir.join("portable-data")).expect("create portable-data");
        let exe_path = exe_dir.join(if cfg!(windows) {
            "Twoman.exe"
        } else {
            "twoman"
        });

        let resolved =
            portable_root_from_exe_path(&exe_path).expect("portable root should resolve");
        assert_eq!(resolved, exe_dir.join("portable-data"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn portable_mode_uses_marker_file_when_directory_is_not_precreated() {
        let root = temp_root();
        let exe_dir = root.join("portable-app");
        fs::create_dir_all(&exe_dir).expect("create exe dir");
        fs::write(exe_dir.join("twoman-portable"), b"").expect("create marker");
        let exe_path = exe_dir.join(if cfg!(windows) {
            "Twoman.exe"
        } else {
            "twoman"
        });

        let resolved =
            portable_root_from_exe_path(&exe_path).expect("portable root should resolve");
        assert_eq!(resolved, exe_dir.join("portable-data"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_zero_ports_migrate_to_stable_desktop_defaults() {
        let mut profile = ClientProfile {
            id: "profile".into(),
            helper_peer_id: String::new(),
            name: "Profile".into(),
            broker_base_url: "https://example.com/parvaneh".into(),
            client_token: "token".into(),
            target_agent_peer_label: String::new(),
            verify_tls: true,
            http2_ctl: true,
            http2_data: false,
            http_port: 0,
            socks_port: 0,
            http_timeout_seconds: 30,
            flush_delay_seconds: 0.01,
            max_batch_bytes: 65_536,
            data_upload_max_batch_bytes: 65_536,
            data_upload_flush_delay_seconds: 0.0,
            idle_repoll_ctl_seconds: 0.05,
            idle_repoll_data_seconds: 0.1,
            trace_enabled: false,
        };

        normalize_profile_transport_tuning(&mut profile);

        assert_eq!(profile.http_port, DEFAULT_DESKTOP_HTTP_PORT);
        assert_eq!(profile.socks_port, DEFAULT_DESKTOP_SOCKS_PORT);
        assert_eq!(profile.max_batch_bytes, 0);
        assert_eq!(profile.data_upload_max_batch_bytes, 0);
        assert_eq!(profile.helper_peer_id, "twoman-desktop-profile");
    }
}

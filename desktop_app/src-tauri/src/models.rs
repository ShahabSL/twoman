use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionMode {
    Proxy,
    System,
    Tunnel,
}

impl Default for ConnectionMode {
    fn default() -> Self {
        Self::Proxy
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionPhase {
    Disconnected,
    Connecting,
    Connected,
    Disconnecting,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SharedProxyProtocol {
    Socks,
    Http,
}

impl Default for SharedProxyProtocol {
    fn default() -> Self {
        Self::Socks
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientProfile {
    pub id: String,
    #[serde(default)]
    pub helper_peer_id: String,
    pub name: String,
    pub broker_base_url: String,
    pub client_token: String,
    #[serde(default)]
    pub target_agent_peer_label: String,
    pub verify_tls: bool,
    pub http2_ctl: bool,
    pub http2_data: bool,
    pub http_port: u16,
    pub socks_port: u16,
    pub http_timeout_seconds: u32,
    pub flush_delay_seconds: f64,
    #[serde(default)]
    pub max_batch_bytes: u32,
    #[serde(default)]
    pub data_upload_max_batch_bytes: u32,
    #[serde(default)]
    pub data_upload_flush_delay_seconds: f64,
    pub idle_repoll_ctl_seconds: f64,
    pub idle_repoll_data_seconds: f64,
    pub trace_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedProxy {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub protocol: SharedProxyProtocol,
    pub listen_host: String,
    pub listen_port: u16,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSettings {
    pub selected_profile_id: Option<String>,
    pub connection_mode: ConnectionMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,
    pub system_mode_supported: bool,
    pub tunnel_mode_supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub phase: ConnectionPhase,
    pub mode: ConnectionMode,
    pub active_profile_id: Option<String>,
    pub helper_pid: Option<u32>,
    pub tunnel_pid: Option<u32>,
    pub http_port: Option<u16>,
    pub socks_port: Option<u16>,
    pub system_proxy_enabled: bool,
    pub tunnel_active: bool,
    pub tunnel_interface_name: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    pub share_id: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub listen_host: String,
    pub listen_port: u16,
    pub addresses: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLogTail {
    pub share_id: String,
    pub tail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub platform: PlatformInfo,
    pub selected_profile_id: Option<String>,
    pub connection_mode: ConnectionMode,
    pub profiles: Vec<ClientProfile>,
    pub shares: Vec<SharedProxy>,
    pub connection: ConnectionStatus,
    pub share_statuses: Vec<ShareStatus>,
    pub helper_log_tail: String,
    pub tunnel_log_tail: String,
    pub share_log_tails: Vec<ShareLogTail>,
    pub logs_dir: String,
    pub config_dir: String,
}

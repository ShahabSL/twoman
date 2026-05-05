#[cfg(windows)]
use serde::{Deserialize, Serialize};

use crate::storage::AppPaths;

#[cfg(windows)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemProxyBackup {
    proxy_enable: Option<u32>,
    proxy_server: Option<String>,
    proxy_override: Option<String>,
    auto_config_url: Option<String>,
    auto_detect: Option<u32>,
}

pub struct SystemProxyManager;

impl SystemProxyManager {
    pub fn enable(paths: &AppPaths, http_port: u16) -> Result<(), String> {
        if !cfg!(windows) {
            return Ok(());
        }
        windows_impl::enable(paths, http_port)
    }

    pub fn disable(paths: &AppPaths) -> Result<(), String> {
        if !cfg!(windows) {
            return Ok(());
        }
        windows_impl::disable(paths)
    }

    pub fn cleanup_stale_proxy(paths: &AppPaths) -> Result<(), String> {
        if !cfg!(windows) {
            return Ok(());
        }
        windows_impl::cleanup_stale_proxy(paths)
    }
}

#[cfg(windows)]
fn backup_path(paths: &AppPaths) -> std::path::PathBuf {
    paths.runtime_dir.join("system-proxy-backup.json")
}

#[cfg(windows)]
mod windows_impl {
    use std::{fs, path::Path};

    use windows_sys::Win32::Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    };
    use winreg::{enums::*, RegKey};

    use super::{backup_path, AppPaths, SystemProxyBackup};

    const INTERNET_SETTINGS_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    pub fn enable(paths: &AppPaths, http_port: u16) -> Result<(), String> {
        if !backup_path(paths).exists() {
            let snapshot = read_snapshot()?;
            write_backup(paths, &snapshot)?;
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(INTERNET_SETTINGS_KEY)
            .map_err(|error| format!("failed to open internet settings: {error}"))?;
        key.set_value("ProxyEnable", &1u32)
            .map_err(|error| format!("failed to enable proxy: {error}"))?;
        key.set_value(
            "ProxyServer",
            &format!("http=127.0.0.1:{http_port};https=127.0.0.1:{http_port}"),
        )
        .map_err(|error| format!("failed to write proxy server: {error}"))?;
        refresh();
        Ok(())
    }

    pub fn disable(paths: &AppPaths) -> Result<(), String> {
        let backup = read_backup(paths)?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(INTERNET_SETTINGS_KEY)
            .map_err(|error| format!("failed to open internet settings: {error}"))?;

        if let Some(snapshot) = backup {
            write_or_delete_u32(&key, "ProxyEnable", snapshot.proxy_enable)?;
            write_or_delete_string(&key, "ProxyServer", snapshot.proxy_server)?;
            write_or_delete_string(&key, "ProxyOverride", snapshot.proxy_override)?;
            write_or_delete_string(&key, "AutoConfigURL", snapshot.auto_config_url)?;
            write_or_delete_u32(&key, "AutoDetect", snapshot.auto_detect)?;
            let _ = fs::remove_file(backup_path(paths));
        } else {
            write_or_delete_u32(&key, "ProxyEnable", Some(0))?;
            write_or_delete_string(&key, "ProxyServer", None)?;
        }
        refresh();
        Ok(())
    }

    pub fn cleanup_stale_proxy(paths: &AppPaths) -> Result<(), String> {
        if backup_path(paths).exists() {
            disable(paths)?;
        }
        Ok(())
    }

    fn read_snapshot() -> Result<SystemProxyBackup, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey(INTERNET_SETTINGS_KEY)
            .map_err(|error| format!("failed to read internet settings: {error}"))?;
        Ok(SystemProxyBackup {
            proxy_enable: key.get_value("ProxyEnable").ok(),
            proxy_server: key.get_value("ProxyServer").ok(),
            proxy_override: key.get_value("ProxyOverride").ok(),
            auto_config_url: key.get_value("AutoConfigURL").ok(),
            auto_detect: key.get_value("AutoDetect").ok(),
        })
    }

    fn write_backup(paths: &AppPaths, snapshot: &SystemProxyBackup) -> Result<(), String> {
        let content = serde_json::to_string_pretty(snapshot)
            .map_err(|error| format!("failed to serialize proxy backup: {error}"))?;
        fs::write(backup_path(paths), content)
            .map_err(|error| format!("failed to write proxy backup: {error}"))
    }

    fn read_backup(paths: &AppPaths) -> Result<Option<SystemProxyBackup>, String> {
        let path = backup_path(paths);
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path)
            .map_err(|error| format!("failed to read proxy backup: {error}"))?;
        let backup = serde_json::from_str::<SystemProxyBackup>(&content)
            .map_err(|error| format!("failed to parse proxy backup: {error}"))?;
        Ok(Some(backup))
    }

    fn write_or_delete_u32(key: &RegKey, name: &str, value: Option<u32>) -> Result<(), String> {
        match value {
            Some(value) => key
                .set_value(name, &value)
                .map_err(|error| format!("failed to set {name}: {error}")),
            None => delete_value(key, name),
        }
    }

    fn write_or_delete_string(
        key: &RegKey,
        name: &str,
        value: Option<String>,
    ) -> Result<(), String> {
        match value {
            Some(value) => key
                .set_value(name, &value)
                .map_err(|error| format!("failed to set {name}: {error}")),
            None => delete_value(key, name),
        }
    }

    fn delete_value(key: &RegKey, name: &str) -> Result<(), String> {
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("failed to delete {name}: {error}")),
        }
    }

    fn refresh() {
        unsafe {
            let _ = InternetSetOptionW(
                std::ptr::null(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                std::ptr::null_mut(),
                0,
            );
            let _ = InternetSetOptionW(
                std::ptr::null(),
                INTERNET_OPTION_REFRESH,
                std::ptr::null_mut(),
                0,
            );
        }
    }

    #[allow(dead_code)]
    fn _exists(path: &Path) -> bool {
        path.exists()
    }
}

#[cfg(not(windows))]
mod windows_impl {
    use super::AppPaths;

    pub fn enable(_paths: &AppPaths, _http_port: u16) -> Result<(), String> {
        Ok(())
    }

    pub fn disable(_paths: &AppPaths) -> Result<(), String> {
        Ok(())
    }

    pub fn cleanup_stale_proxy(_paths: &AppPaths) -> Result<(), String> {
        Ok(())
    }
}

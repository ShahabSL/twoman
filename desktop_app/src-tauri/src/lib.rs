pub mod models;
pub mod runtime;
pub mod storage;
pub mod system_proxy;

use models::{ClientProfile, ConnectionMode, DesktopSnapshot, SharedProxy};
use runtime::DesktopRuntime;
use std::sync::Arc;
use storage::AppPaths;
use tauri::{Manager, State};

#[tauri::command]
async fn load_snapshot(runtime: State<'_, Arc<DesktopRuntime>>) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.snapshot())
        .await
        .map_err(|error| format!("snapshot task failed: {error}"))?
}

#[tauri::command]
async fn save_profile(
    runtime: State<'_, Arc<DesktopRuntime>>,
    profile: ClientProfile,
) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.save_profile(profile)?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("save_profile task failed: {error}"))?
}

#[tauri::command]
async fn delete_profile(
    runtime: State<'_, Arc<DesktopRuntime>>,
    profile_id: String,
) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.delete_profile(&profile_id)?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("delete_profile task failed: {error}"))?
}

#[tauri::command]
async fn set_selected_profile(
    runtime: State<'_, Arc<DesktopRuntime>>,
    profile_id: Option<String>,
) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.set_selected_profile(profile_id)?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("set_selected_profile task failed: {error}"))?
}

#[tauri::command]
async fn save_share(
    runtime: State<'_, Arc<DesktopRuntime>>,
    share: SharedProxy,
) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.save_share(share)?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("save_share task failed: {error}"))?
}

#[tauri::command]
async fn delete_share(
    runtime: State<'_, Arc<DesktopRuntime>>,
    share_id: String,
) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.delete_share(&share_id)?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("delete_share task failed: {error}"))?
}

#[tauri::command]
async fn set_connection_mode(
    runtime: State<'_, Arc<DesktopRuntime>>,
    mode: ConnectionMode,
) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.set_mode(mode)?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("set_connection_mode task failed: {error}"))?
}

#[tauri::command]
async fn connect(runtime: State<'_, Arc<DesktopRuntime>>) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.connect()?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("connect task failed: {error}"))?
}

#[tauri::command]
async fn disconnect(runtime: State<'_, Arc<DesktopRuntime>>) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.disconnect()?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("disconnect task failed: {error}"))?
}

#[tauri::command]
async fn start_share(
    runtime: State<'_, Arc<DesktopRuntime>>,
    share_id: String,
) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.start_share(&share_id)?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("start_share task failed: {error}"))?
}

#[tauri::command]
async fn stop_share(
    runtime: State<'_, Arc<DesktopRuntime>>,
    share_id: String,
) -> Result<DesktopSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.stop_share(&share_id)?;
        runtime.snapshot()
    })
    .await
    .map_err(|error| format!("stop_share task failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let paths = AppPaths::resolve(&app.handle())?;
            let runtime = Arc::new(DesktopRuntime::new(paths, app.path().resource_dir().ok()));
            app.manage(runtime);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_snapshot,
            save_profile,
            delete_profile,
            set_selected_profile,
            save_share,
            delete_share,
            set_connection_mode,
            connect,
            disconnect,
            start_share,
            stop_share
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

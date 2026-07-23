use std::{
    io::Write,
    process::{Command, Output, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(not(windows))]
use std::path::{Path, PathBuf};

use crate::models::{
    DeploymentHiddenTarget, DeploymentMonitorRequest, DeploymentMonitorSnapshot, DeploymentRequest,
    DeploymentResult, DeploymentRollbackRequest,
};

const INSTALLER_BOOTSTRAP_COMMAND: &str = concat!(
    "if ! command -v curl >/dev/null 2>&1; then ",
    "if command -v apt-get >/dev/null 2>&1; then ",
    "apt-get update || printf '%s\\n' 'Warning: apt metadata refresh failed; using cached metadata.' >&2; ",
    "DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl; ",
    "else printf '%s\\n' 'curl is required to download the Twoman installer.' >&2; exit 1; fi; fi; ",
    "curl -fsSL --proto '=https' --tlsv1.2 ",
    "https://raw.githubusercontent.com/ShahabSL/twoman/main/scripts/install_twoman.sh ",
    "| bash -s -- \"$@\"",
);

pub fn run_deployment(request: DeploymentRequest) -> Result<DeploymentResult, String> {
    let started_at = timestamp();
    validate_deploy_request(&request)?;

    let mut args = Vec::new();
    push_pair(&mut args, "--version", &request.release_version);
    push_pair(&mut args, "--ref", &request.repo_ref);
    push_pair(&mut args, "--site-name", &request.site_name);
    args.push("--non-interactive".to_string());
    push_pair(
        &mut args,
        "--instance",
        normalized_default(&request.instance_name, "default"),
    );
    push_pair(
        &mut args,
        "--control-root",
        normalized_default(&request.control_root, "/opt/twoman/control"),
    );
    push_pair(&mut args, "--install-root", &request.install_root);
    push_pair(
        &mut args,
        "--public-origin",
        normalize_origin(&request.public_origin),
    );
    push_pair(&mut args, "--cpanel-base-url", &request.cpanel_base_url);
    push_pair(&mut args, "--cpanel-username", &request.cpanel_username);
    push_pair(&mut args, "--cpanel-password", &request.cpanel_password);
    push_pair(&mut args, "--cpanel-home", &request.cpanel_home);
    push_pair(&mut args, "--cpanel-proxy-url", &request.cpanel_proxy_url);
    push_pair(&mut args, "--public-proxy-url", &request.public_proxy_url);
    if let Some(backend) = request.backend.cli_value() {
        push_pair(&mut args, "--backend", backend);
    }
    if request.hidden_target == DeploymentHiddenTarget::Remote {
        push_pair(&mut args, "--server-host", &request.server_host);
        push_pair(&mut args, "--server-port", request.server_port.to_string());
        push_pair(&mut args, "--server-user", &request.server_user);
        push_pair(&mut args, "--server-password", &request.server_password);
        push_pair(&mut args, "--server-ssh-key", &request.server_ssh_key);
    }
    push_pair(&mut args, "--public-base-path", &request.public_base_path);
    push_pair(
        &mut args,
        "--bridge-public-base-path",
        &request.bridge_public_base_path,
    );
    push_pair(
        &mut args,
        "--passenger-app-name",
        &request.passenger_app_name,
    );
    push_pair(
        &mut args,
        "--passenger-app-root",
        &request.passenger_app_root,
    );
    push_pair(&mut args, "--node-app-root", &request.node_app_root);
    push_pair(&mut args, "--node-app-uri", &request.node_app_uri);
    push_pair(&mut args, "--admin-script-name", &request.admin_script_name);
    push_pair(
        &mut args,
        "--hidden-service-name",
        &request.hidden_service_name,
    );
    push_pair(
        &mut args,
        "--hidden-service-user",
        &request.hidden_service_user,
    );
    push_pair(
        &mut args,
        "--hidden-service-group",
        &request.hidden_service_group,
    );
    push_pair(
        &mut args,
        "--watchdog-service-name",
        &request.watchdog_service_name,
    );
    push_pair(
        &mut args,
        "--watchdog-timer-name",
        &request.watchdog_timer_name,
    );
    push_pair(
        &mut args,
        "--hidden-upstream-proxy-url",
        &request.hidden_upstream_proxy_url,
    );
    push_pair(
        &mut args,
        "--hidden-upstream-proxy-label",
        &request.hidden_upstream_proxy_label,
    );
    push_pair(
        &mut args,
        "--hidden-outbound-proxy-url",
        &request.hidden_outbound_proxy_url,
    );
    push_pair(
        &mut args,
        "--hidden-outbound-proxy-label",
        &request.hidden_outbound_proxy_label,
    );
    match request.verify_tls {
        Some(true) => args.push("--verify-tls".to_string()),
        Some(false) => args.push("--no-verify-tls".to_string()),
        None => {}
    }
    if request.skip_helper_probe {
        args.push("--skip-helper-probe".to_string());
    }

    let command_label = "install_twoman.sh --non-interactive".to_string();
    let output = run_installer(&args, &request.sudo_password)?;
    let finished_at = timestamp();
    Ok(result_from_output(
        output,
        command_label,
        started_at,
        finished_at,
        "deployment complete",
        "deployment failed",
    ))
}

pub fn rollback_deployment(request: DeploymentRollbackRequest) -> Result<DeploymentResult, String> {
    if !request.purge_host && !request.purge_hidden {
        return Err("select host, hidden server, or both for rollback".into());
    }

    let started_at = timestamp();
    let launcher = normalized_default(&request.launcher_path, "/usr/local/bin/twoman-server");
    let instance = normalized_default(&request.instance_name, "default");
    let mut args = vec![
        "purge".to_string(),
        "--instance".to_string(),
        instance.to_string(),
    ];
    if !request.purge_host {
        args.push("--hidden-only".to_string());
    }
    if !request.purge_hidden {
        args.push("--host-only".to_string());
    }
    if request.keep_state {
        args.push("--keep-state".to_string());
    }

    let command_env = control_root_env(&request.control_root);
    let (mut command, uses_sudo) =
        privileged_program_command(launcher, &request.sudo_password, &command_env)?;
    command.args(&args);
    let output = run_with_optional_stdin(command, sudo_input(&request.sudo_password, uses_sudo))?;
    let finished_at = timestamp();
    Ok(result_from_output(
        output,
        "twoman-server purge".to_string(),
        started_at,
        finished_at,
        "rollback complete",
        "rollback failed",
    ))
}

pub fn load_deployment_monitor(
    request: DeploymentMonitorRequest,
) -> Result<DeploymentMonitorSnapshot, String> {
    let launcher = normalized_default(&request.launcher_path, "/usr/local/bin/twoman-server");
    let instance = normalized_default(&request.instance_name, "default").to_string();
    let status = run_server_control(
        launcher,
        &request.sudo_password,
        &request.control_root,
        &instance,
        "status",
    )?;
    let config = run_server_control(
        launcher,
        &request.sudo_password,
        &request.control_root,
        &instance,
        "config",
    )?;
    let logs = if request.include_logs {
        run_server_control(
            launcher,
            &request.sudo_password,
            &request.control_root,
            &instance,
            "logs",
        )?
    } else {
        OutputText {
            status_success: true,
            stdout: String::new(),
            stderr: String::new(),
        }
    };
    let status_output = command_output_text(status.clone());
    let logs_output = command_output_text(logs);
    let profile_share_text = extract_profile_share_text(&command_output_text(config));
    let ok = status.status_success;
    Ok(DeploymentMonitorSnapshot {
        ok,
        summary: if ok {
            "healthy".to_string()
        } else {
            "needs attention".to_string()
        },
        status_output,
        logs_output,
        profile_share_text,
        command_label: "twoman-server status".to_string(),
        checked_at: timestamp(),
    })
}

fn validate_deploy_request(request: &DeploymentRequest) -> Result<(), String> {
    let mut missing = Vec::new();
    if request.public_origin.trim().is_empty() {
        missing.push("public origin");
    }
    if request.cpanel_username.trim().is_empty() {
        missing.push("cPanel username");
    }
    if request.cpanel_password.trim().is_empty() {
        missing.push("cPanel password");
    }
    if request.hidden_target == DeploymentHiddenTarget::Remote {
        if request.server_host.trim().is_empty() {
            missing.push("hidden server host");
        }
        if request.server_user.trim().is_empty() {
            missing.push("hidden server user");
        }
    }
    if sudo_password_required()? && request.sudo_password.trim().is_empty() {
        missing.push("local sudo password");
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!("missing required values: {}", missing.join(", ")))
}

#[derive(Clone)]
struct OutputText {
    status_success: bool,
    stdout: String,
    stderr: String,
}

fn run_server_control(
    launcher: &str,
    sudo_password: &str,
    control_root: &str,
    instance: &str,
    command_name: &str,
) -> Result<OutputText, String> {
    let command_env = control_root_env(control_root);
    let (mut command, uses_sudo) =
        privileged_program_command(launcher, sudo_password, &command_env)?;
    command.args([command_name, "--instance", instance]);
    let output = run_with_optional_stdin(command, sudo_input(sudo_password, uses_sudo))?;
    Ok(OutputText {
        status_success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

#[cfg(not(windows))]
fn run_privileged_bash(
    script_path: &Path,
    args: &[String],
    cwd: &Path,
    sudo_password: &str,
) -> Result<Output, String> {
    let (mut command, uses_sudo) = privileged_bash_command(sudo_password)?;
    command.arg(script_path);
    command.args(args);
    command.current_dir(cwd);
    run_with_optional_stdin(command, sudo_input(sudo_password, uses_sudo))
}

fn run_installer(args: &[String], sudo_password: &str) -> Result<Output, String> {
    #[cfg(not(windows))]
    if let Some(repo_root) = resolve_repo_root() {
        let script_path = repo_root.join("scripts").join("install_twoman.sh");
        return run_privileged_bash(&script_path, args, &repo_root, sudo_password);
    }

    let (mut command, uses_sudo) = privileged_bash_command(sudo_password)?;
    command.args(["-c", INSTALLER_BOOTSTRAP_COMMAND, "twoman-installer"]);
    command.args(args);
    run_with_optional_stdin(command, sudo_input(sudo_password, uses_sudo))
}

fn privileged_bash_command(sudo_password: &str) -> Result<(Command, bool), String> {
    let uses_sudo = needs_sudo()?;
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("wsl.exe");
        command.arg("--exec");
        command
    };
    #[cfg(not(windows))]
    let mut command = Command::new(if uses_sudo { "sudo" } else { "bash" });

    if uses_sudo {
        if sudo_password.trim().is_empty() && !sudo_without_password() {
            return Err("local sudo password is required".into());
        }
        #[cfg(windows)]
        command.arg("sudo");
        command.args(["-S", "-E", "bash"]);
    }
    #[cfg(windows)]
    if !uses_sudo {
        command.arg("bash");
    }
    Ok((command, uses_sudo))
}

fn privileged_program_command(
    program: &str,
    sudo_password: &str,
    command_env: &[(String, String)],
) -> Result<(Command, bool), String> {
    let uses_sudo = needs_sudo()?;
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("wsl.exe");
        command.arg("--exec");
        command
    };
    #[cfg(not(windows))]
    let mut command = if uses_sudo {
        Command::new("sudo")
    } else if command_env.is_empty() {
        Command::new(program)
    } else {
        Command::new("env")
    };

    if uses_sudo {
        if sudo_password.trim().is_empty() && !sudo_without_password() {
            return Err("local sudo password is required".into());
        }
        #[cfg(windows)]
        command.arg("sudo");
        command.args(["-S", "-E", "env"]);
    } else {
        #[cfg(windows)]
        if !command_env.is_empty() {
            command.arg("env");
        }
    }
    for (name, value) in command_env {
        command.arg(format!("{name}={value}"));
    }
    if uses_sudo || !command_env.is_empty() || cfg!(windows) {
        command.arg(program);
    }
    Ok((command, uses_sudo))
}

fn control_root_env(control_root: &str) -> Vec<(String, String)> {
    let control_root = control_root.trim();
    if control_root.is_empty() {
        return Vec::new();
    }
    vec![("TWOMAN_CONTROL_ROOT".to_string(), control_root.to_string())]
}

fn run_with_optional_stdin(mut command: Command, input: Option<String>) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start command: {error}"))?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(input.as_bytes())
                .map_err(|error| format!("failed to write command input: {error}"))?;
        }
    }
    child
        .wait_with_output()
        .map_err(|error| format!("failed to wait for command: {error}"))
}

fn sudo_input(sudo_password: &str, uses_sudo: bool) -> Option<String> {
    if uses_sudo && !sudo_password.trim().is_empty() {
        return Some(format!("{}\n", sudo_password));
    }
    None
}

fn sudo_password_required() -> Result<bool, String> {
    Ok(needs_sudo()? && !sudo_without_password())
}

fn sudo_without_password() -> bool {
    #[cfg(unix)]
    let result = Command::new("sudo")
        .args(["-n", "true"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(windows)]
    let result = Command::new("wsl.exe")
        .args(["--exec", "sudo", "-n", "true"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(not(any(unix, windows)))]
    return false;

    result.map(|status| status.success()).unwrap_or(false)
}

fn needs_sudo() -> Result<bool, String> {
    #[cfg(unix)]
    {
        let output = Command::new("id")
            .arg("-u")
            .output()
            .map_err(|error| format!("failed to inspect local user: {error}"))?;
        if !output.status.success() {
            return Err("failed to inspect local user id".into());
        }
        return Ok(String::from_utf8_lossy(&output.stdout).trim() != "0");
    }
    #[cfg(windows)]
    {
        let output = Command::new("wsl.exe")
            .args(["--exec", "id", "-u"])
            .output()
            .map_err(|error| {
                format!("Windows deployment requires WSL with a Linux distribution: {error}")
            })?;
        if !output.status.success() {
            let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if details.is_empty() {
                "Windows deployment requires a running WSL Linux distribution".into()
            } else {
                format!("WSL is not ready: {details}")
            });
        }
        return Ok(String::from_utf8_lossy(&output.stdout).trim() != "0");
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err("deployment is supported only on Linux and Windows with WSL".into())
    }
}

#[cfg(not(windows))]
fn resolve_repo_root() -> Option<PathBuf> {
    if let Ok(root) = std::env::var("TWOMAN_REPO_ROOT") {
        let path = PathBuf::from(root);
        if is_repo_root(&path) {
            return Some(path);
        }
    }

    if let Ok(current) = std::env::current_dir() {
        for candidate in current.ancestors() {
            if is_repo_root(candidate) {
                return Some(candidate.to_path_buf());
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        for candidate in exe.ancestors() {
            if is_repo_root(candidate) {
                return Some(candidate.to_path_buf());
            }
        }
    }

    None
}

#[cfg(not(windows))]
fn is_repo_root(path: &Path) -> bool {
    path.join("scripts").join("install_twoman.sh").exists()
        && path.join("twoman_control").join("cli.py").exists()
}

fn command_output_text(output: OutputText) -> String {
    if output.stderr.is_empty() {
        output.stdout
    } else if output.stdout.is_empty() {
        output.stderr
    } else {
        format!("{}\n{}", output.stdout, output.stderr)
    }
}

fn result_from_output(
    output: Output,
    command_label: String,
    started_at: String,
    finished_at: String,
    ok_summary: &str,
    failed_summary: &str,
) -> DeploymentResult {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else if stdout.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        format!("{}\n{}", stdout.trim(), stderr.trim())
    };
    let profile_share_text = extract_profile_share_text(&combined);
    DeploymentResult {
        ok: output.status.success(),
        summary: if output.status.success() {
            ok_summary.to_string()
        } else {
            failed_summary.to_string()
        },
        profile_share_text,
        output: combined,
        command_label,
        started_at,
        finished_at,
    }
}

fn extract_profile_share_text(output: &str) -> String {
    output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with("twoman://profile?data="))
        .unwrap_or("")
        .to_string()
}

fn push_pair(args: &mut Vec<String>, name: &str, value: impl AsRef<str>) {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return;
    }
    args.push(name.to_string());
    args.push(value.to_string());
}

fn normalized_default<'a>(value: &'a str, default_value: &'a str) -> &'a str {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        default_value
    } else {
        trimmed
    }
}

fn normalize_origin(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    format!("https://{trimmed}")
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        control_root_env, extract_profile_share_text, normalize_origin, normalized_default,
        push_pair, sudo_input, INSTALLER_BOOTSTRAP_COMMAND,
    };

    #[test]
    fn bootstrap_installs_curl_before_downloading_release() {
        assert!(INSTALLER_BOOTSTRAP_COMMAND.contains("apt-get install -y ca-certificates curl"));
        assert!(INSTALLER_BOOTSTRAP_COMMAND.contains("curl -fsSL --proto '=https' --tlsv1.2"));
    }

    #[test]
    fn profile_extraction_uses_last_share_text() {
        let output = concat!(
            "twoman://profile?data=old\n",
            "deployment log\n",
            "twoman://profile?data=current\n",
        );
        assert_eq!(
            extract_profile_share_text(output),
            "twoman://profile?data=current"
        );
    }

    #[test]
    fn argument_helpers_trim_values_and_preserve_defaults() {
        let mut args = Vec::new();
        push_pair(&mut args, "--empty", "  ");
        push_pair(&mut args, "--name", "  instance-a  ");
        assert_eq!(args, ["--name", "instance-a"]);
        assert_eq!(normalized_default("  ", "default"), "default");
        assert_eq!(sudo_input("", true), None);
        assert_eq!(sudo_input("secret", true), Some("secret\n".to_string()));
        assert_eq!(
            normalize_origin("host.example.com/"),
            "https://host.example.com"
        );
        assert_eq!(
            control_root_env(" /srv/twoman/control "),
            [(
                "TWOMAN_CONTROL_ROOT".to_string(),
                "/srv/twoman/control".to_string()
            )]
        );
    }
}

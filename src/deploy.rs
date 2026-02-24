//! Deploy system with 3 tracks:
//! - Track 1: Supervisor (instant) - add/remove services + Caddy routes
//! - Track 2: App (~60s) - rebuild feather binary + static from source
//! - Track 3: Container (~2-5min, admin only) - host podman build + redeploy

use axum::{
    extract::State,
    response::{
        sse::{Event, KeepAlive, Sse},
        Json,
    },
};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use std::{
    convert::Infallible,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::broadcast;

use crate::AppState;

// ============================================================================
// Types
// ============================================================================

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum DeployEvent {
    #[serde(rename = "output")]
    Output { track: String, line: String },
    #[serde(rename = "progress")]
    Progress { track: String, stage: String, pct: Option<u8> },
    #[serde(rename = "complete")]
    Complete { track: String, success: bool, message: String },
}

/// Check if this container has admin access (host tmux socket exists)
pub fn is_admin() -> bool {
    Path::new("/host-tmux/default").exists()
}

// ============================================================================
// Status endpoint
// ============================================================================

#[derive(Serialize)]
pub struct ServiceInfo {
    name: String,
    status: String,
    pid: Option<String>,
    uptime: Option<String>,
}

#[derive(Serialize)]
pub struct DeployStatus {
    is_admin: bool,
    version: String,
    services: Vec<ServiceInfo>,
    has_app_backup: bool,
    has_supervisor_backup: bool,
}

pub async fn deploy_status(State(_state): State<Arc<AppState>>) -> Json<DeployStatus> {
    let services = parse_supervisorctl_status();
    let version = read_current_version();
    let has_app_backup = {
        let feather_bin = PathBuf::from("/usr/local/bin/feather");
        if feather_bin.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            // Check for .prev next to the symlink target
            let real_path = fs::read_link(&feather_bin).unwrap_or(feather_bin.clone());
            let resolved = if real_path.is_absolute() { real_path } else { feather_bin.parent().unwrap().join(&real_path) };
            resolved.with_extension("prev").exists()
        } else {
            Path::new("/usr/local/bin/feather.prev").exists()
        }
    };
    let has_supervisor_backup = Path::new(&format!("{}.prev", SUPERVISOR_CONF)).exists();

    Json(DeployStatus {
        is_admin: is_admin(),
        version,
        services,
        has_app_backup,
        has_supervisor_backup,
    })
}

fn parse_supervisorctl_status() -> Vec<ServiceInfo> {
    // Parse services directly from the supervisor config file
    // (supervisorctl requires a unix socket which may not be configured)
    let conf = fs::read_to_string(SUPERVISOR_CONF).unwrap_or_default();
    let mut services = Vec::new();

    for line in conf.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[program:") && trimmed.ends_with(']') {
            let name = trimmed
                .strip_prefix("[program:")
                .unwrap_or("")
                .strip_suffix(']')
                .unwrap_or("")
                .to_string();

            if name.is_empty() {
                continue;
            }

            // Check if the process is actually running by looking for it
            let pid = find_process_pid(&name);
            let status = if pid.is_some() {
                "RUNNING".to_string()
            } else {
                "STOPPED".to_string()
            };

            services.push(ServiceInfo {
                name,
                status,
                pid: pid.map(|p| p.to_string()),
                uptime: None,
            });
        }
    }

    services
}

/// Find the PID of a supervised process by name
fn find_process_pid(service_name: &str) -> Option<u32> {
    // Read the config to find the command for this service
    let conf = fs::read_to_string(SUPERVISOR_CONF).unwrap_or_default();
    let section = format!("[program:{}]", service_name);
    let mut in_section = false;
    let mut command = None;

    for line in conf.lines() {
        let trimmed = line.trim();
        if trimmed == section {
            in_section = true;
            continue;
        }
        if in_section && trimmed.starts_with('[') {
            break;
        }
        if in_section && trimmed.starts_with("command=") {
            command = Some(trimmed.strip_prefix("command=").unwrap_or("").to_string());
            break;
        }
    }

    let cmd = command?;

    // Use pgrep to find the process
    let output = std::process::Command::new("pgrep")
        .args(&["-f", &cmd])
        .output()
        .ok()?;

    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .next()
        .and_then(|line| line.trim().parse::<u32>().ok())
}

fn read_current_version() -> String {
    // Read version from the static/index.html version stamp
    let paths = [
        "/opt/feather/static/index.html",
        "static/index.html",
    ];
    for path in &paths {
        if let Ok(content) = fs::read_to_string(path) {
            // Look for: <p class="text-xs text-smoke-9 ml-7">VERSION</p>
            if let Some(start) = content.find("text-smoke-9 ml-7\">") {
                let after = &content[start + 19..];
                if let Some(end) = after.find("</p>") {
                    return after[..end].to_string();
                }
            }
        }
    }
    env!("CARGO_PKG_VERSION").to_string()
}

// ============================================================================
// SSE deploy stream
// ============================================================================

pub async fn deploy_stream(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.deploy_tx.subscribe();

    let stream = futures::stream::unfold(rx, |mut rx| async move {
        match rx.recv().await {
            Ok(event) => {
                let track = match &event {
                    DeployEvent::Output { track, .. } => track.clone(),
                    DeployEvent::Progress { track, .. } => track.clone(),
                    DeployEvent::Complete { track, .. } => track.clone(),
                };
                let data = serde_json::to_string(&event).unwrap_or_default();
                Some((
                    Ok(Event::default().event(format!("deploy-{}", track)).data(data)),
                    rx,
                ))
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!("Deploy SSE lagged {} events", n);
                // Continue receiving
                let data = serde_json::to_string(&DeployEvent::Output {
                    track: "system".to_string(),
                    line: format!("(skipped {} events)", n),
                })
                .unwrap_or_default();
                Some((
                    Ok(Event::default().event("deploy-system").data(data)),
                    rx,
                ))
            }
            Err(broadcast::error::RecvError::Closed) => None,
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ============================================================================
// Track 1: Supervisor service management
// ============================================================================

#[derive(Deserialize)]
pub struct SupervisorRequest {
    action: String, // "add" or "remove"
    name: String,
    command: Option<String>,
    port: Option<u16>,
    caddy_route: Option<String>, // optional path prefix for Caddy reverse proxy
}

#[derive(Serialize)]
pub struct SupervisorResponse {
    status: String,
    message: String,
}

const SUPERVISOR_CONF: &str = "/etc/supervisor/conf.d/supervisord.conf";
const CADDYFILE: &str = "/etc/caddy/Caddyfile";

pub async fn supervisor_deploy(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SupervisorRequest>,
) -> Json<SupervisorResponse> {
    let tx = state.deploy_tx.clone();
    let track = "supervisor".to_string();

    let send = |line: &str| {
        let _ = tx.send(DeployEvent::Output {
            track: track.clone(),
            line: line.to_string(),
        });
    };

    match req.action.as_str() {
        "add" => {
            let command = match req.command {
                Some(cmd) => cmd,
                None => {
                    return Json(SupervisorResponse {
                        status: "error".to_string(),
                        message: "command is required for add action".to_string(),
                    });
                }
            };

            send(&format!("Adding service: {}", req.name));

            // Back up existing config
            backup_file(SUPERVISOR_CONF);

            // Read or create supervisor config
            let mut conf = fs::read_to_string(SUPERVISOR_CONF).unwrap_or_default();

            // Check if program already exists
            let section = format!("[program:{}]", req.name);
            if conf.contains(&section) {
                return Json(SupervisorResponse {
                    status: "error".to_string(),
                    message: format!("Service '{}' already exists", req.name),
                });
            }

            // Build program block
            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
            let block = format!(
                "\n[program:{}]\ncommand={}\nautostart=true\nautorestart=true\nstdout_logfile={}/logs/{}.log\nstderr_logfile={}/logs/{}.err.log\nstdout_logfile_maxbytes=10MB\nstderr_logfile_maxbytes=10MB\n",
                req.name, command, home, req.name, home, req.name
            );

            // Ensure log directory exists
            let log_dir = PathBuf::from(&home).join("logs");
            let _ = fs::create_dir_all(&log_dir);

            conf.push_str(&block);
            if let Err(e) = fs::write(SUPERVISOR_CONF, &conf) {
                send(&format!("Error writing config: {}", e));
                return Json(SupervisorResponse {
                    status: "error".to_string(),
                    message: format!("Failed to write config: {}", e),
                });
            }

            // Optionally add Caddy route
            if let Some(route_path) = req.caddy_route {
                if let Some(port) = req.port {
                    send(&format!("Adding Caddy route: {} -> :{}", route_path, port));
                    add_caddy_route(&route_path, port, &tx, &track);
                }
            }

            let msg = format!("Service '{}' added and started", req.name);
            let response = Json(SupervisorResponse {
                status: "ok".to_string(),
                message: msg.clone(),
            });

            // Spawn SIGHUP in background AFTER returning response
            // (SIGHUP restarts feather, so we must send response first)
            let tx2 = tx.clone();
            let track2 = track.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                reload_supervisor(&tx2, &track2);
                let _ = tx2.send(DeployEvent::Complete {
                    track: track2,
                    success: true,
                    message: msg,
                });
            });

            response
        }
        "remove" => {
            send(&format!("Removing service: {}", req.name));

            // Back up existing config
            backup_file(SUPERVISOR_CONF);

            let conf = fs::read_to_string(SUPERVISOR_CONF).unwrap_or_default();
            let section = format!("[program:{}]", req.name);

            if !conf.contains(&section) {
                return Json(SupervisorResponse {
                    status: "error".to_string(),
                    message: format!("Service '{}' not found", req.name),
                });
            }

            // Remove the program block
            let new_conf = remove_program_block(&conf, &req.name);
            if let Err(e) = fs::write(SUPERVISOR_CONF, &new_conf) {
                send(&format!("Error writing config: {}", e));
                return Json(SupervisorResponse {
                    status: "error".to_string(),
                    message: format!("Failed to write config: {}", e),
                });
            }

            // Optionally remove Caddy route
            if let Some(route_path) = req.caddy_route {
                send(&format!("Removing Caddy route: {}", route_path));
                remove_caddy_route(&route_path, &tx, &track);
            }

            let msg = format!("Service '{}' removed", req.name);
            let response = Json(SupervisorResponse {
                status: "ok".to_string(),
                message: msg.clone(),
            });

            // Spawn SIGHUP in background AFTER returning response
            let tx2 = tx.clone();
            let track2 = track.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                reload_supervisor(&tx2, &track2);
                let _ = tx2.send(DeployEvent::Complete {
                    track: track2,
                    success: true,
                    message: msg,
                });
            });

            response
        }
        _ => Json(SupervisorResponse {
            status: "error".to_string(),
            message: format!("Unknown action: {}", req.action),
        }),
    }
}

pub async fn supervisor_rollback(
    State(state): State<Arc<AppState>>,
) -> Json<SupervisorResponse> {
    let tx = state.deploy_tx.clone();
    let track = "supervisor".to_string();

    let send = |line: &str| {
        let _ = tx.send(DeployEvent::Output {
            track: track.clone(),
            line: line.to_string(),
        });
    };

    send("Rolling back supervisor config...");

    // Restore supervisor config
    let prev = format!("{}.prev", SUPERVISOR_CONF);
    let need_reload = if Path::new(&prev).exists() {
        if let Err(e) = fs::copy(&prev, SUPERVISOR_CONF) {
            let msg = format!("Failed to restore supervisor config: {}", e);
            send(&msg);
            let _ = tx.send(DeployEvent::Complete {
                track, success: false, message: msg.clone(),
            });
            return Json(SupervisorResponse {
                status: "error".to_string(),
                message: msg,
            });
        }
        send("Restored supervisor config from backup");
        true
    } else {
        send("No supervisor backup found");
        false
    };

    // Restore Caddyfile
    let caddy_prev = format!("{}.prev", CADDYFILE);
    if Path::new(&caddy_prev).exists() {
        if let Err(e) = fs::copy(&caddy_prev, CADDYFILE) {
            send(&format!("Failed to restore Caddyfile: {}", e));
        } else {
            send("Restored Caddyfile from backup");
            run_command_with_output("caddy", &["reload", "--config", CADDYFILE], &tx, &track);
        }
    }

    let response = Json(SupervisorResponse {
        status: "ok".to_string(),
        message: "Rollback complete".to_string(),
    });

    // Spawn SIGHUP in background after returning response
    if need_reload {
        let tx2 = tx.clone();
        let track2 = track.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            reload_supervisor(&tx2, &track2);
            let _ = tx2.send(DeployEvent::Complete {
                track: track2,
                success: true,
                message: "Supervisor rollback complete".to_string(),
            });
        });
    } else {
        let _ = tx.send(DeployEvent::Complete {
            track,
            success: true,
            message: "Supervisor rollback complete".to_string(),
        });
    }

    response
}

fn remove_program_block(conf: &str, name: &str) -> String {
    let section = format!("[program:{}]", name);
    let mut result = String::new();
    let mut skip = false;

    for line in conf.lines() {
        if line.starts_with(&section) {
            skip = true;
            continue;
        }
        if skip && line.starts_with('[') {
            skip = false;
        }
        if !skip {
            result.push_str(line);
            result.push('\n');
        }
    }

    // Trim trailing newlines but keep one
    let trimmed = result.trim_end().to_string();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{}\n", trimmed)
    }
}

/// Reload supervisord by sending SIGHUP to PID 1
/// This causes supervisord to re-read its config and start/stop programs as needed
fn reload_supervisor(tx: &broadcast::Sender<DeployEvent>, track: &str) {
    // SIGHUP to supervisord (PID 1) causes it to re-read config
    run_command_with_output("kill", &["-HUP", "1"], tx, track);
    // Give supervisor a moment to process the signal
    std::thread::sleep(std::time::Duration::from_secs(1));

    let _ = tx.send(DeployEvent::Output {
        track: track.to_string(),
        line: "Supervisor config reloaded".to_string(),
    });
}

fn backup_file(path: &str) {
    let prev = format!("{}.prev", path);
    if Path::new(path).exists() {
        let _ = fs::copy(path, &prev);
    }
}

fn add_caddy_route(route_path: &str, port: u16, tx: &broadcast::Sender<DeployEvent>, track: &str) {
    backup_file(CADDYFILE);

    let mut caddy = fs::read_to_string(CADDYFILE).unwrap_or_default();

    // Add reverse_proxy route block before the closing brace
    let route_block = format!(
        "\n\thandle_path /{}/* {{\n\t\treverse_proxy localhost:{}\n\t}}\n",
        route_path.trim_start_matches('/'), port
    );

    // Insert before the last closing brace
    if let Some(pos) = caddy.rfind('}') {
        caddy.insert_str(pos, &route_block);
    } else {
        caddy.push_str(&route_block);
    }

    if let Err(e) = fs::write(CADDYFILE, &caddy) {
        let _ = tx.send(DeployEvent::Output {
            track: track.to_string(),
            line: format!("Error writing Caddyfile: {}", e),
        });
        return;
    }

    run_command_with_output("caddy", &["reload", "--config", CADDYFILE], tx, track);
}

fn remove_caddy_route(route_path: &str, tx: &broadcast::Sender<DeployEvent>, track: &str) {
    backup_file(CADDYFILE);

    let caddy = fs::read_to_string(CADDYFILE).unwrap_or_default();
    let pattern = route_path.trim_start_matches('/');

    // Remove the handle_path block for this route
    let mut result = String::new();
    let mut skip_depth = 0;
    let mut lines = caddy.lines().peekable();

    while let Some(line) = lines.next() {
        if skip_depth > 0 {
            skip_depth += line.matches('{').count();
            skip_depth -= line.matches('}').count();
            continue;
        }

        if line.contains("handle_path") && line.contains(&format!("/{}/*", pattern)) {
            skip_depth = line.matches('{').count();
            skip_depth -= line.matches('}').count();
            continue;
        }

        result.push_str(line);
        result.push('\n');
    }

    if let Err(e) = fs::write(CADDYFILE, &result) {
        let _ = tx.send(DeployEvent::Output {
            track: track.to_string(),
            line: format!("Error writing Caddyfile: {}", e),
        });
        return;
    }

    run_command_with_output("caddy", &["reload", "--config", CADDYFILE], tx, track);
}

fn run_command_with_output(
    cmd: &str,
    args: &[&str],
    tx: &broadcast::Sender<DeployEvent>,
    track: &str,
) {
    let output = std::process::Command::new(cmd).args(args).output();
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            for line in stdout.lines().chain(stderr.lines()) {
                let _ = tx.send(DeployEvent::Output {
                    track: track.to_string(),
                    line: line.to_string(),
                });
            }
        }
        Err(e) => {
            let _ = tx.send(DeployEvent::Output {
                track: track.to_string(),
                line: format!("Error running {} {:?}: {}", cmd, args, e),
            });
        }
    }
}

// ============================================================================
// Track 2: App deploy (rebuild feather from source)
// ============================================================================

#[derive(Serialize)]
pub struct AppDeployResponse {
    status: String,
    message: String,
}

pub async fn app_deploy(
    State(state): State<Arc<AppState>>,
) -> Json<AppDeployResponse> {
    let tx = state.deploy_tx.clone();

    // Spawn background task — returns immediately
    tokio::spawn(async move {
        do_app_deploy(tx).await;
    });

    Json(AppDeployResponse {
        status: "started".to_string(),
        message: "App build started in background".to_string(),
    })
}

async fn do_app_deploy(tx: broadcast::Sender<DeployEvent>) {
    let track = "app".to_string();

    let send = |line: &str| {
        let _ = tx.send(DeployEvent::Output {
            track: "app".to_string(),
            line: line.to_string(),
        });
    };

    let progress = |stage: &str, pct: Option<u8>| {
        let _ = tx.send(DeployEvent::Progress {
            track: "app".to_string(),
            stage: stage.to_string(),
            pct,
        });
    };

    // Determine cargo env: admin uses host Rust, others use system Rust
    let (cargo_home, rustup_home, cargo_bin) = if is_admin() {
        (
            "/host-home/.cargo".to_string(),
            "/host-home/.rustup".to_string(),
            "/host-home/.cargo/bin".to_string(),
        )
    } else {
        (
            "/usr/local/cargo".to_string(),
            "/usr/local/rustup".to_string(),
            "/usr/local/cargo/bin".to_string(),
        )
    };

    // 1. Version stamp
    let version = chrono::Local::now().format("%Y%m%d-%H%M").to_string();
    send(&format!("=== Build: {} ===", version));
    progress("Preparing", Some(5));

    // Stamp version in static/index.html
    let source_dir = find_source_dir();
    let index_path = source_dir.join("static/index.html");
    if let Ok(content) = fs::read_to_string(&index_path) {
        let stamped = stamp_version(&content, &version);
        if let Err(e) = fs::write(&index_path, &stamped) {
            send(&format!("Warning: failed to stamp version: {}", e));
        } else {
            send(&format!("Stamped version: {}", version));
        }
    }

    // 2. Back up current binary and static
    progress("Backing up", Some(10));
    send("Backing up current binary and static files...");

    let feather_bin = PathBuf::from("/usr/local/bin/feather");
    let is_symlink = feather_bin.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);

    if is_symlink {
        // Binary is a symlink to the build target (e.g., -> target/release/feather-rs)
        // Back up the actual binary, not the symlink
        let real_path = fs::read_link(&feather_bin).unwrap_or(feather_bin.clone());
        let resolved = if real_path.is_absolute() { real_path.clone() } else { feather_bin.parent().unwrap().join(&real_path) };
        if resolved.exists() {
            let prev = resolved.with_extension("prev");
            let _ = fs::copy(&resolved, &prev);
            send(&format!("Backed up {} -> {}", resolved.display(), prev.display()));
        }
    } else if feather_bin.exists() {
        let _ = fs::copy(&feather_bin, "/usr/local/bin/feather.prev");
        send("Backed up /usr/local/bin/feather -> feather.prev");
    }

    // Only back up static if /opt/feather/static is a real directory (not a symlink to source)
    let static_dir = PathBuf::from("/opt/feather/static");
    let static_is_symlink = PathBuf::from("/opt/feather").symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);
    if !static_is_symlink && static_dir.exists() {
        let _ = fs::remove_dir_all("/opt/feather/static.prev");
        let _ = std::process::Command::new("cp")
            .args(&["-a", "/opt/feather/static", "/opt/feather/static.prev"])
            .output();
        send("Backed up /opt/feather/static -> static.prev");
    } else if static_is_symlink {
        send("Static files served from source tree (symlink), no separate backup needed");
    }

    // 3. Cargo build
    progress("Building", Some(15));
    send("[1/3] Compiling...");

    let current_path = std::env::var("PATH").unwrap_or_default();
    let build_path = format!("{}:{}", cargo_bin, current_path);

    let mut child = match tokio::process::Command::new("cargo")
        .arg("build")
        .arg("--release")
        .current_dir(&source_dir)
        .env("CARGO_HOME", &cargo_home)
        .env("RUSTUP_HOME", &rustup_home)
        .env("PATH", &build_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            send(&format!("Failed to spawn cargo: {}", e));
            let _ = tx.send(DeployEvent::Complete {
                track,
                success: false,
                message: format!("Build failed: {}", e),
            });
            return;
        }
    };

    // Stream stderr (cargo outputs to stderr)
    if let Some(stderr) = child.stderr.take() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let tx2 = tx.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx2.send(DeployEvent::Output {
                    track: "app".to_string(),
                    line,
                });
            }
        });
    }

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let tx2 = tx.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx2.send(DeployEvent::Output {
                    track: "app".to_string(),
                    line,
                });
            }
        });
    }

    let status = match child.wait().await {
        Ok(s) => s,
        Err(e) => {
            send(&format!("Failed to wait for cargo: {}", e));
            let _ = tx.send(DeployEvent::Complete {
                track,
                success: false,
                message: format!("Build failed: {}", e),
            });
            return;
        }
    };

    if !status.success() {
        send("Build FAILED");
        let _ = tx.send(DeployEvent::Complete {
            track,
            success: false,
            message: "Cargo build failed".to_string(),
        });
        return;
    }

    send("Build complete");
    progress("Installing", Some(80));

    // 4. Install binary + static
    send("[2/3] Installing...");

    if is_symlink {
        // Binary is a symlink to the build target — cargo already updated it in place
        send("Binary symlinked to build output, already updated");
    } else {
        // Copy static files to /opt/feather/static/
        let static_src = source_dir.join("static");
        if !static_is_symlink && static_src.exists() {
            let _ = std::process::Command::new("cp")
                .args(&["-a"])
                .arg(static_src.join("."))
                .arg("/opt/feather/static/")
                .output();
            send("Copied static files to /opt/feather/static/");
        }

        // Copy binary
        let binary_src = source_dir.join("target/release/feather-rs");
        if binary_src.exists() {
            let result = std::process::Command::new("sudo")
                .args(&["cp", "-f"])
                .arg(&binary_src)
                .arg("/usr/local/bin/feather")
                .output();

            match result {
                Ok(out) if out.status.success() => {
                    send("Installed binary to /usr/local/bin/feather");
                }
                _ => {
                    let _ = fs::remove_file("/usr/local/bin/feather");
                    if let Err(e) = fs::copy(&binary_src, "/usr/local/bin/feather") {
                        send(&format!("Failed to copy binary: {}", e));
                        let _ = tx.send(DeployEvent::Complete {
                            track,
                            success: false,
                            message: "Failed to install binary".to_string(),
                        });
                        return;
                    }
                    send("Installed binary to /usr/local/bin/feather");
                }
            }
        }
    }

    // 5. Restart (pkill - supervisord auto-restarts)
    progress("Restarting", Some(95));
    send("[3/3] Restarting feather...");

    let _ = tx.send(DeployEvent::Complete {
        track,
        success: true,
        message: format!("Build {} complete, restarting...", version),
    });

    // Small delay to let the SSE complete event flush
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Kill self — supervisord will restart
    let _ = std::process::Command::new("pkill")
        .args(&["-x", "feather"])
        .output();
}

pub async fn app_rollback(
    State(state): State<Arc<AppState>>,
) -> Json<AppDeployResponse> {
    let tx = state.deploy_tx.clone();
    let track = "app".to_string();

    let send = |line: &str| {
        let _ = tx.send(DeployEvent::Output {
            track: "app".to_string(),
            line: line.to_string(),
        });
    };

    // Restore binary
    if Path::new("/usr/local/bin/feather.prev").exists() {
        send("Restoring binary from backup...");
        let _ = fs::remove_file("/usr/local/bin/feather");
        match fs::copy("/usr/local/bin/feather.prev", "/usr/local/bin/feather") {
            Ok(_) => send("Restored /usr/local/bin/feather from .prev"),
            Err(e) => {
                // Try sudo
                let result = std::process::Command::new("sudo")
                    .args(&["cp", "-f", "/usr/local/bin/feather.prev", "/usr/local/bin/feather"])
                    .output();
                match result {
                    Ok(out) if out.status.success() => send("Restored binary via sudo"),
                    _ => {
                        send(&format!("Failed to restore binary: {}", e));
                        let _ = tx.send(DeployEvent::Complete {
                            track,
                            success: false,
                            message: "Rollback failed".to_string(),
                        });
                        return Json(AppDeployResponse {
                            status: "error".to_string(),
                            message: "Failed to restore binary".to_string(),
                        });
                    }
                }
            }
        }
    } else {
        send("No binary backup found");
        let _ = tx.send(DeployEvent::Complete {
            track,
            success: false,
            message: "No backup found".to_string(),
        });
        return Json(AppDeployResponse {
            status: "error".to_string(),
            message: "No binary backup found".to_string(),
        });
    }

    // Restore static
    if Path::new("/opt/feather/static.prev").exists() {
        send("Restoring static files from backup...");
        let _ = fs::remove_dir_all("/opt/feather/static");
        let _ = std::process::Command::new("cp")
            .args(&["-a", "/opt/feather/static.prev", "/opt/feather/static"])
            .output();
        send("Restored /opt/feather/static from .prev");
    }

    send("Restarting feather...");
    let _ = tx.send(DeployEvent::Complete {
        track,
        success: true,
        message: "Rollback complete, restarting...".to_string(),
    });

    // Small delay to flush SSE
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Kill self — supervisord auto-restarts
    let _ = std::process::Command::new("pkill")
        .args(&["-x", "feather"])
        .output();

    Json(AppDeployResponse {
        status: "ok".to_string(),
        message: "Rollback started".to_string(),
    })
}

fn find_source_dir() -> PathBuf {
    // Try common locations
    let candidates = [
        PathBuf::from("/opt/feather"),
        PathBuf::from("/home/user/projects/feather"),
        PathBuf::from("/home/ubuntu/projects/feather"),
    ];
    for dir in &candidates {
        if dir.join("Cargo.toml").exists() {
            return dir.clone();
        }
    }
    // Fallback to current dir
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn stamp_version(content: &str, version: &str) -> String {
    // Replace: <p class="text-xs text-smoke-9 ml-7">ANYTHING</p>
    if let Some(start) = content.find("text-smoke-9 ml-7\">") {
        let prefix_end = start + 19; // after the ">"
        if let Some(end) = content[prefix_end..].find("</p>") {
            let mut result = String::with_capacity(content.len());
            result.push_str(&content[..prefix_end]);
            result.push_str(version);
            result.push_str(&content[prefix_end + end..]);
            return result;
        }
    }
    content.to_string()
}

// ============================================================================
// Track 3: Container deploy (admin only, via host tmux)
// ============================================================================

#[derive(Deserialize)]
pub struct ContainerRequest {
    target: String, // e.g., "user0", "user1", "all"
}

#[derive(Serialize)]
pub struct ContainerResponse {
    status: String,
    message: String,
}

pub async fn container_deploy(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ContainerRequest>,
) -> Json<ContainerResponse> {
    if !state.is_admin {
        return Json(ContainerResponse {
            status: "error".to_string(),
            message: "Admin access required".to_string(),
        });
    }

    let tx = state.deploy_tx.clone();
    let target = req.target.clone();

    tokio::spawn(async move {
        do_container_deploy(tx, target).await;
    });

    Json(ContainerResponse {
        status: "started".to_string(),
        message: format!("Container deploy started for '{}'", req.target),
    })
}

async fn do_container_deploy(tx: broadcast::Sender<DeployEvent>, target: String) {
    let track = "container".to_string();

    let send = |line: &str| {
        let _ = tx.send(DeployEvent::Output {
            track: "container".to_string(),
            line: line.to_string(),
        });
    };

    send(&format!("Starting container deploy for '{}'...", target));

    let _ = tx.send(DeployEvent::Progress {
        track: "container".to_string(),
        stage: "Sending deploy command".to_string(),
        pct: Some(5),
    });

    // Send deploy command to host via tmux
    let cmd = format!("cd ~/projects/feather-cloud && ./deploy.sh {}\n", target);
    let result = std::process::Command::new("tmux")
        .args(&["-S", "/host-tmux/default", "send-keys", "-t", "host", &cmd, ""])
        .output();

    match result {
        Ok(out) if out.status.success() => {
            send("Deploy command sent to host");
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            send(&format!("Failed to send command: {}", err));
            let _ = tx.send(DeployEvent::Complete {
                track,
                success: false,
                message: "Failed to send deploy command to host".to_string(),
            });
            return;
        }
        Err(e) => {
            send(&format!("Failed to run tmux: {}", e));
            let _ = tx.send(DeployEvent::Complete {
                track,
                success: false,
                message: format!("tmux error: {}", e),
            });
            return;
        }
    }

    // Poll capture-pane for progress
    let mut last_capture = String::new();
    let mut idle_count = 0;

    for i in 0..150 {
        // 5 minute max (150 * 2s)
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let capture = capture_host_pane();
        if capture != last_capture {
            // Send new lines
            let new_lines = diff_new_lines(&last_capture, &capture);
            for line in new_lines {
                send(&line);
            }
            last_capture = capture;
            idle_count = 0;

            // Update progress based on output patterns
            let pct = estimate_container_progress(&last_capture);
            let _ = tx.send(DeployEvent::Progress {
                track: "container".to_string(),
                stage: "Building".to_string(),
                pct: Some(pct),
            });

            // Check for completion
            if last_capture.contains("Deploy complete") || last_capture.contains("=== Built:") {
                send("Container deploy complete");
                let _ = tx.send(DeployEvent::Complete {
                    track,
                    success: true,
                    message: format!("Container deploy for '{}' complete", target),
                });
                return;
            }
            if last_capture.contains("Deploy failed") || last_capture.contains("Error:") {
                send("Container deploy failed");
                let _ = tx.send(DeployEvent::Complete {
                    track,
                    success: false,
                    message: format!("Container deploy for '{}' failed", target),
                });
                return;
            }
        } else {
            idle_count += 1;
            if idle_count > 30 {
                // 60 seconds idle
                send("Deploy appears stalled (60s idle)");
            }
        }
    }

    send("Deploy timed out (5 minutes)");
    let _ = tx.send(DeployEvent::Complete {
        track,
        success: false,
        message: "Deploy timed out".to_string(),
    });
}

pub async fn container_rollback(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ContainerRequest>,
) -> Json<ContainerResponse> {
    if !state.is_admin {
        return Json(ContainerResponse {
            status: "error".to_string(),
            message: "Admin access required".to_string(),
        });
    }

    let tx = state.deploy_tx.clone();
    let target = req.target.clone();

    tokio::spawn(async move {
        do_container_rollback(tx, target).await;
    });

    Json(ContainerResponse {
        status: "started".to_string(),
        message: format!("Container rollback started for '{}'", req.target),
    })
}

async fn do_container_rollback(tx: broadcast::Sender<DeployEvent>, target: String) {
    let track = "container".to_string();

    let send = |line: &str| {
        let _ = tx.send(DeployEvent::Output {
            track: "container".to_string(),
            line: line.to_string(),
        });
    };

    send(&format!("Starting container rollback for '{}'...", target));

    let cmd = format!("cd ~/projects/feather-cloud && ./rollback.sh {}\n", target);
    let result = std::process::Command::new("tmux")
        .args(&["-S", "/host-tmux/default", "send-keys", "-t", "host", &cmd, ""])
        .output();

    match result {
        Ok(out) if out.status.success() => {
            send("Rollback command sent to host");
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            send(&format!("Failed to send rollback command: {}", err));
            let _ = tx.send(DeployEvent::Complete {
                track,
                success: false,
                message: "Failed to send rollback command".to_string(),
            });
            return;
        }
        Err(e) => {
            send(&format!("Failed to run tmux: {}", e));
            let _ = tx.send(DeployEvent::Complete {
                track,
                success: false,
                message: format!("tmux error: {}", e),
            });
            return;
        }
    }

    // Poll for completion (shorter timeout for rollback)
    let mut last_capture = String::new();
    for _ in 0..60 {
        // 2 minute max
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let capture = capture_host_pane();
        if capture != last_capture {
            let new_lines = diff_new_lines(&last_capture, &capture);
            for line in new_lines {
                send(&line);
            }
            last_capture = capture;

            if last_capture.contains("Rollback complete") || last_capture.contains("rolled back") {
                let _ = tx.send(DeployEvent::Complete {
                    track,
                    success: true,
                    message: format!("Rollback for '{}' complete", target),
                });
                return;
            }
        }
    }

    let _ = tx.send(DeployEvent::Complete {
        track,
        success: false,
        message: "Rollback timed out".to_string(),
    });
}

fn capture_host_pane() -> String {
    let output = std::process::Command::new("tmux")
        .args(&["-S", "/host-tmux/default", "capture-pane", "-t", "host", "-p", "-S", "-100"])
        .output();

    match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(_) => String::new(),
    }
}

fn diff_new_lines(old: &str, new: &str) -> Vec<String> {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    // Find where new content starts
    let common = old_lines
        .iter()
        .zip(new_lines.iter())
        .take_while(|(a, b)| a == b)
        .count();

    new_lines[common..]
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn estimate_container_progress(output: &str) -> u8 {
    if output.contains("Compiling") { return 40; }
    if output.contains("Building") { return 30; }
    if output.contains("Downloading") { return 20; }
    if output.contains("podman build") { return 10; }
    if output.contains("Restarting") { return 90; }
    if output.contains("Installing") { return 70; }
    50 // default
}

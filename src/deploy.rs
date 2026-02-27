//! Deploy system with 2 tracks:
//! - Track 2: App (~60s) - rebuild feather binary + static from source
//! - Track 3: Container (~2-5min, admin only) - host podman build + redeploy
//!
//! Build archives live in /usr/local/bin/feather-builds/ as {version}.bin + {version}.static.tar.
//! The admin page lists all archived builds and lets the user activate (roll back to) any of them.

use axum::{
    extract::{Path as AxumPath, State},
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
    active_version: String,
    build_count: u32,
}

pub async fn deploy_status(State(_state): State<Arc<AppState>>) -> Json<DeployStatus> {
    let services = parse_supervisorctl_status();
    let version = read_current_version();
    let builds_dir = Path::new(BUILDS_DIR);
    let active_version = fs::read_to_string(builds_dir.join("active"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let build_count = fs::read_dir(builds_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|ext| ext == "bin")
                        .unwrap_or(false)
                })
                .count() as u32
        })
        .unwrap_or(0);

    Json(DeployStatus {
        is_admin: is_admin(),
        version,
        services,
        active_version,
        build_count,
    })
}

fn parse_supervisorctl_status() -> Vec<ServiceInfo> {
    // Use supervisorctl for accurate status
    let output = std::process::Command::new("supervisorctl")
        .args(&["-s", "unix:///tmp/supervisor.sock", "status"])
        .output();

    let text = match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(_) => return Vec::new(),
    };

    // Format: "name                  STATUS    pid NNNN, uptime H:MM:SS"
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 2 {
                return None;
            }
            let name = parts[0].to_string();
            let status = parts[1].to_string();
            let pid = parts.iter()
                .position(|&p| p == "pid")
                .and_then(|i| parts.get(i + 1))
                .map(|p| p.trim_end_matches(',').to_string());
            let uptime = parts.iter()
                .position(|&p| p == "uptime")
                .and_then(|i| parts.get(i + 1))
                .map(|u| u.to_string());
            Some(ServiceInfo { name, status, pid, uptime })
        })
        .collect()
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

const SUPERVISOR_CONF: &str = "/etc/supervisor/conf.d/supervisord.conf";
const BUILDS_DIR: &str = "/usr/local/bin/feather-builds";

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

    // 2. Detect layout
    let feather_bin = PathBuf::from("/usr/local/bin/feather");
    let is_symlink = feather_bin.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);
    let static_is_symlink = PathBuf::from("/opt/feather").symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);

    // 3. Cargo build
    progress("Building", Some(15));
    send("[1/4] Compiling...");

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
    progress("Archiving", Some(75));

    // 4. Archive build
    send("[2/4] Archiving...");
    let builds_dir = Path::new(BUILDS_DIR);
    let _ = std::process::Command::new("sudo")
        .args(&["mkdir", "-p", BUILDS_DIR])
        .output();

    let binary_src = source_dir.join("target/release/feather-rs");
    let archive_bin = builds_dir.join(format!("{}.bin", version));
    let archive_tar = builds_dir.join(format!("{}.static.tar", version));

    // Copy binary to archive
    let _ = std::process::Command::new("sudo")
        .args(&["cp"])
        .arg(&binary_src)
        .arg(&archive_bin)
        .output();

    // Archive static files
    let _ = std::process::Command::new("sudo")
        .args(&["tar", "cf"])
        .arg(&archive_tar)
        .arg("-C")
        .arg(&source_dir)
        .arg("static/")
        .output();

    send(&format!("Archived build {}", version));

    progress("Installing", Some(85));

    // 5. Install binary + static
    send("[3/4] Installing...");

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

    // Write active version
    let active_path = builds_dir.join("active");
    let _ = std::process::Command::new("sudo")
        .args(&["bash", "-c", &format!("echo '{}' > {}", version, active_path.display())])
        .output();

    // Cleanup: keep 20 newest builds
    if let Ok(entries) = fs::read_dir(builds_dir) {
        let mut bins: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|ext| ext == "bin").unwrap_or(false))
            .collect();
        bins.sort_by_key(|p| std::cmp::Reverse(p.metadata().and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH)));
        for old in bins.iter().skip(20) {
            let _ = std::process::Command::new("sudo").args(&["rm", "-f"]).arg(old).output();
            let tar = old.with_extension("static.tar");
            let _ = std::process::Command::new("sudo").args(&["rm", "-f"]).arg(&tar).output();
            send(&format!("Cleaned up old build: {}", old.file_stem().unwrap_or_default().to_string_lossy()));
        }
    }

    // 6. Restart (pkill - supervisord auto-restarts)
    progress("Restarting", Some(95));
    send("[4/4] Restarting feather...");

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
// Build management endpoints
// ============================================================================

#[derive(Serialize)]
pub struct BuildInfo {
    version: String,
    size: u64,
    mtime: u64,
    active: bool,
    has_static: bool,
}

#[derive(Serialize)]
pub struct BuildListResponse {
    builds: Vec<BuildInfo>,
    active_version: String,
}

pub async fn list_builds() -> Json<BuildListResponse> {
    let builds_dir = Path::new(BUILDS_DIR);
    let active_version = fs::read_to_string(builds_dir.join("active"))
        .unwrap_or_default()
        .trim()
        .to_string();

    let mut builds = Vec::new();

    if let Ok(entries) = fs::read_dir(builds_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().map(|ext| ext == "bin").unwrap_or(false) {
                let version = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let meta = fs::metadata(&path).ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let mtime = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let has_static = builds_dir
                    .join(format!("{}.static.tar", version))
                    .exists();

                builds.push(BuildInfo {
                    active: version == active_version,
                    version,
                    size,
                    mtime,
                    has_static,
                });
            }
        }
    }

    // Sort newest-first by mtime
    builds.sort_by(|a, b| b.mtime.cmp(&a.mtime));

    Json(BuildListResponse {
        builds,
        active_version,
    })
}

#[derive(Deserialize)]
pub struct ActivateRequest {
    version: String,
}

pub async fn activate_build(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ActivateRequest>,
) -> Json<AppDeployResponse> {
    let tx = state.deploy_tx.clone();
    let version = req.version.clone();

    // Validate build exists
    let builds_dir = Path::new(BUILDS_DIR);
    let bin_path = builds_dir.join(format!("{}.bin", version));
    if !bin_path.exists() {
        return Json(AppDeployResponse {
            status: "error".to_string(),
            message: format!("Build '{}' not found", version),
        });
    }

    // Spawn background task
    tokio::spawn(async move {
        do_activate_build(tx, version).await;
    });

    Json(AppDeployResponse {
        status: "started".to_string(),
        message: format!("Activating build {}", req.version),
    })
}

async fn do_activate_build(tx: broadcast::Sender<DeployEvent>, version: String) {
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

    let builds_dir = Path::new(BUILDS_DIR);
    let bin_path = builds_dir.join(format!("{}.bin", version));
    let tar_path = builds_dir.join(format!("{}.static.tar", version));
    let feather_bin = "/usr/local/bin/feather";

    send(&format!("=== Activating build: {} ===", version));

    // ---------------------------------------------------------------
    // FIX: The old code called `supervisorctl stop feather` in-process,
    // which killed *this* process (feather) before the swap could finish.
    //
    // New approach: do all file operations while still running, then
    // write a detached shell script that restarts us. The script
    // outlives the feather process so the restart always completes.
    // ---------------------------------------------------------------

    progress("Installing", Some(20));

    // 1. Copy new binary into place (overwrites running binary on disk;
    //    the kernel keeps the old inode open until the process exits)
    send("Installing binary...");
    let result = std::process::Command::new("sudo")
        .args(&["cp", "--force"])
        .arg(&bin_path)
        .arg(feather_bin)
        .output();

    match result {
        Ok(out) if out.status.success() => {
            send(&format!("Installed binary from {}.bin", version));
        }
        _ => {
            send("ERROR: Failed to install binary");
            let _ = tx.send(DeployEvent::Complete {
                track: "app".to_string(),
                success: false,
                message: "Failed to install binary".to_string(),
            });
            return;
        }
    }

    // 2. Extract static assets while still running
    progress("Restoring static", Some(50));
    if tar_path.exists() {
        send("Extracting static assets...");
        let _ = std::process::Command::new("tar")
            .args(&["xf"])
            .arg(&tar_path)
            .args(&["-C", "/opt/feather/"])
            .output();
        send("Restored static assets");
    }

    // 3. Write active version marker
    let active_path = builds_dir.join("active");
    let _ = std::process::Command::new("sudo")
        .args(&["bash", "-c", &format!("echo '{}' > {}", version, active_path.display())])
        .output();
    send(&format!("Active version set to {}", version));

    progress("Restarting", Some(80));

    // 4. Write a detached restart script that outlives this process
    let script = "/tmp/feather-activate.sh";
    let script_content = format!(
        "#!/bin/bash\n\
         sleep 1\n\
         supervisorctl -s unix:///tmp/supervisor.sock restart feather\n\
         rm -f {script}\n"
    );
    let _ = fs::write(script, &script_content);
    let _ = std::process::Command::new("chmod")
        .args(&["+x", script])
        .output();

    send("Restarting feather...");
    let _ = tx.send(DeployEvent::Complete {
        track: "app".to_string(),
        success: true,
        message: format!("Activated build {}. Restarting...", version),
    });

    // Small delay to flush SSE events to connected clients
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // 5. Launch the restart script detached (survives our death)
    let _ = std::process::Command::new("nohup")
        .args(&[script])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

pub async fn delete_build(
    AxumPath(version): AxumPath<String>,
) -> Json<AppDeployResponse> {
    let builds_dir = Path::new(BUILDS_DIR);

    // Check if this is the active version
    let active = fs::read_to_string(builds_dir.join("active"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if version == active {
        return Json(AppDeployResponse {
            status: "error".to_string(),
            message: "Cannot delete the active build".to_string(),
        });
    }

    let bin_path = builds_dir.join(format!("{}.bin", version));
    if !bin_path.exists() {
        return Json(AppDeployResponse {
            status: "error".to_string(),
            message: format!("Build '{}' not found", version),
        });
    }

    // Remove binary and static archive
    let _ = std::process::Command::new("sudo")
        .args(&["rm", "-f"])
        .arg(&bin_path)
        .output();
    let tar_path = builds_dir.join(format!("{}.static.tar", version));
    let _ = std::process::Command::new("sudo")
        .args(&["rm", "-f"])
        .arg(&tar_path)
        .output();

    Json(AppDeployResponse {
        status: "ok".to_string(),
        message: format!("Deleted build {}", version),
    })
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

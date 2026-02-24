//! # Feather-rs
//!
//! A Rust-based Claude session viewer and manager.
//!
//! This server provides:
//! - Real-time SSE streaming for UI updates
//! - Session history browsing from JSONL files in ~/.claude/projects/
//! - tmux integration for running Claude CLI instances
//! - REST API for session management
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
//! │  Frontend   │────▶│  Axum HTTP   │────▶│  ~/.claude/     │
//! │  (index.html)     │  Server      │     │  projects/      │
//! └─────────────┘     └──────────────┘     │  (JSONL files)  │
//!       │                   │              └─────────────────┘
//!       │ SSE               │
//!       ▼                   ▼
//! ┌─────────────┐     ┌──────────────┐
//! │  Real-time  │     │  TmuxManager │
//! │  Updates    │     │  (tmux.rs)   │
//! └─────────────┘     └──────────────┘
//! ```
//!
//! ## API Endpoints
//!
//! - `GET /health` - Server health check
//! - `GET /api/stream` - SSE event stream
//! - `GET /api/projects` - List Claude projects
//! - `GET /api/projects/{id}/sessions` - List sessions in project
//! - `GET /api/projects/{id}/sessions/{sid}/history` - Get session messages
//! - `POST /api/claude-new` - Create new Claude session
//! - `POST /api/claude-send/{id}` - Send message to session
//! - `GET /api/claude-sessions` - List active tmux sessions

mod codex;
mod deploy;
mod memory;
mod normalizer;
mod pi;
mod sessions;
mod titles;
mod tmux;

use axum::{
    body::Bytes,
    extract::{Path, State, Query, DefaultBodyLimit, Multipart, WebSocketUpgrade},
    extract::ws::{Message, WebSocket},
    http::HeaderMap,
    response::{Json, sse::{Event, KeepAlive, Sse}, IntoResponse},
    routing::{get, post, delete},
    Router,
};
use futures::stream::{self, Stream};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use tokio::sync::{broadcast, RwLock};
use tokio_stream::StreamExt;
use tower_http::services::ServeDir;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::sessions::SessionCache;
use crate::tmux::TmuxManager;

// ============================================================================
// SSE Event Types
// ============================================================================

/// Server-Sent Events that are broadcast to connected clients.
///
/// Events are tagged with their type in the JSON serialization to allow
/// the frontend to dispatch them appropriately.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum SseEvent {
    #[serde(rename = "heartbeat")]
    Heartbeat { timestamp: u64 },
    #[serde(rename = "message")]
    Message { content: String, role: String },
    #[serde(rename = "terminal")]
    Terminal { data: String },
    #[serde(rename = "status")]
    Status { status: String, details: Option<String> },
}

// ============================================================================
// Session Types - Data structures for Claude session management
// ============================================================================

/// A Claude project directory (e.g., ~/.claude/projects/-mnt-ebs-hft-code/)
#[derive(Debug, Serialize)]
struct Project {
    id: String,
    name: String,
    path: String,
}

/// A Claude conversation session (stored as a JSONL file)
#[derive(Debug, Serialize)]
struct Session {
    id: String,              // JSONL filename without extension
    project: String,         // Parent project ID
    title: Option<String>,   // Extracted from summary or first user message
    #[serde(rename = "lastUpdated")]
    last_updated: String,    // ISO 8601 timestamp from file mtime
    source: String,          // "claude", "codex", or "pi"
}

/// A content block within a message (text, thinking, tool_use, tool_result)
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type")]
enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    #[serde(rename = "image")]
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<serde_json::Value>,
    },
}

/// A single message extracted from a JSONL session file
#[derive(Debug, Serialize)]
struct HistoryMessage {
    role: String,       // "user" or "assistant"
    content: Vec<ContentBlock>,  // Structured content blocks
    timestamp: String,  // ISO 8601 timestamp
    uuid: String,       // Unique message identifier
}

/// Complete message history for a session
#[derive(Debug, Serialize)]
struct SessionHistory {
    session_id: String,
    project: String,
    messages: Vec<HistoryMessage>,
    /// Opaque cursor for starting SSE tail (base64-encoded byte offset)
    cursor: String,
}

// JSONL record types - used for parsing Claude's session files
// Claude stores sessions as JSONL with various record types:
// - "user": User messages
// - "assistant": Claude responses
// - "summary": Session summary/title
// - "tool_use", "tool_result": Tool interactions (skipped)

#[derive(Debug, Deserialize)]
struct JsonlRecord {
    #[serde(rename = "type")]
    record_type: Option<String>,
    message: Option<JsonlMessage>,
    timestamp: Option<String>,
    uuid: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonlMessage {
    role: Option<String>,
    content: Option<serde_json::Value>,  // Can be string or array of content blocks
}

// ============================================================================
// App State - Shared state across all request handlers
// ============================================================================

/// Global application state shared across all HTTP handlers.
/// Wrapped in Arc<> for thread-safe sharing.
struct AppState {
    start_time: Instant,                           // Server start time for uptime tracking
    event_tx: broadcast::Sender<(u64, SseEvent)>,  // SSE broadcast channel
    seq: std::sync::atomic::AtomicU64,             // Monotonic event sequence number
    sessions_dir: PathBuf,                          // Path to ~/.claude/projects/
    deploy_tx: broadcast::Sender<deploy::DeployEvent>,  // Deploy SSE broadcast channel
    is_admin: bool,                                // Has host tmux access
    default_cwd: String,                            // Default working directory for new sessions
    tmux: TmuxManager,                              // Handles tmux session lifecycle
    session_cache: Arc<SessionCache>,               // Normalized session cache
    codex_sessions: RwLock<HashMap<String, CodexSessionInfo>>, // Codex session tracking
    pi_sessions: RwLock<HashMap<String, PiSessionInfo>>,     // Pi session tracking
    title_trigger: Arc<tokio::sync::Notify>,        // Trigger title generation on new session
}

#[derive(Clone, Debug)]
#[allow(dead_code)] // Stored for future debugging/session recovery
struct CodexSessionInfo {
    project_id: String,
    cwd: String,
    last_capture_id: u64,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
struct PiSessionInfo {
    project_id: String,
    cwd: String,
    /// The real Pi session UUID (from JSONL header), used to link tmux name → normalized session
    pi_uuid: Option<String>,
}

impl AppState {
    /// Get next sequence number for SSE events (ensures ordering)
    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }

    /// Broadcast an event to all connected SSE clients
    fn broadcast(&self, event: SseEvent) {
        let seq = self.next_seq();
        let _ = self.event_tx.send((seq, event));  // Ignore error if no subscribers
    }
}

// ============================================================================
// Health Endpoint
// ============================================================================

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    uptime_secs: u64,
    version: &'static str,
    active_tmux_sessions: usize,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        uptime_secs: state.start_time.elapsed().as_secs(),
        version: env!("CARGO_PKG_VERSION"),
        active_tmux_sessions: state.tmux.list_tmux_sessions().len(),
    })
}

// ============================================================================
// Dashboards Endpoint
// ============================================================================

#[derive(Serialize)]
struct DashboardFile {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct DashboardsResponse {
    files: Vec<DashboardFile>,
}

async fn list_dashboards() -> Json<DashboardsResponse> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    let dashboards_dir = PathBuf::from(&home).join("dashboards");

    let mut files = Vec::new();

    if let Ok(entries) = fs::read_dir(&dashboards_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    // Only include HTML files, skip index.html
                    if name.ends_with(".html") && name != "index.html" {
                        files.push(DashboardFile {
                            name: name.trim_end_matches(".html").to_string(),
                            path: format!("/dashboards/{}", name),
                        });
                    }
                }
            }
        }
    }

    // Sort alphabetically
    files.sort_by(|a, b| a.name.cmp(&b.name));

    Json(DashboardsResponse { files })
}

// ============================================================================
// SSE Stream Endpoint
// ============================================================================

#[derive(Deserialize, Default)]
struct StreamQuery {
    #[serde(default)]
    last_event_id: Option<u64>,
}

async fn stream_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<StreamQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let last_id = headers
        .get("Last-Event-ID")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .or(query.last_event_id);

    if let Some(id) = last_id {
        tracing::info!("Client reconnecting from event ID: {}", id);
    }

    let rx = state.event_tx.subscribe();
    let _current_seq = state.seq.load(std::sync::atomic::Ordering::SeqCst);

    // Create heartbeat stream
    let heartbeat_state = state.clone();
    let heartbeat = stream::unfold((), move |()| {
        let s = heartbeat_state.clone();
        async move {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let seq = s.next_seq();
            let event = SseEvent::Heartbeat {
                timestamp: SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            };
            let data = serde_json::to_string(&event).unwrap();
            Some((
                Ok(Event::default()
                    .event("heartbeat")
                    .id(seq.to_string())
                    .data(data)),
                (),
            ))
        }
    });

    // Create broadcast event stream
    let broadcast_stream = stream::unfold(rx, move |mut rx| async move {
        match rx.recv().await {
            Ok((seq, event)) => {
                let event_type = match &event {
                    SseEvent::Heartbeat { .. } => "heartbeat",
                    SseEvent::Message { .. } => "message",
                    SseEvent::Terminal { .. } => "terminal",
                    SseEvent::Status { .. } => "status",
                };
                let data = serde_json::to_string(&event).unwrap();
                Some((
                    Ok(Event::default()
                        .event(event_type)
                        .id(seq.to_string())
                        .data(data)),
                    rx,
                ))
            }
            Err(_) => None,
        }
    });

    // Send initial connection event
    let init_seq = state.next_seq();
    let init_event = stream::once(async move {
        let event = SseEvent::Status {
            status: "connected".to_string(),
            details: Some(format!("seq: {}", init_seq)),
        };
        let data = serde_json::to_string(&event).unwrap();
        Ok(Event::default()
            .event("status")
            .id(init_seq.to_string())
            .data(data))
    });

    let merged = init_event.chain(
        tokio_stream::StreamExt::merge(heartbeat, broadcast_stream)
    );

    Sse::new(merged).keep_alive(KeepAlive::default())
}

// ============================================================================
// Session Endpoints
// ============================================================================

#[derive(Serialize)]
struct ProjectsResponse {
    projects: Vec<Project>,
}

async fn list_projects(State(state): State<Arc<AppState>>) -> Json<ProjectsResponse> {
    let mut project_ids: HashSet<String> = HashSet::new();

    // Include projects from Claude sessions directory (legacy)
    if let Ok(entries) = fs::read_dir(&state.sessions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    project_ids.insert(name.to_string());
                }
            }
        }
    }

    // Include projects from normalized session cache (Codex + Claude)
    for meta in state.session_cache.list_sessions() {
        if !meta.project.is_empty() {
            project_ids.insert(meta.project);
        }
    }

    let mut projects = Vec::new();
    for id in project_ids {
        let actual_path = reconstruct_project_path(&id);
        projects.push(Project {
            id: id.clone(),
            name: actual_path.clone(),
            path: actual_path,
        });
    }

    projects.sort_by(|a, b| a.name.cmp(&b.name));

    Json(ProjectsResponse { projects })
}

/// Reconstruct actual project path from Claude's project ID
/// e.g., "-home-user-my-app" -> "/home/user/my-app"
fn reconstruct_project_path(project_id: &str) -> String {
    // Remove leading dash
    let without_prefix = project_id.trim_start_matches('-');

    // Split by dash and try to reconstruct
    let parts: Vec<&str> = without_prefix.split('-').collect();

    // Try progressively joining parts with slashes, checking if path exists
    // Start from the end to prefer longer directory names (my-app vs my/app)
    for i in (1..parts.len()).rev() {
        let path_part: String = parts[..i].iter().map(|s| format!("/{}", s)).collect();
        let name_part = parts[i..].join("-");
        let candidate = format!("{}/{}", path_part, name_part);

        if PathBuf::from(&candidate).exists() {
            return candidate;
        }
    }

    // Fallback: just replace all dashes with slashes
    format!("/{}", without_prefix.replace('-', "/"))
}

/// Convert an absolute path to Claude-style project ID
/// e.g., "/home/user/my-app" -> "-home-user-my-app"
/// Find a Pi session JSONL file by its UUID (from the session header)
fn find_pi_session_file(pi_sessions_dir: &std::path::Path, uuid: &str) -> Option<PathBuf> {
    if !pi_sessions_dir.exists() {
        return None;
    }
    for cwd_entry in fs::read_dir(pi_sessions_dir).ok()?.flatten() {
        let cwd_path = cwd_entry.path();
        if !cwd_path.is_dir() {
            continue;
        }
        for file_entry in fs::read_dir(&cwd_path).ok()?.flatten() {
            let file_path = file_entry.path();
            if file_path.extension().map_or(true, |e| e != "jsonl") {
                continue;
            }
            // Quick check: if UUID is in the filename, likely match
            let fname = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let likely = fname.contains(uuid);
            // Read first line to confirm UUID
            if let Ok(content) = fs::read_to_string(&file_path) {
                if let Some(first_line) = content.lines().next() {
                    if let Ok(header) = serde_json::from_str::<serde_json::Value>(first_line) {
                        if header.get("type").and_then(|t| t.as_str()) == Some("session") {
                            if header.get("id").and_then(|i| i.as_str()) == Some(uuid) {
                                return Some(file_path);
                            }
                        }
                    }
                }
                if !likely {
                    continue;
                }
            }
        }
    }
    None
}

fn project_id_from_path(path: &str) -> String {
    let trimmed = path.trim();
    let normalized = if trimmed.is_empty() { "/" } else { trimmed };
    format!("-{}", normalized.replace('/', "-").trim_start_matches('-'))
}

/// Current UTC timestamp as ISO 8601 string
#[allow(dead_code)]
fn now_iso() -> String {
    let datetime = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        datetime.year(),
        datetime.month() as u8,
        datetime.day(),
        datetime.hour(),
        datetime.minute(),
        datetime.second()
    )
}

/// Strip ANSI escape codes for cleaner logs
#[allow(dead_code)]
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip ESC sequences
            if let Some('[') = chars.peek() {
                chars.next();
                while let Some(&ch) = chars.peek() {
                    chars.next();
                    if ch.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Return the suffix of `current` after removing common prefix with `base`
#[allow(dead_code)]
fn diff_suffix(base: &str, current: &str) -> String {
    let base_bytes = base.as_bytes();
    let cur_bytes = current.as_bytes();
    let mut idx = 0usize;
    let max = base_bytes.len().min(cur_bytes.len());
    while idx < max && base_bytes[idx] == cur_bytes[idx] {
        idx += 1;
    }
    // Ensure we start at a UTF-8 boundary
    while idx < current.len() && !current.is_char_boundary(idx) {
        idx += 1;
    }
    String::from_utf8_lossy(&cur_bytes[idx..]).to_string()
}

#[derive(Serialize)]
struct SessionsResponse {
    project: String,
    sessions: Vec<Session>,
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Json<SessionsResponse> {
    let mut sessions = Vec::new();

    let cached = state.session_cache.list_sessions();
    for meta in cached.into_iter().filter(|m| m.project == project_id) {
        let title = meta.title.clone();

        let last_updated = if meta.updated_at.is_empty() {
            "unknown".to_string()
        } else {
            meta.updated_at.clone()
        };

        sessions.push(Session {
            id: meta.id,
            project: meta.project,
            title,
            last_updated,
            source: meta.source,
        });
    }

    sessions.sort_by(|a, b| b.last_updated.cmp(&a.last_updated));

    Json(SessionsResponse {
        project: project_id,
        sessions,
    })
}

#[derive(Deserialize)]
struct HistoryQuery {
    offset: Option<usize>,
}

async fn get_session_history(
    State(state): State<Arc<AppState>>,
    Path((project_id, session_id)): Path<(String, String)>,
    Query(query): Query<HistoryQuery>,
) -> Json<SessionHistory> {
    let _ = project_id; // normalized-only (project_id kept for route compatibility)

    // Only use normalized sessions (~/sessions/{session_id}.jsonl)
    let normalized_path = state.session_cache.normalized_dir.join(format!("{}.jsonl", session_id));
    let offset = query.offset.unwrap_or(0);

    let file_size = fs::metadata(&normalized_path).map(|m| m.len()).unwrap_or(0);
    let mut messages = Vec::new();

    if let Ok(content) = fs::read_to_string(&normalized_path) {
        for line in content.lines() {
            if let Ok(msg) = serde_json::from_str::<sessions::NormalizedMessage>(line) {
                // Convert NormalizedMessage to HistoryMessage
                let blocks: Vec<ContentBlock> = msg.content.into_iter().map(|b| {
                    match b {
                        sessions::ContentBlock::Text { text } => ContentBlock::Text { text },
                        sessions::ContentBlock::Thinking { thinking } => ContentBlock::Thinking { text: thinking },
                        sessions::ContentBlock::ToolUse { id, name, input } => ContentBlock::ToolUse { id, name, input },
                        sessions::ContentBlock::ToolResult { tool_use_id, content, is_error } =>
                            ContentBlock::ToolResult { tool_use_id, content, is_error },
                        sessions::ContentBlock::Image { source } => ContentBlock::Image {
                            source: source.map(|s| serde_json::json!({
                                "type": s.source_type,
                                "media_type": s.media_type,
                                "data": s.data
                            }))
                        },
                    }
                }).collect();

                if !blocks.is_empty() {
                    messages.push(HistoryMessage {
                        role: msg.role,
                        content: blocks,
                        timestamp: msg.timestamp,
                        uuid: msg.uuid,
                    });
                }
            }
        }
    }

    // If offset specified, only return messages after that index
    let mut messages = messages;
    if offset > 0 && offset < messages.len() {
        messages = messages.split_off(offset);
    } else if offset >= messages.len() && offset > 0 {
        messages.clear();
    }

    Json(SessionHistory {
        session_id,
        project: project_id,
        messages,
        cursor: encode_cursor(file_size),
    })
}

// ============================================================================
// Claude/Tmux Endpoints
// ============================================================================

// ============================================================================
// Claude Auth Status - Check if Claude CLI is authenticated
// ============================================================================

#[derive(Serialize)]
struct ClaudeAuthStatusResponse {
    authenticated: bool,
    message: String,
}

/// Check if Claude CLI has valid authentication.
/// Looks for credentials in ~/.claude/ directory.
async fn claude_auth_status() -> Json<ClaudeAuthStatusResponse> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/claude".to_string());
    let claude_dir = PathBuf::from(&home).join(".claude");

    // Check for various auth indicators
    // Claude CLI stores auth in different locations depending on version
    let auth_files = [
        claude_dir.join(".credentials"),
        claude_dir.join("credentials.json"),
        claude_dir.join("settings.json"),
    ];

    // Check if any session files exist (indicates prior successful auth)
    let projects_dir = claude_dir.join("projects");
    let has_sessions = projects_dir.exists() &&
        fs::read_dir(&projects_dir)
            .map(|entries| entries.filter_map(|e| e.ok()).any(|e| e.path().is_dir()))
            .unwrap_or(false);

    // Check for credential files
    let has_creds = auth_files.iter().any(|p| p.exists());

    // Also try running `claude --version` to see if it's configured
    let claude_works = std::process::Command::new("claude")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let authenticated = has_creds || has_sessions;

    let message = if authenticated {
        "Claude CLI is authenticated".to_string()
    } else if claude_works {
        "Claude CLI installed but not authenticated. Run 'claude' in terminal to authenticate.".to_string()
    } else {
        "Claude CLI not found or not configured".to_string()
    };

    Json(ClaudeAuthStatusResponse {
        authenticated,
        message,
    })
}

#[derive(Serialize)]
struct ClaudeStatusResponse {
    active: bool,
    session_id: String,
    tmux_name: String,
}

async fn claude_status(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Json<ClaudeStatusResponse> {
    let active = state.tmux.is_session_active(&session_id);
    let tmux_name = state.tmux.get_session_name(&session_id);

    Json(ClaudeStatusResponse {
        active,
        session_id,
        tmux_name,
    })
}

#[derive(Deserialize)]
struct SpawnRequest {
    cwd: Option<String>,
}

#[derive(Serialize)]
struct SpawnResponse {
    status: String,
    tmux_name: String,
    session_id: Option<String>,
}

async fn claude_spawn(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(req): Json<SpawnRequest>,
) -> Json<SpawnResponse> {
    match state.tmux.spawn_claude_session(&session_id, req.cwd.as_deref()) {
        Ok(info) => {
            state.title_trigger.notify_one();
            Json(SpawnResponse {
                status: "spawned".to_string(),
                tmux_name: info.tmux_name,
                session_id: Some(info.session_id),
            })
        }
        Err(e) => Json(SpawnResponse {
            status: format!("error: {}", e),
            tmux_name: String::new(),
            session_id: None,
        }),
    }
}

#[derive(Deserialize)]
struct NewClaudeRequest {
    cwd: Option<String>,
}

async fn claude_new(
    State(state): State<Arc<AppState>>,
    Json(req): Json<NewClaudeRequest>,
) -> Json<SpawnResponse> {
    match state.tmux.spawn_new_claude_session(req.cwd.as_deref()) {
        Ok(tmux_name) => {
            state.title_trigger.notify_one();
            Json(SpawnResponse {
                status: "spawned".to_string(),
                tmux_name,
                session_id: None, // Session ID will be created by Claude CLI
            })
        }
        Err(e) => Json(SpawnResponse {
            status: format!("error: {}", e),
            tmux_name: String::new(),
            session_id: None,
        }),
    }
}

// ============================================================================
// Codex CLI Endpoints
// ============================================================================

#[derive(Deserialize)]
struct CodexNewRequest {
    cwd: Option<String>,
    /// Optional explicit session ID (used to reattach to a prior transcript)
    session_id: Option<String>,
    /// "yolo" or "sandbox"
    mode: Option<String>,
}

#[derive(Serialize)]
struct CodexSpawnResponse {
    status: String,
    session_id: Option<String>,
    tmux_name: String,
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn codex_flags(mode: &str) -> String {
    match mode {
        "sandbox" => "--ask-for-approval never --sandbox workspace-write --no-alt-screen".to_string(),
        // --full-auto skips approval prompts and uses sandboxed automatic execution
        _ => "--full-auto --no-alt-screen".to_string(),
    }
}

fn is_safe_session_id(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

async fn codex_new(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CodexNewRequest>,
) -> Json<CodexSpawnResponse> {
    let cwd = req.cwd.as_deref().unwrap_or(&state.default_cwd).to_string();
    let project_id = project_id_from_path(&cwd);

    let session_id = if let Some(id) = req.session_id.as_deref() {
        if !is_safe_session_id(id) {
            return Json(CodexSpawnResponse {
                status: "error".to_string(),
                session_id: None,
                tmux_name: String::new(),
                project_id: None,
                error: Some("Invalid session_id".to_string()),
            });
        }
        if id.starts_with("feather-codex-") {
            id.to_string()
        } else if id.starts_with("codex-") {
            format!("feather-{}", id)
        } else {
            format!("feather-codex-{}", id)
        }
    } else {
        let ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        format!("feather-codex-{}", ts)
    };

    let mode = req.mode.as_deref().unwrap_or("yolo");
    let flags = codex_flags(mode);

    match state.tmux.spawn_codex_session(&session_id, &cwd, &flags) {
        Ok(tmux_name) => {
            let mut sessions = state.codex_sessions.write().await;
            sessions.insert(session_id.clone(), CodexSessionInfo {
                project_id: project_id.clone(),
                cwd,
                last_capture_id: 0,
            });
            state.title_trigger.notify_one();
            Json(CodexSpawnResponse {
                status: "spawned".to_string(),
                session_id: Some(session_id),
                tmux_name,
                project_id: Some(project_id),
                error: None,
            })
        }
        Err(e) => Json(CodexSpawnResponse {
            status: "error".to_string(),
            session_id: None,
            tmux_name: String::new(),
            project_id: None,
            error: Some(e),
        }),
    }
}

#[derive(Deserialize)]
struct CodexSendRequest {
    message: String,
}

async fn codex_send(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(req): Json<CodexSendRequest>,
) -> Json<SimpleResponse> {
    // Send message to tmux - Codex writes its own JSONL files that normalizer watches
    if let Err(e) = state.tmux.send_message(&session_id, &req.message) {
        return Json(SimpleResponse { status: format!("error: {}", e) });
    }

    Json(SimpleResponse { status: "sent".to_string() })
}

#[derive(Serialize)]
struct CodexStatusResponse {
    active: bool,
    session_id: String,
}

async fn codex_status(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Json<CodexStatusResponse> {
    let active = state.tmux.is_session_active(&session_id);
    Json(CodexStatusResponse { active, session_id })
}

// ============================================================================
// Pi Coding Agent Endpoints
// ============================================================================

#[derive(Deserialize)]
struct PiNewRequest {
    cwd: Option<String>,
    session_id: Option<String>,
    /// Pi session UUID to resume (will find the existing session file)
    resume_session: Option<String>,
}

#[derive(Serialize)]
struct PiSpawnResponse {
    status: String,
    session_id: Option<String>,
    tmux_name: String,
    project_id: Option<String>,
    error: Option<String>,
}

async fn pi_new(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PiNewRequest>,
) -> Json<PiSpawnResponse> {
    let cwd = req.cwd.as_deref().unwrap_or(&state.default_cwd).to_string();
    let project_id = project_id_from_path(&cwd);

    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    let pi_sessions_dir = PathBuf::from(&home).join(".pi").join("agent").join("sessions");

    // If resuming an existing session, find its file by UUID
    let (session_id, session_file, is_resume) = if let Some(ref resume_uuid) = req.resume_session {
        // Search all Pi session files for one whose header has this UUID
        let found = find_pi_session_file(&pi_sessions_dir, resume_uuid);
        match found {
            Some(path) => {
                let ts = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_millis();
                let sid = format!("feather-pi-{}", ts);
                (sid, path, true)
            }
            None => {
                return Json(PiSpawnResponse {
                    status: "error".to_string(),
                    session_id: None,
                    tmux_name: String::new(),
                    project_id: None,
                    error: Some(format!("Session file not found for UUID: {}", resume_uuid)),
                });
            }
        }
    } else {
        let session_id = if let Some(id) = req.session_id.as_deref() {
            if !is_safe_session_id(id) {
                return Json(PiSpawnResponse {
                    status: "error".to_string(),
                    session_id: None,
                    tmux_name: String::new(),
                    project_id: None,
                    error: Some("Invalid session_id".to_string()),
                });
            }
            if id.starts_with("feather-pi-") {
                id.to_string()
            } else if id.starts_with("pi-") {
                format!("feather-{}", id)
            } else {
                format!("feather-pi-{}", id)
            }
        } else {
            let ts = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_millis();
            format!("feather-pi-{}", ts)
        };

        // Generate a predictable session file path so we can track it immediately.
        // Encode cwd same way Pi does: each / becomes --
        let encoded_cwd = cwd.replace('/', "--");
        let session_dir = pi_sessions_dir.join(&encoded_cwd);
        let _ = fs::create_dir_all(&session_dir);
        let file = session_dir.join(format!("{}.jsonl", session_id));
        (session_id, file, false)
    };

    // Pi's --session flag lets us choose where the JSONL goes (or resume from)
    let flags = if is_resume {
        format!("--continue --session {}", session_file.display())
    } else {
        format!("--session {}", session_file.display())
    };

    let bootstrap_msg = if is_resume { None } else { Some("hi") };
    match state.tmux.spawn_pi_session(&session_id, &cwd, &flags, bootstrap_msg) {
        Ok(tmux_name) => {
            // Return immediately. Background task polls for UUID once Pi
            // processes the bootstrap message (passed as CLI arg).
            let mut sessions = state.pi_sessions.write().await;
            sessions.insert(session_id.clone(), PiSessionInfo {
                project_id: project_id.clone(),
                cwd: cwd.clone(),
                pi_uuid: None,
            });
            drop(sessions);

            // Background: poll for UUID from session file
            let bg_state = state.clone();
            let bg_session_id = session_id.clone();
            let bg_session_file = session_file.clone();
            tokio::task::spawn_blocking(move || {
                // Poll for UUID (up to 30s — Pi needs to start + process message)
                for _ in 0..150 {
                    if let Ok(content) = fs::read_to_string(&bg_session_file) {
                        if let Some(first_line) = content.lines().next() {
                            if let Ok(header) = serde_json::from_str::<serde_json::Value>(first_line) {
                                if header.get("type").and_then(|t| t.as_str()) == Some("session") {
                                    if let Some(uuid) = header.get("id").and_then(|i| i.as_str()) {
                                        tracing::info!("Pi session {} resolved to UUID {}", bg_session_id, uuid);
                                        let rt = tokio::runtime::Handle::current();
                                        rt.block_on(async {
                                            let mut sessions = bg_state.pi_sessions.write().await;
                                            if let Some(info) = sessions.get_mut(&bg_session_id) {
                                                info.pi_uuid = Some(uuid.to_string());
                                            }
                                        });
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                tracing::warn!("Pi session {} failed to resolve UUID", bg_session_id);
            });

            state.title_trigger.notify_one();
            Json(PiSpawnResponse {
                status: "spawned".to_string(),
                session_id: None, // Resolved async — frontend polls pi-resolve
                tmux_name,
                project_id: Some(project_id),
                error: None,
            })
        }
        Err(e) => Json(PiSpawnResponse {
            status: "error".to_string(),
            session_id: None,
            tmux_name: String::new(),
            project_id: None,
            error: Some(e),
        }),
    }
}

#[derive(Deserialize)]
struct PiSendRequest {
    message: String,
}

async fn pi_send(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(req): Json<PiSendRequest>,
) -> Json<SimpleResponse> {
    if let Err(e) = state.tmux.send_message(&session_id, &req.message) {
        return Json(SimpleResponse { status: format!("error: {}", e) });
    }
    Json(SimpleResponse { status: "sent".to_string() })
}

/// Poll for Pi session UUID resolution.
/// Returns the real UUID once the background task discovers it.
#[derive(Serialize)]
struct PiResolveResponse {
    resolved: bool,
    session_id: Option<String>,
}

async fn pi_resolve(
    State(state): State<Arc<AppState>>,
    Path(tmux_name): Path<String>,
) -> Json<PiResolveResponse> {
    let sessions = state.pi_sessions.read().await;
    if let Some(info) = sessions.get(&tmux_name) {
        if let Some(ref uuid) = info.pi_uuid {
            return Json(PiResolveResponse {
                resolved: true,
                session_id: Some(uuid.clone()),
            });
        }
    }
    Json(PiResolveResponse {
        resolved: false,
        session_id: None,
    })
}

#[derive(Serialize)]
struct PiStatusResponse {
    active: bool,
    session_id: String,
}

async fn pi_status(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Json<PiStatusResponse> {
    let active = state.tmux.is_session_active(&session_id);
    Json(PiStatusResponse { active, session_id })
}

// ============================================================================
// Create Project Endpoint
// ============================================================================

#[derive(Deserialize)]
struct CreateProjectRequest {
    name: String,
    description: Option<String>,
}

#[derive(Serialize)]
struct CreateProjectResponse {
    status: String,
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn create_project(
    Json(req): Json<CreateProjectRequest>,
) -> Json<CreateProjectResponse> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    let project_path = PathBuf::from(&home).join(&req.name);

    // Validate project name (alphanumeric and hyphens only)
    if req.name.is_empty() || !req.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Json(CreateProjectResponse {
            status: "error".to_string(),
            project_id: None,
            error: Some("Invalid project name. Use only letters, numbers, and hyphens.".to_string()),
        });
    }

    // Check if already exists
    if project_path.exists() {
        return Json(CreateProjectResponse {
            status: "error".to_string(),
            project_id: None,
            error: Some("Project already exists".to_string()),
        });
    }

    // Create directory
    if let Err(e) = fs::create_dir_all(&project_path) {
        return Json(CreateProjectResponse {
            status: "error".to_string(),
            project_id: None,
            error: Some(format!("Failed to create directory: {}", e)),
        });
    }

    // Generate CLAUDE.md content
    let description = req.description.as_deref().unwrap_or("A new project");
    let claude_md = format!(
        r#"# {}

{}

## Project Overview

This is a new project workspace. Update this file with:
- Project goals and context
- Key files and their purposes
- Coding conventions and patterns
- Any specific instructions for Claude

## Getting Started

Describe how to set up and run this project.

## Notes

Add any additional context that would help Claude understand this project.
"#,
        req.name, description
    );

    let claude_md_path = project_path.join("CLAUDE.md");
    if let Err(e) = fs::write(&claude_md_path, claude_md) {
        return Json(CreateProjectResponse {
            status: "error".to_string(),
            project_id: None,
            error: Some(format!("Failed to create CLAUDE.md: {}", e)),
        });
    }

    // Symlink AGENTS.md → CLAUDE.md so Codex reads the same project instructions
    let agents_md_path = project_path.join("AGENTS.md");
    let _ = std::os::unix::fs::symlink("CLAUDE.md", &agents_md_path);

    // The project_id is the path pattern Claude CLI uses
    let project_id = format!("-{}", project_path.to_string_lossy().replace('/', "-").trim_start_matches('-'));

    // Also create the .claude/projects/ directory so it shows up in the API immediately
    let claude_projects_dir = PathBuf::from(&home).join(".claude").join("projects").join(&project_id);
    let _ = fs::create_dir_all(&claude_projects_dir); // Ignore errors - not critical

    Json(CreateProjectResponse {
        status: "ok".to_string(),
        project_id: Some(project_id),
        error: None,
    })
}

#[derive(Deserialize)]
struct SendMessageRequest {
    message: String,
}

#[derive(Serialize)]
struct SimpleResponse {
    status: String,
}

async fn claude_send(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(req): Json<SendMessageRequest>,
) -> Json<SimpleResponse> {
    match state.tmux.send_message(&session_id, &req.message) {
        Ok(()) => {
            // Broadcast message event
            state.broadcast(SseEvent::Message {
                content: req.message,
                role: "user".to_string(),
            });
            Json(SimpleResponse { status: "sent".to_string() })
        }
        Err(e) => Json(SimpleResponse { status: format!("error: {}", e) }),
    }
}

#[derive(Serialize)]
struct UploadResponse {
    status: String,
    path: String,
}

async fn upload_image(headers: HeaderMap, body: Bytes) -> Json<UploadResponse> {
    let upload_dir = PathBuf::from(
        std::env::var("FEATHER_UPLOAD_DIR").unwrap_or_else(|_| "uploads".to_string())
    );
    if let Err(e) = fs::create_dir_all(&upload_dir) {
        return Json(UploadResponse {
            status: format!("error: {}", e),
            path: String::new(),
        });
    }

    // Determine extension from content-type header
    let ext = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|ct| match ct {
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "png",
        })
        .unwrap_or("png");

    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let filename = format!("screenshot-{}.{}", timestamp, ext);
    let filepath = upload_dir.join(&filename);

    match fs::write(&filepath, &body) {
        Ok(()) => Json(UploadResponse {
            status: "ok".to_string(),
            path: filepath.to_string_lossy().to_string(),
        }),
        Err(e) => Json(UploadResponse {
            status: format!("error: {}", e),
            path: String::new(),
        }),
    }
}

async fn upload_file(headers: HeaderMap, body: Bytes) -> Json<UploadResponse> {
    let upload_dir = PathBuf::from(
        std::env::var("FEATHER_UPLOAD_DIR").unwrap_or_else(|_| "uploads".to_string())
    );
    if let Err(e) = fs::create_dir_all(&upload_dir) {
        return Json(UploadResponse {
            status: format!("error: {}", e),
            path: String::new(),
        });
    }

    // Get original filename from header, or generate one
    let original_name = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| urlencoding::decode(s).ok())
        .map(|s| s.into_owned())
        .unwrap_or_else(|| "file".to_string());

    // Determine extension from filename or content-type
    let ext = if let Some(dot_pos) = original_name.rfind('.') {
        original_name[dot_pos + 1..].to_string()
    } else {
        headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|ct| match ct {
                "application/pdf" => "pdf",
                "application/msword" => "doc",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
                "application/vnd.ms-excel" => "xls",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
                "text/plain" => "txt",
                "text/markdown" => "md",
                "application/json" => "json",
                "text/csv" => "csv",
                "image/jpeg" => "jpg",
                "image/png" => "png",
                "image/gif" => "gif",
                "image/webp" => "webp",
                _ => "bin",
            })
            .unwrap_or("bin")
            .to_string()
    };

    // Sanitize filename - remove path separators and dangerous chars
    let safe_name: String = original_name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_' || *c == ' ')
        .collect();
    let safe_name = if safe_name.is_empty() { "file".to_string() } else { safe_name };

    // Add timestamp to prevent collisions
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis();

    // Build filename: timestamp-originalname.ext
    let filename = if safe_name.contains('.') {
        format!("{}-{}", timestamp, safe_name)
    } else {
        format!("{}-{}.{}", timestamp, safe_name, ext)
    };
    let filepath = upload_dir.join(&filename);

    match fs::write(&filepath, &body) {
        Ok(()) => Json(UploadResponse {
            status: "ok".to_string(),
            path: filepath.to_string_lossy().to_string(),
        }),
        Err(e) => Json(UploadResponse {
            status: format!("error: {}", e),
            path: String::new(),
        }),
    }
}

#[derive(Serialize)]
struct TranscribeResponse {
    success: bool,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn transcribe(mut multipart: Multipart) -> Json<TranscribeResponse> {
    let api_key = match std::env::var("FEATHER_OPENAI_API_KEY") {
        Ok(k) => k,
        Err(_) => return Json(TranscribeResponse {
            success: false, text: String::new(),
            error: Some("FEATHER_OPENAI_API_KEY not configured".into()),
        }),
    };

    // Extract the audio file from multipart
    let mut audio_data: Option<Vec<u8>> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            if let Ok(bytes) = field.bytes().await {
                audio_data = Some(bytes.to_vec());
            }
        }
    }

    let audio_bytes = match audio_data {
        Some(b) if !b.is_empty() => b,
        _ => return Json(TranscribeResponse {
            success: false, text: String::new(),
            error: Some("No audio file provided".into()),
        }),
    };

    // Forward to OpenAI Whisper API
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Json(TranscribeResponse {
                success: false,
                text: String::new(),
                error: Some(format!("Failed to build HTTP client: {}", e)),
            });
        }
    };
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name("recording.webm")
        .mime_str("audio/webm")
        .unwrap();
    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-1")
        .part("file", part);

    match client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                let text = json["text"].as_str().unwrap_or("").to_string();
                Json(TranscribeResponse { success: true, text, error: None })
            } else {
                Json(TranscribeResponse {
                    success: false, text: String::new(),
                    error: Some("Failed to parse Whisper response".into()),
                })
            }
        }
        Ok(res) => Json(TranscribeResponse {
            success: false, text: String::new(),
            error: Some(format!("Whisper API error: {}", res.status())),
        }),
        Err(e) => Json(TranscribeResponse {
            success: false, text: String::new(),
            error: Some(format!("Request failed: {}", e)),
        }),
    }
}

// ============================================================================
// Background Title Generation (Haiku)
// ============================================================================

/// Background task: generate titles for sessions.
#[derive(Deserialize)]
struct SignalRequest {
    signal: String,
}

async fn claude_signal(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(req): Json<SignalRequest>,
) -> Json<SimpleResponse> {
    match state.tmux.send_signal(&session_id, &req.signal) {
        Ok(()) => Json(SimpleResponse { status: "sent".to_string() }),
        Err(e) => Json(SimpleResponse { status: format!("error: {}", e) }),
    }
}

async fn claude_kill(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Json<SimpleResponse> {
    state.tmux.kill_session(&session_id);
    Json(SimpleResponse { status: "killed".to_string() })
}

#[derive(Deserialize, Default)]
struct OutputQuery {
    lines: Option<u32>,
}

#[derive(Serialize)]
struct OutputResponse {
    output: String,
}

async fn claude_output(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<OutputQuery>,
) -> Json<OutputResponse> {
    let lines = query.lines.unwrap_or(100);
    let output = state.tmux.capture_output(&session_id, lines);
    Json(OutputResponse { output })
}

#[derive(Serialize)]
struct TmuxSessionInfo {
    name: String,
    session_id: Option<String>,
    status: String,
}

#[derive(Serialize)]
struct ClaudeSessionsResponse {
    tmux_sessions: Vec<TmuxSessionInfo>,
}

async fn claude_sessions(State(state): State<Arc<AppState>>) -> Json<ClaudeSessionsResponse> {
    let pi_sessions = state.pi_sessions.read().await;
    let sessions: Vec<TmuxSessionInfo> = state.tmux.list_tmux_sessions()
        .into_iter()
        .map(|name| {
            let session_id = if name.starts_with("feather-pi-") {
                // For Pi sessions, return first 8 chars of the real Pi UUID
                // so frontend prefix matching links to the normalized session
                pi_sessions.get(&name)
                    .and_then(|info| info.pi_uuid.as_ref().map(|u| u.chars().take(8).collect::<String>()))
                    .or_else(|| Some(name.clone()))
            } else if name.starts_with("feather-codex-") {
                Some(name.clone())
            } else if name.starts_with("feather-") && !name.starts_with("feather-new-") {
                let prefix = name.strip_prefix("feather-").unwrap_or("");
                Some(prefix.to_string())
            } else {
                None
            };
            TmuxSessionInfo {
                name,
                session_id,
                status: "active".to_string(),
            }
        })
        .collect();

    Json(ClaudeSessionsResponse { tmux_sessions: sessions })
}

// ============================================================================
// Terminal Stream Endpoint (polls tmux output)
// ============================================================================

#[derive(Deserialize, Default)]
struct TerminalStreamQuery {
    #[serde(default)]
    lines: Option<u32>,
}

async fn terminal_stream(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<TerminalStreamQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let lines = query.lines.unwrap_or(100);
    let mut last_content = String::new();

    let stream = stream::unfold(
        (state, session_id, last_content, lines),
        |(state, session_id, mut last_content, lines)| async move {
            // Poll every 300ms
            tokio::time::sleep(Duration::from_millis(300)).await;

            let content = state.tmux.capture_output(&session_id, lines);

            if content != last_content && !content.is_empty() {
                // Send full content (not diff) for proper response parsing on frontend
                last_content = content.clone();

                let event = SseEvent::Terminal { data: content };
                let data = serde_json::to_string(&event).unwrap();

                Some((
                    Ok(Event::default().event("terminal").data(data)),
                    (state, session_id, last_content, lines),
                ))
            } else {
                // No change, send keepalive
                Some((
                    Ok(Event::default().comment("keepalive")),
                    (state, session_id, last_content, lines),
                ))
            }
        },
    );

    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ============================================================================
// Interactive Terminal WebSocket
// ============================================================================

async fn terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_terminal_ws(socket, state, session_id))
}

async fn handle_terminal_ws(mut socket: WebSocket, state: Arc<AppState>, session_id: String) {
    let tmux_name = state.tmux.get_session_name(&session_id);
    let mut last_content = String::new();
    let mut interval = tokio::time::interval(Duration::from_millis(200));

    loop {
        tokio::select! {
            // Poll for tmux output changes
            _ = interval.tick() => {
                let content = state.tmux.capture_output(&session_id, 200);
                if content != last_content && !content.is_empty() {
                    last_content = content.clone();
                    if socket.send(Message::Text(content.into())).await.is_err() {
                        break;
                    }
                }
            }
            // Handle incoming messages from client
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        send_to_tmux(&tmux_name, &text);
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if let Ok(text) = String::from_utf8(data.to_vec()) {
                            send_to_tmux(&tmux_name, &text);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

/// Send input to tmux, handling special keys
fn send_to_tmux(tmux_name: &str, text: &str) {
    match text {
        "\r" | "\n" => {
            let _ = std::process::Command::new("tmux")
                .args(["send-keys", "-t", tmux_name, "Enter"])
                .output();
        }
        "\x7f" | "\x08" => {
            let _ = std::process::Command::new("tmux")
                .args(["send-keys", "-t", tmux_name, "BSpace"])
                .output();
        }
        "\x1b" => {
            let _ = std::process::Command::new("tmux")
                .args(["send-keys", "-t", tmux_name, "Escape"])
                .output();
        }
        "\x03" => {
            let _ = std::process::Command::new("tmux")
                .args(["send-keys", "-t", tmux_name, "C-c"])
                .output();
        }
        "\x04" => {
            let _ = std::process::Command::new("tmux")
                .args(["send-keys", "-t", tmux_name, "C-d"])
                .output();
        }
        _ => {
            let _ = std::process::Command::new("tmux")
                .args(["send-keys", "-t", tmux_name, "-l", text])
                .output();
        }
    }
}

// ============================================================================
// JSONL Tail Endpoint (byte-offset based SSE streaming)
// ============================================================================

#[derive(Deserialize, Default)]
struct TailQuery {
    /// Base64-encoded byte offset (opaque cursor for client)
    /// Currently unused - we always start from offset 0 and frontend dedupes by UUID
    #[allow(dead_code)]
    cursor: Option<String>,
}

/// Response structure for each SSE event in the tail stream
#[derive(Serialize)]
struct TailEvent {
    /// Opaque cursor for reconnection (base64-encoded byte offset)
    cursor: String,
    /// Raw JSONL line (unparsed - frontend handles parsing/merging)
    line: serde_json::Value,
}

/// Decode cursor from base64 to byte offset
/// Currently unused - kept for future reconnection support
#[allow(dead_code)]
fn decode_cursor(cursor: &str) -> Option<u64> {
    URL_SAFE_NO_PAD.decode(cursor).ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|s| s.parse().ok())
}

/// Encode byte offset to base64 cursor
fn encode_cursor(offset: u64) -> String {
    URL_SAFE_NO_PAD.encode(offset.to_string())
}

/// Read new content from file starting at byte offset
/// Returns (lines, new_offset) - only complete lines are returned
fn read_from_offset(path: &PathBuf, offset: u64) -> std::io::Result<(Vec<String>, u64)> {
    let mut file = File::open(path)?;
    let file_size = file.metadata()?.len();

    // Nothing new
    if offset >= file_size {
        return Ok((Vec::new(), offset));
    }

    // Seek to offset and read new content
    file.seek(SeekFrom::Start(offset))?;
    let mut buffer = String::new();
    file.read_to_string(&mut buffer)?;

    // Split into lines, keeping only complete ones
    let mut lines: Vec<&str> = buffer.split('\n').collect();

    // If buffer doesn't end with newline, last element is incomplete
    let _incomplete = if !buffer.ends_with('\n') && !lines.is_empty() {
        lines.pop()
    } else {
        // Remove empty string from trailing newline
        if lines.last() == Some(&"") {
            lines.pop();
        }
        None
    };

    // Calculate bytes consumed (only complete lines)
    let bytes_consumed: u64 = lines.iter()
        .map(|l| l.len() as u64 + 1) // +1 for newline
        .sum();

    let new_offset = offset + bytes_consumed;
    let complete_lines: Vec<String> = lines.into_iter()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok((complete_lines, new_offset))
}

async fn tail_session(
    State(state): State<Arc<AppState>>,
    Path((_project_id, session_id)): Path<(String, String)>,
    Query(_query): Query<TailQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // Only use normalized session files
    let file_path = state.session_cache.normalized_dir.join(format!("{}.jsonl", session_id));
    let append_only = session_id.starts_with("feather-codex-") || session_id.starts_with("feather-pi-");

    // Always start from beginning of file - frontend dedupes by UUID
    // This fixes race condition where messages added between history load
    // and SSE start would be missed until the next file rewrite
    let start_offset = 0u64;

    tracing::info!(
        "Starting tail for session {} from offset {}",
        session_id, start_offset
    );

    // Track modification time to detect rewrites
    let initial_mtime = fs::metadata(&file_path)
        .and_then(|m| m.modified())
        .ok();

    let stream = stream::unfold(
        (file_path, start_offset, initial_mtime, false),
        move |(file_path, mut current_offset, mut last_mtime, mut missing_logged)| async move {
            // Poll every 100ms for new content
            tokio::time::sleep(Duration::from_millis(100)).await;

            // If file doesn't exist yet, keep the SSE open and wait
            if !file_path.exists() {
                if !missing_logged {
                    tracing::info!("Tail file not found yet, waiting: {}", file_path.display());
                    missing_logged = true;
                }
                return Some((
                    Ok(Event::default().comment("keepalive")),
                    (file_path, current_offset, last_mtime, missing_logged),
                ));
            } else if missing_logged {
                tracing::info!("Tail file appeared: {}", file_path.display());
                missing_logged = false;
                // Reset to start in case file was just created
                current_offset = 0;
                last_mtime = fs::metadata(&file_path).and_then(|m| m.modified()).ok();
            }

            // Check if file was rewritten (mtime changed)
            if !append_only {
                if let Ok(meta) = fs::metadata(&file_path) {
                    if let Ok(mtime) = meta.modified() {
                        if last_mtime.map_or(true, |last| mtime != last) {
                            // File was rewritten, read entire file from beginning
                            // Frontend will dedupe by UUID
                            tracing::debug!("Normalized file rewritten, reading from start");
                            current_offset = 0;
                            last_mtime = Some(mtime);
                        }
                    }
                }
            } else if last_mtime.is_none() {
                // Set initial mtime for append-only files to avoid unnecessary resets
                last_mtime = fs::metadata(&file_path).and_then(|m| m.modified()).ok();
            }

            match read_from_offset(&file_path, current_offset) {
                Ok((lines, new_offset)) => {
                    current_offset = new_offset;

                    if lines.is_empty() {
                        // No new content, send keepalive comment
                        Some((
                            Ok(Event::default().comment("keepalive")),
                            (file_path, current_offset, last_mtime, missing_logged),
                        ))
                    } else {
                        // Build event with all new lines
                        // Transform normalized format to raw format for frontend compatibility
                        // Normalized: {uuid, role, timestamp, content}
                        // Raw format: {type, uuid, timestamp, message: {role, content}}
                        let events: Vec<TailEvent> = lines.iter()
                            .filter_map(|line| {
                                serde_json::from_str::<serde_json::Value>(line).ok()
                                    .and_then(|parsed| {
                                        if let Some(role) = parsed.get("role").and_then(|v| v.as_str()) {
                                            let content = parsed.get("content").cloned()
                                                .unwrap_or(serde_json::Value::Array(vec![]));
                                            let transformed = serde_json::json!({
                                                "type": role,
                                                "uuid": parsed.get("uuid").cloned().unwrap_or(serde_json::Value::Null),
                                                "timestamp": parsed.get("timestamp").cloned().unwrap_or(serde_json::Value::Null),
                                                "message": {
                                                    "role": role,
                                                    "content": content
                                                }
                                            });
                                            Some(TailEvent {
                                                cursor: encode_cursor(current_offset),
                                                line: transformed,
                                            })
                                        } else {
                                            None
                                        }
                                    })
                            })
                            .collect();

                        if events.is_empty() {
                            Some((
                                Ok(Event::default().comment("keepalive")),
                                (file_path, current_offset, last_mtime, missing_logged),
                            ))
                        } else {
                            let data = serde_json::to_string(&events).unwrap_or_default();
                            Some((
                                Ok(Event::default().event("lines").data(data)),
                                (file_path, current_offset, last_mtime, missing_logged),
                            ))
                        }
                    }
                }
                Err(e) => {
                    // File error - send error event and continue
                    tracing::warn!("Tail read error: {}", e);
                    Some((
                        Ok(Event::default()
                            .event("error")
                            .data(format!("{{\"error\":\"{}\"}}", e))),
                        (file_path, current_offset, last_mtime, missing_logged),
                    ))
                }
            }
        },
    );

    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ============================================================================
// Helper Functions - JSONL parsing and formatting utilities
// ============================================================================

/// Extract a display title from a JSONL session file.
///
/// Priority:
/// 1. Look for a "summary" record (Claude-generated title)
/// 2. Fall back to first user message (truncated to 50 chars)
/// Currently unused - kept for legacy compatibility
#[allow(dead_code)]
fn get_session_title(path: &PathBuf) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;

    for line in content.lines() {
        if let Ok(record) = serde_json::from_str::<JsonlRecord>(line) {
            if record.record_type.as_deref() == Some("summary") {
                if let Some(summary) = record.summary {
                    return Some(summary);
                }
            }
        }
    }

    for line in content.lines() {
        if let Ok(record) = serde_json::from_str::<JsonlRecord>(line) {
            if record.record_type.as_deref() == Some("user") {
                if let Some(msg) = record.message {
                    let text = extract_text_content(&msg.content);
                    if !text.is_empty() {
                        let truncated = if text.len() > 50 {
                            // Find valid UTF-8 boundary
                            let mut end = 50;
                            while end > 0 && !text.is_char_boundary(end) {
                                end -= 1;
                            }
                            format!("{}...", &text[..end])
                        } else {
                            text
                        };
                        return Some(truncated);
                    }
                }
            }
        }
    }

    None
}

/// Extract plain text from a JSONL message content field.
///
/// Claude's content can be:
/// - A simple string
/// - An array of content blocks: [{"type": "text", "text": "..."}, ...]
///
/// This function handles both formats and joins multiple text blocks with newlines.
fn extract_text_content(content: &Option<serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::Array(arr)) => {
            arr.iter()
                .filter_map(|item| {
                    if item.get("type")?.as_str()? == "text" {
                        item.get("text")?.as_str().map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// Extract all content blocks (text, thinking, tool_use, tool_result) from a message.
///
/// Returns structured ContentBlock enums that preserve the full richness of Claude's
/// responses including thinking tokens and tool interactions.
/// Currently unused - kept for legacy compatibility
#[allow(dead_code)]
fn extract_content_blocks(content: &Option<serde_json::Value>) -> Vec<ContentBlock> {
    match content {
        Some(serde_json::Value::Array(arr)) => {
            arr.iter()
                .filter_map(|item| {
                    let block_type = item.get("type")?.as_str()?;
                    match block_type {
                        "text" => {
                            let text = item.get("text")?.as_str()?.to_string();
                            if text.is_empty() { return None; }
                            Some(ContentBlock::Text { text })
                        }
                        "thinking" => {
                            let text = item.get("thinking")?.as_str()?.to_string();
                            if text.is_empty() { return None; }
                            Some(ContentBlock::Thinking { text })
                        }
                        "tool_use" => {
                            let id = item.get("id")?.as_str()?.to_string();
                            let name = item.get("name")?.as_str()?.to_string();
                            let input = item.get("input").cloned().unwrap_or(serde_json::Value::Null);
                            Some(ContentBlock::ToolUse { id, name, input })
                        }
                        "tool_result" => {
                            let tool_use_id = item.get("tool_use_id")?.as_str()?.to_string();
                            let content = item.get("content").cloned().unwrap_or(serde_json::Value::Null);
                            let is_error = item.get("is_error").and_then(|v| v.as_bool());
                            Some(ContentBlock::ToolResult { tool_use_id, content, is_error })
                        }
                        _ => None,
                    }
                })
                .collect()
        }
        Some(serde_json::Value::String(s)) => {
            if s.is_empty() {
                Vec::new()
            } else {
                vec![ContentBlock::Text { text: s.clone() }]
            }
        }
        _ => Vec::new(),
    }
}

/// Format a Unix timestamp as ISO 8601 string (e.g., "2024-01-15T10:30:00Z")
#[allow(dead_code)]
fn chrono_like_format(secs: u64) -> String {
    let datetime = time::OffsetDateTime::from_unix_timestamp(secs as i64).unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        datetime.year(),
        datetime.month() as u8,
        datetime.day(),
        datetime.hour(),
        datetime.minute(),
        datetime.second()
    )
}

// ============================================================================
// Idle Session Reaper
// ============================================================================

/// Find the normalized JSONL file for a tmux session name.
/// Returns the file path if found, along with its last-modified time.
fn find_session_file(normalized_dir: &PathBuf, tmux_name: &str) -> Option<PathBuf> {
    if tmux_name.starts_with("feather-new-") || tmux_name.starts_with("feather-codex-") || tmux_name.starts_with("feather-pi-") {
        // These use timestamps as IDs — try to find via normalized dir glob
        // The session ID prefix won't match, so we return None and fall back to tmux age
        None
    } else if let Some(prefix) = tmux_name.strip_prefix("feather-") {
        // Claude resumed sessions: feather-{first8} → ~/sessions/{first8}*.jsonl
        if let Ok(entries) = fs::read_dir(normalized_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with(prefix) && name_str.ends_with(".jsonl") {
                    return Some(entry.path());
                }
            }
        }
        None
    } else {
        None
    }
}

/// Reap tmux sessions that have been idle for longer than `threshold`.
///
/// "Idle" means the normalized JSONL file hasn't been modified within the threshold.
/// For sessions where we can't find a JSONL file, we use the tmux session creation time.
async fn reap_idle_sessions(state: &Arc<AppState>, threshold: Duration) {
    let sessions = state.tmux.list_tmux_sessions();
    if sessions.is_empty() {
        return;
    }

    let now = SystemTime::now();

    // Build a set of pi_uuid -> tmux_name mappings for pi sessions
    let pi_uuids: HashMap<String, String> = {
        let pi_sessions = state.pi_sessions.read().await;
        pi_sessions.iter()
            .filter_map(|(tmux_name, info)| {
                info.pi_uuid.as_ref().map(|uuid| (tmux_name.clone(), uuid.clone()))
            })
            .collect()
    };

    for tmux_name in &sessions {
        // Try to find the normalized JSONL file
        let jsonl_path = if let Some(uuid) = pi_uuids.get(tmux_name) {
            // Pi session with known UUID
            let path = state.session_cache.normalized_dir.join(format!("{}.jsonl", uuid));
            if path.exists() { Some(path) } else { None }
        } else {
            find_session_file(&state.session_cache.normalized_dir, tmux_name)
        };

        let is_idle = if let Some(path) = jsonl_path {
            // Check file modification time
            match fs::metadata(&path) {
                Ok(meta) => match meta.modified() {
                    Ok(mtime) => now.duration_since(mtime).unwrap_or_default() > threshold,
                    Err(_) => false, // Can't determine mtime, don't kill
                },
                Err(_) => false,
            }
        } else {
            // No JSONL file found — use tmux session creation time as fallback
            let output = std::process::Command::new("tmux")
                .args(["display-message", "-t", tmux_name, "-p", "#{session_created}"])
                .output();
            match output {
                Ok(o) if o.status.success() => {
                    let created_str = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if let Ok(created_ts) = created_str.parse::<u64>() {
                        let created = SystemTime::UNIX_EPOCH + Duration::from_secs(created_ts);
                        now.duration_since(created).unwrap_or_default() > threshold
                    } else {
                        false
                    }
                }
                _ => false,
            }
        };

        if is_idle {
            tracing::info!("Reaping idle tmux session: {}", tmux_name);

            // Extract the session_id to clean up internal tracking
            if tmux_name.starts_with("feather-pi-") {
                let mut pi_sessions = state.pi_sessions.write().await;
                pi_sessions.remove(tmux_name);
            } else if tmux_name.starts_with("feather-codex-") {
                let mut codex_sessions = state.codex_sessions.write().await;
                codex_sessions.remove(tmux_name);
            }

            // Kill the tmux session directly (session_id -> tmux_name mapping varies)
            let _ = std::process::Command::new("tmux")
                .args(["kill-session", "-t", tmux_name])
                .output();

            // Note: TmuxManager.active_sessions may still have a stale entry for claude
            // sessions, but is_session_active() checks tmux directly so it'll be correct.
        }
    }
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env()
            .add_directive("feather_rs=info".parse().unwrap())
            .add_directive("tower_http=info".parse().unwrap()))
        .init();

    let (event_tx, _) = broadcast::channel::<(u64, SseEvent)>(100);

    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    let sessions_dir = PathBuf::from(&home).join(".claude").join("projects");
    let default_cwd = std::env::var("DEFAULT_CWD").unwrap_or_else(|_| format!("{}/projects/code", &home));

    // Normalized sessions directory
    let normalized_dir = PathBuf::from(&home).join("sessions");
    let memory_file = PathBuf::from(&home).join("memory").join("memory.jsonl");

    // Create normalized sessions cache
    let session_cache = SessionCache::new(normalized_dir.clone(), memory_file.clone());

    // Rebuild Pi tmux→UUID mapping from existing session files
    let pi_session_map: HashMap<String, PiSessionInfo> = {
        let mut map = HashMap::new();
        let pi_dir = PathBuf::from(&home).join(".pi").join("agent").join("sessions");
        if pi_dir.exists() {
            if let Ok(cwd_entries) = fs::read_dir(&pi_dir) {
                for cwd_entry in cwd_entries.flatten() {
                    if !cwd_entry.path().is_dir() { continue; }
                    if let Ok(files) = fs::read_dir(cwd_entry.path()) {
                        for file in files.flatten() {
                            let path = file.path();
                            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                            if !stem.starts_with("feather-pi-") { continue; }
                            if let Ok(content) = fs::read_to_string(&path) {
                                if let Some(first_line) = content.lines().next() {
                                    if let Ok(header) = serde_json::from_str::<serde_json::Value>(first_line) {
                                        if let Some(uuid) = header.get("id").and_then(|i| i.as_str()) {
                                            let cwd = header.get("cwd").and_then(|c| c.as_str()).unwrap_or("").to_string();
                                            map.insert(stem.to_string(), PiSessionInfo {
                                                project_id: project_id_from_path(&cwd),
                                                cwd,
                                                pi_uuid: Some(uuid.to_string()),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        tracing::info!("Rebuilt {} Pi session mappings", map.len());
        map
    };

    let (deploy_tx, _) = broadcast::channel::<deploy::DeployEvent>(100);
    let is_admin = deploy::is_admin();

    let title_trigger = titles::create_trigger();
    let state = Arc::new(AppState {
        start_time: Instant::now(),
        event_tx,
        seq: std::sync::atomic::AtomicU64::new(1),
        sessions_dir: sessions_dir.clone(),
        deploy_tx,
        is_admin,
        default_cwd: default_cwd.clone(),
        tmux: TmuxManager::new(default_cwd),
        session_cache: session_cache.clone(),
        codex_sessions: RwLock::new(HashMap::new()),
        pi_sessions: RwLock::new(pi_session_map),
        title_trigger: title_trigger.clone(),
    });

    // Load API key for Haiku (memory extraction & title generation)
    let api_key = std::env::var("FEATHER_ANTHROPIC_API_KEY").ok();

    // Start session normalizer (watches ~/.claude/projects/, ~/.codex/sessions/, ~/.pi/agent/sessions/)
    let normalizer_cache = session_cache.clone();
    let codex_sessions_dir = PathBuf::from(&home).join(".codex").join("sessions");
    let pi_sessions_dir = PathBuf::from(&home).join(".pi").join("agent").join("sessions");
    let normalizer_config = normalizer::WatchConfig {
        claude_projects_dir: sessions_dir,
        codex_sessions_dir,
        pi_sessions_dir,
        normalized_dir,
    };
    tokio::spawn(async move {
        normalizer::start(normalizer_cache, normalizer_config).await;
    });

    // Start memory extractor (if API key available)
    if let Some(ref key) = api_key {
        let memory_cache = session_cache.clone();
        let memory_key = key.clone();
        tokio::spawn(async move {
            memory::start(memory_cache, memory_key).await;
        });
        tracing::info!("Memory extraction enabled");
    } else {
        tracing::warn!("FEATHER_ANTHROPIC_API_KEY not set, memory extraction disabled");
    }

    // Start title generator (if API key available)
    if let Some(ref key) = api_key {
        let titles_cache = session_cache.clone();
        let titles_key = key.clone();
        let titles_trigger = title_trigger.clone();
        tokio::spawn(async move {
            titles::start(titles_cache, titles_key, titles_trigger).await;
        });
        tracing::info!("Title generation enabled");
    }

    // Spawn heartbeat broadcaster
    let heartbeat_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            heartbeat_state.broadcast(SseEvent::Heartbeat {
                timestamp: SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            });
        }
    });

    // Spawn idle session reaper (checks every 5 minutes, kills sessions idle > 1 hour)
    let reaper_state = state.clone();
    tokio::spawn(async move {
        const CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);
        const IDLE_THRESHOLD: Duration = Duration::from_secs(60 * 60);

        // Wait before first check
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            reap_idle_sessions(&reaper_state, IDLE_THRESHOLD).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });

    // Build router
    let app = Router::new()
        // Health
        .route("/health", get(health))
        // SSE
        .route("/api/stream", get(stream_events))
        // Projects & Sessions
        .route("/api/projects", get(list_projects))
        .route("/api/dashboards", get(list_dashboards))
        .route("/api/projects/{project_id}/sessions", get(list_sessions))
        .route("/api/projects/{project_id}/sessions/{session_id}/history", get(get_session_history))
        // Claude/tmux management
        .route("/api/claude-auth-status", get(claude_auth_status))
        .route("/api/claude-status/{session_id}", get(claude_status))
        .route("/api/claude-spawn/{session_id}", post(claude_spawn))
        .route("/api/claude-new", post(claude_new))
        .route("/api/create-project", post(create_project))
        .route("/api/claude-send/{session_id}", post(claude_send))
        .route("/api/claude-signal/{session_id}", post(claude_signal))
        .route("/api/claude-kill/{session_id}", delete(claude_kill))
        .route("/api/claude-output/{session_id}", get(claude_output))
        .route("/api/claude-sessions", get(claude_sessions))
        // Codex CLI
        .route("/api/codex-status/{session_id}", get(codex_status))
        .route("/api/codex-new", post(codex_new))
        .route("/api/codex-send/{session_id}", post(codex_send))
        // Pi coding agent
        .route("/api/pi-status/{session_id}", get(pi_status))
        .route("/api/pi-new", post(pi_new))
        .route("/api/pi-send/{session_id}", post(pi_send))
        .route("/api/pi-resolve/{tmux_name}", get(pi_resolve))
        // Deploy management
        .route("/api/deploy/status", get(deploy::deploy_status))
        .route("/api/deploy/stream", get(deploy::deploy_stream))
        .route("/api/deploy/supervisor", post(deploy::supervisor_deploy))
        .route("/api/deploy/supervisor/rollback", post(deploy::supervisor_rollback))
        .route("/api/deploy/app", post(deploy::app_deploy))
        .route("/api/deploy/app/rollback", post(deploy::app_rollback))
        .route("/api/deploy/container", post(deploy::container_deploy))
        .route("/api/deploy/container/rollback", post(deploy::container_rollback))
        // File upload & transcription (10MB limit)
        .route("/api/upload-image", post(upload_image))
        .route("/api/upload-file", post(upload_file))
        .route("/api/transcribe", post(transcribe))
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024))
        // Terminal stream (SSE - read only)
        .route("/api/terminal/{session_id}", get(terminal_stream))
        // Interactive terminal WebSocket
        .route("/ws/terminal/{session_id}", get(terminal_ws))
        // JSONL tail stream (byte-offset based)
        .route("/api/tail/{project_id}/{session_id}", get(tail_session))
        // Serve uploaded files
        .nest_service("/uploads", ServeDir::new("uploads"))
        // Static files
        .fallback_service(ServeDir::new("static").append_index_html_on_directories(true))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4850);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Feather-rs v{} listening on {}", env!("CARGO_PKG_VERSION"), addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

//! Session normalizer - watches source directories and produces normalized sessions.
//!
//! Watches:
//! - ~/.claude/projects/*/*.jsonl (Claude Code main sessions)
//! - ~/.claude/projects/*/{session_id}/subagents/*.jsonl (Claude Code subagents)
//! - ~/.codex/sessions/YYYY/MM/DD/*.jsonl (Codex CLI sessions)
//!
//! Produces:
//! - ~/sessions/{session_id}.jsonl (normalized, merged sessions)
//!
//! ## Latency
//! - Active sessions: ~100ms debounce + processing time
//! - Goal: All downstream code should read from normalized files, not raw Claude files

use crate::codex;
use crate::pi;
use crate::sessions::{
    ContentBlock, NormalizedMessage, NormalizedSession, SessionCache, SessionMeta,
};
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEvent, DebouncedEventKind};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

/// Debounce duration for file changes
/// Lower = faster updates for active sessions, but more CPU usage
const DEBOUNCE_MS: u64 = 100;

/// Sessions modified within this window are considered "active"
const ACTIVE_SESSION_WINDOW_SECS: u64 = 60;

/// Track session activity for potential future optimizations
#[derive(Default)]
pub struct ActivityTracker {
    last_modified: HashMap<String, Instant>,
}

impl ActivityTracker {
    pub fn mark_active(&mut self, session_id: &str) {
        self.last_modified.insert(session_id.to_string(), Instant::now());
    }

    #[allow(dead_code)]
    pub fn is_active(&self, session_id: &str) -> bool {
        self.last_modified
            .get(session_id)
            .map(|t| t.elapsed().as_secs() < ACTIVE_SESSION_WINDOW_SECS)
            .unwrap_or(false)
    }

    #[allow(dead_code)]
    pub fn cleanup_stale(&mut self) {
        self.last_modified.retain(|_, t| t.elapsed().as_secs() < ACTIVE_SESSION_WINDOW_SECS * 2);
    }
}

/// Source directories to watch
pub struct WatchConfig {
    /// Claude Code projects dir: ~/.claude/projects/
    pub claude_projects_dir: PathBuf,
    /// Codex CLI sessions dir: ~/.codex/sessions/
    pub codex_sessions_dir: PathBuf,
    /// Pi coding agent sessions dir: ~/.pi/agent/sessions/
    pub pi_sessions_dir: PathBuf,
    /// Output directory for normalized sessions: ~/sessions/
    pub normalized_dir: PathBuf,
}

impl Default for WatchConfig {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
        Self {
            claude_projects_dir: PathBuf::from(&home).join(".claude").join("projects"),
            codex_sessions_dir: PathBuf::from(&home).join(".codex").join("sessions"),
            pi_sessions_dir: PathBuf::from(&home).join(".pi").join("agent").join("sessions"),
            normalized_dir: PathBuf::from(&home).join("sessions"),
        }
    }
}

/// Start the normalizer background task
pub async fn start(cache: Arc<SessionCache>, config: WatchConfig) {
    info!("Starting session normalizer (debounce: {}ms)", DEBOUNCE_MS);

    // Activity tracker for monitoring which sessions are "hot"
    let activity = Arc::new(RwLock::new(ActivityTracker::default()));

    // Ensure output directory exists
    if let Err(e) = fs::create_dir_all(&config.normalized_dir) {
        error!("Failed to create normalized dir: {}", e);
        return;
    }

    // Initial scan (Claude + Codex)
    info!("Performing initial session scan...");
    if let Err(e) = initial_scan(&cache, &config).await {
        error!("Initial scan failed: {}", e);
    }

    // Use tokio mpsc channel - blocking_send works from std::thread
    let (tx, mut rx) = tokio::sync::mpsc::channel::<PathBuf>(100);

    // Start Claude file watcher (create directory if needed so watcher is always ready)
    let claude_watch_path = config.claude_projects_dir.clone();
    if !claude_watch_path.exists() {
        let _ = fs::create_dir_all(&claude_watch_path);
        info!("Created Claude projects directory: {}", claude_watch_path.display());
    }
    let claude_tx = tx.clone();
    std::thread::spawn(move || {
        let mut debouncer = match new_debouncer(Duration::from_millis(DEBOUNCE_MS), move |res: Result<Vec<DebouncedEvent>, notify::Error>| {
            match &res {
                Ok(events) => {
                    debug!("Claude watcher received {} events", events.len());
                    for event in events {
                        debug!("Event: {:?} for {:?}", event.kind, event.path);
                        if let DebouncedEventKind::Any = event.kind {
                            let path: PathBuf = event.path.clone();
                            if let Err(e) = claude_tx.blocking_send(path.clone()) {
                                error!("Failed to send file event: {}", e);
                            } else {
                                debug!("Sent file event for: {}", path.display());
                            }
                        }
                    }
                }
                Err(e) => {
                    error!("Claude file watcher error: {:?}", e);
                }
            }
        }) {
            Ok(d) => d,
            Err(e) => {
                error!("Failed to create Claude file watcher: {}", e);
                return;
            }
        };

        if let Err(e) = debouncer.watcher().watch(&claude_watch_path, RecursiveMode::Recursive) {
            error!("Failed to watch Claude directory: {}", e);
            return;
        }

        info!("Watching {} for Claude changes", claude_watch_path.display());

        // Keep thread alive
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    });

    // Start Codex file watcher (create directory if needed so watcher is always ready)
    let codex_watch_path = config.codex_sessions_dir.clone();
    if !codex_watch_path.exists() {
        let _ = fs::create_dir_all(&codex_watch_path);
        info!("Created Codex sessions directory: {}", codex_watch_path.display());
    }
    if codex_watch_path.exists() {
        let codex_tx = tx.clone();
        std::thread::spawn(move || {
            let mut debouncer = match new_debouncer(Duration::from_millis(DEBOUNCE_MS), move |res: Result<Vec<DebouncedEvent>, notify::Error>| {
                match &res {
                    Ok(events) => {
                        debug!("Codex watcher received {} events", events.len());
                        for event in events {
                            debug!("Codex event: {:?} for {:?}", event.kind, event.path);
                            if let DebouncedEventKind::Any = event.kind {
                                let path: PathBuf = event.path.clone();
                                if let Err(e) = codex_tx.blocking_send(path.clone()) {
                                    error!("Failed to send Codex file event: {}", e);
                                } else {
                                    debug!("Sent Codex file event for: {}", path.display());
                                }
                            }
                        }
                    }
                    Err(e) => {
                        error!("Codex file watcher error: {:?}", e);
                    }
                }
            }) {
                Ok(d) => d,
                Err(e) => {
                    error!("Failed to create Codex file watcher: {}", e);
                    return;
                }
            };

            if let Err(e) = debouncer.watcher().watch(&codex_watch_path, RecursiveMode::Recursive) {
                error!("Failed to watch Codex directory: {}", e);
                return;
            }

            info!("Watching {} for Codex changes", codex_watch_path.display());

            // Keep thread alive
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        });
    } else {
        info!("Codex sessions directory not found, skipping Codex watcher: {}", codex_watch_path.display());
    }

    // Start Pi file watcher (create directory if needed so watcher is always ready)
    let pi_watch_path = config.pi_sessions_dir.clone();
    if !pi_watch_path.exists() {
        let _ = fs::create_dir_all(&pi_watch_path);
        info!("Created Pi sessions directory: {}", pi_watch_path.display());
    }
    if pi_watch_path.exists() {
        let pi_tx = tx.clone();
        std::thread::spawn(move || {
            let mut debouncer = match new_debouncer(Duration::from_millis(DEBOUNCE_MS), move |res: Result<Vec<DebouncedEvent>, notify::Error>| {
                match &res {
                    Ok(events) => {
                        debug!("Pi watcher received {} events", events.len());
                        for event in events {
                            debug!("Pi event: {:?} for {:?}", event.kind, event.path);
                            if let DebouncedEventKind::Any = event.kind {
                                let path: PathBuf = event.path.clone();
                                if let Err(e) = pi_tx.blocking_send(path.clone()) {
                                    error!("Failed to send Pi file event: {}", e);
                                } else {
                                    debug!("Sent Pi file event for: {}", path.display());
                                }
                            }
                        }
                    }
                    Err(e) => {
                        error!("Pi file watcher error: {:?}", e);
                    }
                }
            }) {
                Ok(d) => d,
                Err(e) => {
                    error!("Failed to create Pi file watcher: {}", e);
                    return;
                }
            };

            if let Err(e) = debouncer.watcher().watch(&pi_watch_path, RecursiveMode::Recursive) {
                error!("Failed to watch Pi directory: {}", e);
                return;
            }

            info!("Watching {} for Pi changes", pi_watch_path.display());

            // Keep thread alive
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        });
    } else {
        info!("Pi sessions directory not found, skipping Pi watcher: {}", pi_watch_path.display());
    }

    // Process file change events from all watchers
    info!("Normalizer ready to receive file change events");
    while let Some(path) = rx.recv().await {
        let path: PathBuf = path;
        debug!("Received file change event: {}", path.display());
        if path.extension().map_or(false, |e| e == "jsonl") {
            debug!("Processing JSONL file change: {}", path.display());

            // Determine source: Pi, Codex, or Claude
            let path_str = path.to_string_lossy();
            let is_pi = path_str.contains(".pi/agent/sessions");
            let is_codex = path_str.contains(".codex/sessions");

            let session_id: Option<String> = if is_pi {
                process_pi_file(&cache, &config, &path)
                    .await
                    .map_err(|e| warn!("Error processing Pi {}: {}", path.display(), e))
                    .ok()
                    .flatten()
            } else if is_codex {
                process_codex_file(&cache, &config, &path)
                    .await
                    .map_err(|e| warn!("Error processing Codex {}: {}", path.display(), e))
                    .ok()
                    .flatten()
            } else {
                process_changed_file(&cache, &config, &path)
                    .await
                    .map_err(|e| warn!("Error processing {}: {}", path.display(), e))
                    .ok()
                    .flatten()
            };

            if let Some(sid) = session_id {
                activity.write().await.mark_active(&sid);
                debug!("Normalized session: {}", sid);
            }
        }
    }
    warn!("Normalizer event loop exited!");
}

/// Initial scan of all existing sessions (Claude + Codex)
async fn initial_scan(cache: &Arc<SessionCache>, config: &WatchConfig) -> Result<(), Box<dyn std::error::Error>> {
    let mut session_count = 0;

    // Scan Claude sessions
    let projects_dir = &config.claude_projects_dir;
    if projects_dir.exists() {
        for project_entry in fs::read_dir(projects_dir)? {
            let project_entry = project_entry?;
            let project_path = project_entry.path();

            if !project_path.is_dir() {
                continue;
            }

            let project_id = project_path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            // Scan for session JSONL files
            for entry in fs::read_dir(&project_path)? {
                let entry = entry?;
                let path = entry.path();

                if path.extension().map_or(false, |e| e == "jsonl") {
                    if let Some(session_id) = path.file_stem().and_then(|n| n.to_str()) {
                        // Skip if it looks like a subagent file
                        if session_id.starts_with("agent-") {
                            continue;
                        }

                        match normalize_session(config, &project_id, session_id).await {
                            Ok(session) => {
                                cache.upsert(session);
                                session_count += 1;
                            }
                            Err(e) => {
                                debug!("Skipping session {}: {}", session_id, e);
                            }
                        }
                    }
                }
            }
        }
    } else {
        warn!("Claude projects directory does not exist: {}", projects_dir.display());
    }

    // Scan Codex sessions
    let codex_count = scan_codex_sessions(cache, config).await?;
    session_count += codex_count;

    // Scan Pi sessions
    let pi_count = scan_pi_sessions(cache, config).await?;
    session_count += pi_count;

    info!("Initial scan complete: {} sessions loaded ({} Codex, {} Pi)", session_count, codex_count, pi_count);
    Ok(())
}

/// Scan Codex sessions directory (walks YYYY/MM/DD structure)
async fn scan_codex_sessions(cache: &Arc<SessionCache>, config: &WatchConfig) -> Result<usize, Box<dyn std::error::Error>> {
    let codex_dir = &config.codex_sessions_dir;
    if !codex_dir.exists() {
        debug!("Codex sessions directory does not exist: {}", codex_dir.display());
        return Ok(0);
    }

    let mut count = 0;

    // Walk YYYY/MM/DD directory structure
    for year_entry in fs::read_dir(codex_dir)? {
        let year_path = year_entry?.path();
        if !year_path.is_dir() { continue; }

        for month_entry in fs::read_dir(&year_path)? {
            let month_path = month_entry?.path();
            if !month_path.is_dir() { continue; }

            for day_entry in fs::read_dir(&month_path)? {
                let day_path = day_entry?.path();
                if !day_path.is_dir() { continue; }

                // Scan JSONL files in day directory
                for file_entry in fs::read_dir(&day_path)? {
                    let file_path = file_entry?.path();
                    if file_path.extension().map_or(false, |e| e == "jsonl") {
                        if let Some(_session_id) = process_codex_file(cache, config, &file_path)
                            .await
                            .map_err(|e| debug!("Skipping Codex session: {}", e))
                            .ok()
                            .flatten()
                        {
                            count += 1;
                        }
                    }
                }
            }
        }
    }

    Ok(count)
}

/// Process a Codex JSONL file and normalize it
async fn process_codex_file(
    cache: &Arc<SessionCache>,
    config: &WatchConfig,
    path: &Path,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    // Parse Codex session
    let (codex_meta, messages) = codex::parse_codex_session(path)
        .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;

    if messages.is_empty() {
        return Ok(None);
    }

    // Derive project_id from cwd
    let project_id = if codex_meta.cwd.is_empty() {
        "codex".to_string()
    } else {
        project_id_from_path(&codex_meta.cwd)
    };

    // Create normalized session
    let mut meta = codex::to_session_meta(&codex_meta, &project_id, messages.len());

    // Update timestamps from messages
    if let Some(first) = messages.first() {
        meta.created_at = first.timestamp.clone();
    }
    if let Some(last) = messages.last() {
        meta.updated_at = last.timestamp.clone();
    }

    // Write normalized file
    let normalized_path = config.normalized_dir.join(format!("{}.jsonl", codex_meta.id));
    write_normalized_file(&normalized_path, &messages)?;

    let session = NormalizedSession {
        meta,
        messages,
        normalized_path,
    };

    let session_id = session.meta.id.clone();
    cache.upsert(session);

    Ok(Some(session_id))
}

/// Scan Pi sessions directory (walks <cwd-encoded>/<session-dir>/ structure)
async fn scan_pi_sessions(cache: &Arc<SessionCache>, config: &WatchConfig) -> Result<usize, Box<dyn std::error::Error>> {
    let pi_dir = &config.pi_sessions_dir;
    if !pi_dir.exists() {
        debug!("Pi sessions directory does not exist: {}", pi_dir.display());
        return Ok(0);
    }

    let mut count = 0;

    // Walk <cwd-encoded>/<timestamp>_<uuid>.jsonl structure
    // Pi stores session files directly as JSONL in cwd-encoded directories
    for cwd_entry in fs::read_dir(pi_dir)? {
        let cwd_path = cwd_entry?.path();
        if !cwd_path.is_dir() { continue; }

        for file_entry in fs::read_dir(&cwd_path)? {
            let file_path = file_entry?.path();
            if file_path.extension().map_or(false, |e| e == "jsonl") {
                if let Some(_session_id) = process_pi_file(cache, config, &file_path)
                    .await
                    .map_err(|e| debug!("Skipping Pi session: {}", e))
                    .ok()
                    .flatten()
                {
                    count += 1;
                }
            }
        }
    }

    Ok(count)
}

/// Process a Pi JSONL file and normalize it
async fn process_pi_file(
    cache: &Arc<SessionCache>,
    config: &WatchConfig,
    path: &Path,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    // Parse Pi session
    let (pi_meta, messages) = pi::parse_pi_session(path)
        .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;

    if messages.is_empty() {
        return Ok(None);
    }

    // Derive project_id from cwd
    let project_id = if pi_meta.cwd.is_empty() {
        "pi".to_string()
    } else {
        project_id_from_path(&pi_meta.cwd)
    };

    // Create normalized session
    let mut meta = pi::to_session_meta(&pi_meta, &project_id, messages.len());

    // Update timestamps from messages
    if let Some(first) = messages.first() {
        meta.created_at = first.timestamp.clone();
    }
    if let Some(last) = messages.last() {
        meta.updated_at = last.timestamp.clone();
    }

    // Write normalized file
    let normalized_path = config.normalized_dir.join(format!("{}.jsonl", pi_meta.id));
    write_normalized_file(&normalized_path, &messages)?;

    let session = NormalizedSession {
        meta,
        messages,
        normalized_path,
    };

    let session_id = session.meta.id.clone();
    cache.upsert(session);

    Ok(Some(session_id))
}

/// Convert a path to Claude-style project ID
fn project_id_from_path(path: &str) -> String {
    let trimmed = path.trim();
    let normalized = if trimmed.is_empty() { "/" } else { trimmed };
    format!("-{}", normalized.replace('/', "-").trim_start_matches('-'))
}

/// Process a changed JSONL file
/// Returns the session_id if successfully processed, None if skipped
async fn process_changed_file(
    cache: &Arc<SessionCache>,
    config: &WatchConfig,
    path: &Path,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    // Extract project and session ID from path
    // Path format: ~/.claude/projects/{project_id}/{session_id}.jsonl
    // Or subagent: ~/.claude/projects/{project_id}/{session_id}/subagents/{agent}.jsonl

    let components: Vec<_> = path.components().collect();

    // Find the project ID (after "projects")
    let project_idx = components.iter().position(|c| {
        c.as_os_str().to_str().map_or(false, |s| s == "projects")
    });

    let (project_id, session_id) = match project_idx {
        Some(idx) if idx + 2 < components.len() => {
            let project = components[idx + 1].as_os_str().to_str().unwrap_or("unknown");

            // Check if this is a subagent file
            if components.iter().any(|c| c.as_os_str().to_str() == Some("subagents")) {
                // Subagent: get session ID from parent directory
                let session = components[idx + 2].as_os_str().to_str().unwrap_or("unknown");
                (project.to_string(), session.to_string())
            } else {
                // Main session file
                let session = path.file_stem()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown");
                (project.to_string(), session.to_string())
            }
        }
        _ => return Ok(None),
    };

    // Skip agent files at root level
    if session_id.starts_with("agent-") {
        return Ok(None);
    }

    debug!("Normalizing session {} in project {}", session_id, project_id);

    let session = normalize_session(config, &project_id, &session_id).await?;
    let sid = session.meta.id.clone();
    cache.upsert(session);

    Ok(Some(sid))
}

/// Normalize a session by merging main file + subagents
async fn normalize_session(
    config: &WatchConfig,
    project_id: &str,
    session_id: &str,
) -> Result<NormalizedSession, Box<dyn std::error::Error>> {
    let project_dir = config.claude_projects_dir.join(project_id);
    let main_file = project_dir.join(format!("{}.jsonl", session_id));
    let subagents_dir = project_dir.join(session_id).join("subagents");

    if !main_file.exists() {
        return Err(format!("Main session file not found: {}", main_file.display()).into());
    }

    // Parse main session file
    let mut messages: HashMap<String, NormalizedMessage> = HashMap::new();
    let mut meta = SessionMeta {
        id: session_id.to_string(),
        project: project_id.to_string(),
        title: None,
        created_at: String::new(),
        updated_at: String::new(),
        message_count: 0,
        last_memory_uuid: None,
        source: "claude".to_string(),
    };

    // Read main file
    parse_jsonl_file(&main_file, &mut messages, &mut meta)?;

    // Read subagent files if they exist (skip suggestion subagents entirely)
    if subagents_dir.exists() {
        if let Ok(entries) = fs::read_dir(&subagents_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |e| e == "jsonl") {
                    let filename = path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    // Suggestion subagent files contain only the suggestion prompt
                    // and short autocomplete output - never useful for session view
                    if filename.contains("suggestion") {
                        continue;
                    }
                    if let Err(e) = parse_jsonl_file(&path, &mut messages, &mut meta) {
                        debug!("Error parsing subagent file {}: {}", path.display(), e);
                    }
                }
            }
        }
    }

    // Sort messages by timestamp
    let mut messages: Vec<_> = messages.into_values().collect();
    messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    // Skip sessions with no messages
    if messages.is_empty() {
        return Err("Session has no messages".into());
    }

    meta.message_count = messages.len();
    if let Some(first) = messages.first() {
        meta.created_at = first.timestamp.clone();
    }
    if let Some(last) = messages.last() {
        meta.updated_at = last.timestamp.clone();
    }

    // Write normalized file
    let normalized_path = config.normalized_dir.join(format!("{}.jsonl", session_id));
    write_normalized_file(&normalized_path, &messages)?;

    Ok(NormalizedSession {
        meta,
        messages,
        normalized_path,
    })
}

/// Parse a JSONL file and add messages to the map.
/// Filters out internal/synthetic messages using metadata fields:
/// - isSidechain: true (suggestion subagent context, sidechained responses)
/// - isCompactSummary: true (auto-compaction summary injections)
/// - isVisibleInTranscriptOnly: true (internal-only messages not meant for session view)
/// Also chains: assistant responses to filtered messages are themselves filtered.
fn parse_jsonl_file(
    path: &Path,
    messages: &mut HashMap<String, NormalizedMessage>,
    meta: &mut SessionMeta,
) -> Result<(), Box<dyn std::error::Error>> {
    let file_content = std::fs::read_to_string(path)?;
    let lines: Vec<&str> = file_content.lines().filter(|l| !l.is_empty()).collect();

    // Track UUIDs of filtered messages so we can also skip their response chains
    let mut skip_chain_uuids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in &lines {
        let record: serde_json::Value = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let record_type = record.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Only process user and assistant messages
        if record_type != "user" && record_type != "assistant" {
            if record_type == "summary" {
                if let Some(summary) = record.get("summary").and_then(|v| v.as_str()) {
                    meta.title = Some(summary.to_string());
                }
            }
            continue;
        }

        let uuid = match record.get("uuid").and_then(|v| v.as_str()) {
            Some(u) => u.to_string(),
            None => continue,
        };

        // Skip sidechain messages (suggestion subagent context, branched responses)
        if record.get("isSidechain").and_then(|v| v.as_bool()).unwrap_or(false) {
            skip_chain_uuids.insert(uuid.clone());
            continue;
        }

        // Skip compaction/summary injections (metadata-based, no content matching needed)
        if record.get("isCompactSummary").and_then(|v| v.as_bool()).unwrap_or(false)
            || record.get("isVisibleInTranscriptOnly").and_then(|v| v.as_bool()).unwrap_or(false)
        {
            skip_chain_uuids.insert(uuid.clone());
            debug!("Skipping compaction/internal message from {}", path.display());
            continue;
        }

        // Skip assistant responses to filtered messages (chain propagation)
        if record_type == "assistant" {
            if let Some(parent) = record.get("parentUuid").and_then(|v| v.as_str()) {
                if skip_chain_uuids.contains(parent) {
                    skip_chain_uuids.insert(uuid.clone());
                    debug!("Skipping filtered response from {}", path.display());
                    continue;
                }
            }
        }

        let timestamp = record.get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let content = extract_content_blocks(&record);
        if content.is_empty() {
            continue;
        }

        let role = record.get("message")
            .and_then(|m| m.get("role"))
            .and_then(|r| r.as_str())
            .unwrap_or(record_type)
            .to_string();

        let source_file = path.file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        // Insert or update (later messages with same UUID win)
        messages.insert(uuid.clone(), NormalizedMessage {
            uuid,
            role,
            timestamp,
            content,
            source_file,
        });
    }

    Ok(())
}

/// Extract content blocks from a JSONL record
fn extract_content_blocks(record: &serde_json::Value) -> Vec<ContentBlock> {
    let content = match record.get("message").and_then(|m| m.get("content")) {
        Some(c) => c,
        None => return vec![],
    };

    match content {
        serde_json::Value::Array(arr) => {
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
                            let thinking = item.get("thinking")?.as_str()?.to_string();
                            if thinking.is_empty() { return None; }
                            Some(ContentBlock::Thinking { thinking })
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
                        "image" => {
                            let source = item.get("source").and_then(|s| {
                                Some(crate::sessions::ImageSource {
                                    source_type: s.get("type")?.as_str()?.to_string(),
                                    media_type: s.get("media_type")?.as_str()?.to_string(),
                                    data: s.get("data")?.as_str()?.to_string(),
                                })
                            });
                            Some(ContentBlock::Image { source })
                        }
                        _ => None,
                    }
                })
                .collect()
        }
        serde_json::Value::String(s) => {
            if s.is_empty() {
                vec![]
            } else {
                vec![ContentBlock::Text { text: s.clone() }]
            }
        }
        _ => vec![],
    }
}

/// Write normalized messages to a JSONL file
fn write_normalized_file(path: &Path, messages: &[NormalizedMessage]) -> Result<(), Box<dyn std::error::Error>> {
    let mut file = File::create(path)?;

    for msg in messages {
        let json = serde_json::to_string(msg)?;
        writeln!(file, "{}", json)?;
    }

    Ok(())
}

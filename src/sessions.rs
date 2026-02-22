//! Shared session types and cache for normalized session data.
//!
//! This module defines the normalized session format that all consumers
//! (UI, memory extraction, title generation) read from.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;

/// A normalized message from any source (Claude Code, Gemini, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedMessage {
    pub uuid: String,
    pub role: String,  // "user", "assistant", "system"
    pub timestamp: String,
    pub content: Vec<ContentBlock>,
    /// Original source file for traceability
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
}

/// Content block within a message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
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
        source: Option<ImageSource>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSource {
    #[serde(rename = "type")]
    pub source_type: String,
    pub media_type: String,
    pub data: String,
}

/// Metadata about a session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub project: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
    /// Last message UUID processed for memory extraction
    pub last_memory_uuid: Option<String>,
    /// Source agent: "claude", "codex", or "pi"
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "claude".to_string()
}

/// A complete normalized session
#[derive(Debug, Clone)]
pub struct NormalizedSession {
    pub meta: SessionMeta,
    pub messages: Vec<NormalizedMessage>,
    /// Path to persisted normalized file
    pub normalized_path: PathBuf,
}

/// Events broadcast when sessions change
#[derive(Debug, Clone)]
pub enum SessionEvent {
    /// Session was created or updated
    Updated {
        session_id: String,
        new_messages: Vec<NormalizedMessage>,
    },
    /// Session title was generated/updated
    TitleUpdated {
        session_id: String,
        title: String,
    },
    /// New facts were extracted
    MemoryExtracted {
        session_id: String,
        facts: Vec<ExtractedFact>,
    },
}

/// A fact extracted from a session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedFact {
    pub date: String,
    pub session: String,
    pub msg: String,
    pub fact: String,
    pub action: String,  // "add" or "update"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<String>,
}

/// Global session cache shared across all components
pub struct SessionCache {
    /// Session ID -> Normalized session
    sessions: DashMap<String, NormalizedSession>,
    /// Broadcast channel for session events
    event_tx: broadcast::Sender<SessionEvent>,
    /// Path to normalized sessions directory
    pub normalized_dir: PathBuf,
    /// Path to memory.jsonl
    pub memory_file: PathBuf,
}

impl SessionCache {
    pub fn new(normalized_dir: PathBuf, memory_file: PathBuf) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            sessions: DashMap::new(),
            event_tx,
            normalized_dir,
            memory_file,
        })
    }

    /// Get a session by ID
    pub fn get(&self, session_id: &str) -> Option<NormalizedSession> {
        self.sessions.get(session_id).map(|r| r.clone())
    }

    /// Insert or update a session
    pub fn upsert(&self, mut session: NormalizedSession) {
        let session_id = session.meta.id.clone();
        let new_messages = session.messages.clone();

        // Preserve existing title if the new session doesn't have one
        if session.meta.title.is_none() {
            if let Some(existing) = self.sessions.get(&session_id) {
                session.meta.title = existing.meta.title.clone();
            }
        }

        self.sessions.insert(session_id.clone(), session);

        // Broadcast update event
        let _ = self.event_tx.send(SessionEvent::Updated {
            session_id,
            new_messages,
        });
    }

    /// Update just the title for a session
    pub fn update_title(&self, session_id: &str, title: String) {
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.meta.title = Some(title.clone());
        }
        let _ = self.event_tx.send(SessionEvent::TitleUpdated {
            session_id: session_id.to_string(),
            title,
        });
    }

    /// Subscribe to session events
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.event_tx.subscribe()
    }

    /// List all session metadata (for sidebar)
    /// Filters out sessions whose normalized file no longer exists
    pub fn list_sessions(&self) -> Vec<SessionMeta> {
        let mut stale_ids = Vec::new();
        let result: Vec<SessionMeta> = self.sessions
            .iter()
            .filter_map(|r| {
                let meta = &r.meta;
                let file_path = self.normalized_dir.join(format!("{}.jsonl", meta.id));
                if file_path.exists() {
                    Some(meta.clone())
                } else {
                    stale_ids.push(meta.id.clone());
                    None
                }
            })
            .collect();

        // Remove stale entries from cache
        for id in stale_ids {
            self.sessions.remove(&id);
        }

        result
    }

    /// Get sessions that need memory extraction
    pub fn sessions_needing_extraction(&self, min_new_messages: usize) -> Vec<String> {
        self.sessions
            .iter()
            .filter_map(|r| {
                let session = r.value();
                let last_idx = session.meta.last_memory_uuid.as_ref()
                    .and_then(|uuid| session.messages.iter().position(|m| &m.uuid == uuid))
                    .unwrap_or(0);
                let new_count = session.messages.len().saturating_sub(last_idx);
                if new_count >= min_new_messages {
                    Some(session.meta.id.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    /// Mark a session as having had memory extracted up to a message
    pub fn mark_memory_extracted(&self, session_id: &str, last_uuid: String) {
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.meta.last_memory_uuid = Some(last_uuid);
        }
    }

    /// Append a normalized message to a session and persist to disk.
    /// Creates the session if it does not exist.
    pub fn append_message(
        &self,
        session_id: &str,
        project: &str,
        message: NormalizedMessage,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Ensure normalized directory exists
        fs::create_dir_all(&self.normalized_dir)?;

        let mut session = if let Some(existing) = self.get(session_id) {
            existing
        } else {
            NormalizedSession {
                meta: SessionMeta {
                    id: session_id.to_string(),
                    project: project.to_string(),
                    title: None,
                    created_at: message.timestamp.clone(),
                    updated_at: message.timestamp.clone(),
                    message_count: 0,
                    last_memory_uuid: None,
                    source: "claude".to_string(),
                },
                messages: Vec::new(),
                normalized_path: self.normalized_dir.join(format!("{}.jsonl", session_id)),
            }
        };

        session.messages.push(message.clone());
        session.meta.message_count = session.messages.len();
        if session.meta.created_at.is_empty() {
            session.meta.created_at = message.timestamp.clone();
        }
        session.meta.updated_at = message.timestamp.clone();

        // Persist to disk (append-only)
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&session.normalized_path)?;
        let line = serde_json::to_string(&message)?;
        writeln!(file, "{}", line)?;

        // Update cache and broadcast
        self.upsert(session);

        Ok(())
    }

    /// Get messages for memory extraction (last N messages after last extraction point)
    pub fn get_messages_for_extraction(&self, session_id: &str, max_messages: usize) -> Option<Vec<NormalizedMessage>> {
        self.sessions.get(session_id).map(|r| {
            let session = r.value();
            let start_idx = session.meta.last_memory_uuid.as_ref()
                .and_then(|uuid| session.messages.iter().position(|m| &m.uuid == uuid))
                .map(|i| i + 1)
                .unwrap_or(0);
            session.messages[start_idx..]
                .iter()
                .take(max_messages)
                .cloned()
                .collect()
        })
    }
}

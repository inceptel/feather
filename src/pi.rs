//! Parse Pi coding agent sessions from ~/.pi/agent/sessions/
//!
//! Pi stores sessions in a tree-structured JSONL format:
//! ~/.pi/agent/sessions/<cwd-encoded>/<timestamp>_<uuid>/context.jsonl
//!
//! File format:
//! - Line 1: SessionHeader {type: "session", id, timestamp, cwd}
//! - Lines 2+: SessionEntry {type, id, parentId, timestamp, ...}
//!
//! Entry types:
//! - "message": Contains AgentMessage (user, assistant, toolResult, bashExecution, custom, etc.)
//! - "thinking_level_change", "model_change", "compaction", "branch_summary",
//!   "custom", "custom_message", "label", "session_info": Metadata (skipped)
//!
//! Tree structure: entries link via id/parentId. We walk from leaf to root,
//! reverse for chronological order, and extract only message entries.

use crate::sessions::{ContentBlock, NormalizedMessage, SessionMeta};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tracing::debug;

/// Metadata extracted from Pi session header
#[derive(Debug, Clone)]
pub struct PiSessionMeta {
    pub id: String,
    pub cwd: String,
    pub timestamp: String,
}

/// Pi JSONL line — either a session header or a session entry
#[derive(Debug, Deserialize)]
struct PiRecord {
    #[serde(rename = "type")]
    record_type: String,
    /// Entry ID (not present on session header in older formats)
    id: Option<String>,
    /// Parent entry ID (null for root entries)
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    /// Timestamp (ISO 8601 on header, ISO or unix on entries)
    timestamp: Option<serde_json::Value>,
    /// Session ID (header only)
    #[serde(default)]
    cwd: Option<String>,
    /// The message payload (message entries only)
    message: Option<serde_json::Value>,
    /// Session name (session_info entries)
    #[allow(dead_code)]
    name: Option<String>,
}

#[allow(dead_code)]
/// Extract session UUID from directory name
/// e.g. "1738000000000_abc12345-..." → "abc12345-..."
/// or just "abc12345-..." if no timestamp prefix
pub fn extract_session_id(dir_name: &str) -> Option<String> {
    // Format: <timestamp>_<uuid> or just the session header id
    if let Some((_ts, uuid)) = dir_name.split_once('_') {
        if !uuid.is_empty() {
            return Some(uuid.to_string());
        }
    }
    // Fallback: use whole dir name
    Some(dir_name.to_string())
}

#[allow(dead_code)]
/// Extract project_id from the encoded cwd directory name
/// Pi encodes cwd as: --home--user--projects--code (double-hyphens for slashes)
pub fn extract_project_id(encoded_cwd: &str) -> String {
    // The encoded_cwd uses -- for / separators
    // Convert back: "--home--user--projects--code" → "/home/user/projects/code"
    // Then convert to Feather's project_id format: "-home-user-projects-code"
    let path = encoded_cwd.replace("--", "/");
    format!("-{}", path.replace('/', "-").trim_start_matches('-'))
}

/// Generate deterministic UUID for Pi entries
fn generate_uuid(session_id: &str, entry_id: &str) -> String {
    format!("pi-{}-{}", session_id, entry_id)
}

/// Extract timestamp as ISO 8601 string from a serde_json::Value
/// Pi uses unix timestamps (numbers) in messages, ISO strings in headers
fn extract_timestamp(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => {
            // Unix timestamp in milliseconds
            if let Some(ms) = n.as_f64() {
                let secs = (ms / 1000.0) as i64;
                let nanos = ((ms % 1000.0) * 1_000_000.0) as u32;
                if let Some(dt) = chrono::DateTime::from_timestamp(secs, nanos) {
                    return dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// Parse a Pi session JSONL file into normalized messages
pub fn parse_pi_session(
    path: &Path,
) -> Result<(PiSessionMeta, Vec<NormalizedMessage>), Box<dyn std::error::Error + Send + Sync>> {
    let content = fs::read_to_string(path)?;
    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("context.jsonl");

    // Parse all lines
    let mut header_meta = PiSessionMeta {
        id: String::new(),
        cwd: String::new(),
        timestamp: String::new(),
    };

    // Collect entries by ID for tree traversal
    let mut entries: Vec<PiRecord> = Vec::new();
    let mut entries_by_id: HashMap<String, usize> = HashMap::new();
    let mut last_entry_id: Option<String> = None;

    for line in content.lines() {
        if line.is_empty() {
            continue;
        }

        let record: PiRecord = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue,
        };

        if record.record_type == "session" {
            // Session header
            if let Some(id_val) = serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
            {
                header_meta.id = id_val;
            }
            header_meta.cwd = record.cwd.unwrap_or_default();
            if let Some(ts) = &record.timestamp {
                header_meta.timestamp = extract_timestamp(ts);
            }
            continue;
        }

        // Session entry — track for tree traversal
        if let Some(ref id) = record.id {
            let idx = entries.len();
            entries_by_id.insert(id.clone(), idx);
            last_entry_id = Some(id.clone());
        }
        entries.push(record);
    }

    // If no entries, return empty
    if entries.is_empty() {
        return Ok((header_meta, Vec::new()));
    }

    // Walk from leaf to root via parentId chain to get the current branch
    let branch_indices: Vec<usize> = if let Some(leaf_id) = last_entry_id {
        let mut path_indices = Vec::new();
        let mut current_id = Some(leaf_id);

        while let Some(id) = current_id {
            if let Some(&idx) = entries_by_id.get(&id) {
                path_indices.push(idx);
                current_id = entries[idx].parent_id.clone();
            } else {
                break;
            }
        }

        path_indices.reverse(); // Root to leaf order
        path_indices
    } else {
        // No tree structure, use all entries in order
        (0..entries.len()).collect()
    };

    // Extract message entries from the branch
    let mut messages: Vec<NormalizedMessage> = Vec::new();
    let session_id = &header_meta.id;

    for &idx in &branch_indices {
        let entry = &entries[idx];

        if entry.record_type != "message" {
            // Check for session_info (name)
            continue;
        }

        let entry_id = match &entry.id {
            Some(id) => id.clone(),
            None => format!("idx-{}", idx),
        };

        let msg = match &entry.message {
            Some(m) => m,
            None => continue,
        };

        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let entry_ts = entry.timestamp.as_ref()
            .map(|t| extract_timestamp(t))
            .or_else(|| msg.get("timestamp").map(|t| extract_timestamp(t)))
            .unwrap_or_default();

        match role {
            "user" => {
                let blocks = extract_user_content(msg);
                if blocks.is_empty() {
                    continue;
                }
                messages.push(NormalizedMessage {
                    uuid: generate_uuid(session_id, &entry_id),
                    role: "user".to_string(),
                    timestamp: entry_ts,
                    content: blocks,
                    source_file: Some(filename.to_string()),
                });
            }
            "assistant" => {
                let blocks = extract_assistant_content(msg);
                if blocks.is_empty() {
                    continue;
                }
                messages.push(NormalizedMessage {
                    uuid: generate_uuid(session_id, &entry_id),
                    role: "assistant".to_string(),
                    timestamp: entry_ts,
                    content: blocks,
                    source_file: Some(filename.to_string()),
                });
            }
            "toolResult" => {
                let tool_call_id = msg.get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_error = msg.get("isError").and_then(|v| v.as_bool());

                // Convert content array to a JSON value for ToolResult
                let content_val = msg.get("content").cloned().unwrap_or(serde_json::Value::Null);

                messages.push(NormalizedMessage {
                    uuid: generate_uuid(session_id, &entry_id),
                    role: "user".to_string(), // Tool results are user messages in normalized format
                    timestamp: entry_ts,
                    content: vec![ContentBlock::ToolResult {
                        tool_use_id: tool_call_id,
                        content: content_val,
                        is_error,
                    }],
                    source_file: Some(filename.to_string()),
                });
            }
            "bashExecution" => {
                // Convert bash execution to a readable text block
                let command = msg.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let output = msg.get("output").and_then(|v| v.as_str()).unwrap_or("");
                let exit_code = msg.get("exitCode").and_then(|v| v.as_i64());

                let text = if let Some(code) = exit_code {
                    format!("$ {}\n{}\n[exit code: {}]", command, output, code)
                } else {
                    format!("$ {}\n{}", command, output)
                };

                messages.push(NormalizedMessage {
                    uuid: generate_uuid(session_id, &entry_id),
                    role: "user".to_string(),
                    timestamp: entry_ts,
                    content: vec![ContentBlock::Text { text }],
                    source_file: Some(filename.to_string()),
                });
            }
            "compactionSummary" | "branchSummary" | "custom" => {
                // Skip internal messages
                debug!("Skipping Pi message role: {}", role);
            }
            _ => {
                debug!("Skipping unknown Pi message role: {}", role);
            }
        }
    }

    Ok((header_meta, messages))
}

/// Extract content blocks from a user message
/// UserMessage.content is either a string or array of TextContent|ImageContent
fn extract_user_content(msg: &serde_json::Value) -> Vec<ContentBlock> {
    let content = match msg.get("content") {
        Some(c) => c,
        None => return vec![],
    };

    match content {
        serde_json::Value::String(s) => {
            if s.is_empty() {
                vec![]
            } else {
                vec![ContentBlock::Text { text: s.clone() }]
            }
        }
        serde_json::Value::Array(arr) => {
            arr.iter()
                .filter_map(|item| {
                    let item_type = item.get("type")?.as_str()?;
                    match item_type {
                        "text" => {
                            let text = item.get("text")?.as_str()?.to_string();
                            if text.is_empty() { return None; }
                            Some(ContentBlock::Text { text })
                        }
                        "image" => {
                            let data = item.get("data").and_then(|d| d.as_str()).unwrap_or("").to_string();
                            let mime = item.get("mimeType").and_then(|m| m.as_str()).unwrap_or("image/png").to_string();
                            Some(ContentBlock::Image {
                                source: Some(crate::sessions::ImageSource {
                                    source_type: "base64".to_string(),
                                    media_type: mime,
                                    data,
                                }),
                            })
                        }
                        _ => None,
                    }
                })
                .collect()
        }
        _ => vec![],
    }
}

/// Extract content blocks from an assistant message
/// AssistantMessage.content is array of TextContent|ThinkingContent|ToolCall
fn extract_assistant_content(msg: &serde_json::Value) -> Vec<ContentBlock> {
    let content = match msg.get("content").and_then(|c| c.as_array()) {
        Some(arr) => arr,
        None => return vec![],
    };

    content.iter()
        .filter_map(|item| {
            let item_type = item.get("type")?.as_str()?;
            match item_type {
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
                "toolCall" => {
                    let id = item.get("id")?.as_str()?.to_string();
                    let raw_name = item.get("name")?.as_str()?.to_string();
                    let arguments = item.get("arguments").cloned()
                        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                    // Normalize Pi tool names/args to match Claude CLI conventions
                    let (name, input) = normalize_pi_tool(&raw_name, arguments);
                    Some(ContentBlock::ToolUse {
                        id,
                        name,
                        input,
                    })
                }
                _ => None,
            }
        })
        .collect()
}

/// Normalize Pi tool names and argument field names to match Claude CLI conventions.
/// Pi uses lowercase names (bash, read, write, edit) and different field names
/// (path vs file_path, oldText/newText vs old_string/new_string).
fn normalize_pi_tool(name: &str, mut args: serde_json::Value) -> (String, serde_json::Value) {
    let normalized_name = match name {
        "bash" => "Bash",
        "read" => "Read",
        "write" => "Write",
        "edit" => "Edit",
        "grep" => "Grep",
        "glob" => "Glob",
        other => {
            // Capitalize first letter for unknown tools
            let mut s = other.to_string();
            if let Some(c) = s.get_mut(0..1) {
                c.make_ascii_uppercase();
            }
            return (s, args);
        }
    };

    // Remap field names in arguments
    if let Some(obj) = args.as_object_mut() {
        match name {
            "read" | "write" => {
                // path -> file_path
                if let Some(v) = obj.remove("path") {
                    obj.insert("file_path".to_string(), v);
                }
            }
            "edit" => {
                // path -> file_path, oldText -> old_string, newText -> new_string
                if let Some(v) = obj.remove("path") {
                    obj.insert("file_path".to_string(), v);
                }
                if let Some(v) = obj.remove("oldText") {
                    obj.insert("old_string".to_string(), v);
                }
                if let Some(v) = obj.remove("newText") {
                    obj.insert("new_string".to_string(), v);
                }
            }
            _ => {}
        }
    }

    (normalized_name.to_string(), args)
}

/// Convert Pi session metadata to normalized SessionMeta
pub fn to_session_meta(pi_meta: &PiSessionMeta, project_id: &str, message_count: usize) -> SessionMeta {
    SessionMeta {
        id: pi_meta.id.clone(),
        project: project_id.to_string(),
        title: None,
        created_at: pi_meta.timestamp.clone(),
        updated_at: pi_meta.timestamp.clone(),
        message_count,
        last_memory_uuid: None,
        source: "pi".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_session_id() {
        assert_eq!(
            extract_session_id("1738000000000_abc12345-def6-7890"),
            Some("abc12345-def6-7890".to_string())
        );
        assert_eq!(
            extract_session_id("abc12345-def6-7890"),
            Some("abc12345-def6-7890".to_string())
        );
    }

    #[test]
    fn test_extract_project_id() {
        assert_eq!(
            extract_project_id("--home--user--projects--code"),
            "-home-user-projects-code"
        );
    }

    #[test]
    fn test_extract_timestamp_string() {
        let val = serde_json::Value::String("2026-02-07T10:30:00Z".to_string());
        assert_eq!(extract_timestamp(&val), "2026-02-07T10:30:00Z");
    }

    #[test]
    fn test_extract_timestamp_number() {
        // 1738886400000 = 2025-02-07T00:00:00Z
        let val = serde_json::json!(1738886400000u64);
        let ts = extract_timestamp(&val);
        assert!(!ts.is_empty());
        assert!(ts.starts_with("2025-02-07"));
    }
}

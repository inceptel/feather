//! Parse Codex sessions from ~/.codex/sessions/
//!
//! Codex stores sessions in:
//! ~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
//!
//! Record types:
//! - session_meta: Session metadata (id, cwd, model)
//! - response_item: Messages, function calls, reasoning
//! - event_msg, turn_context, compacted: Skipped

use crate::sessions::{ContentBlock, NormalizedMessage, SessionMeta};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tracing::debug;

/// Metadata extracted from Codex session_meta record
#[derive(Debug, Clone)]
pub struct CodexSessionMeta {
    pub id: String,
    pub cwd: String,
    pub model: Option<String>,
    pub timestamp: String,
}

/// Codex JSONL record envelope
#[derive(Debug, Deserialize)]
struct CodexRecord {
    timestamp: String,
    #[serde(rename = "type")]
    record_type: String,
    payload: serde_json::Value,
}

/// Extract session UUID from Codex filename
/// "rollout-2026-02-03T02-32-13-019c2157-e0e9-7bb2-a886-d3b1a9e24d4f.jsonl"
/// -> "019c2157-e0e9-7bb2-a886-d3b1a9e24d4f"
pub fn extract_session_id(filename: &str) -> Option<String> {
    // Remove .jsonl extension
    let name = filename.strip_suffix(".jsonl")?;

    // Split by '-' and take the last 5 parts (UUID format: 8-4-4-4-12)
    let parts: Vec<&str> = name.split('-').collect();
    if parts.len() < 5 {
        return None;
    }

    // UUID is in the last 5 dash-separated segments
    // rollout-2026-02-03T02-32-13-019c2157-e0e9-7bb2-a886-d3b1a9e24d4f
    // The UUID parts start after the timestamp
    let uuid_parts = &parts[parts.len() - 5..];
    Some(uuid_parts.join("-"))
}

/// Generate deterministic UUID for Codex records (they don't have per-message UUIDs)
pub fn generate_uuid(session_id: &str, timestamp: &str, index: usize) -> String {
    format!("codex-{}-{}-{}", session_id, index, timestamp.replace([':', '.', '-'], ""))
}

/// Parse a Codex JSONL file into normalized messages
pub fn parse_codex_session(
    path: &Path,
) -> Result<(CodexSessionMeta, Vec<NormalizedMessage>), Box<dyn std::error::Error + Send + Sync>> {
    let content = fs::read_to_string(path)?;
    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    let session_id = extract_session_id(filename)
        .ok_or_else(|| format!("Invalid Codex filename: {}", filename))?;

    let mut meta = CodexSessionMeta {
        id: session_id.clone(),
        cwd: String::new(),
        model: None,
        timestamp: String::new(),
    };

    let mut messages: HashMap<String, NormalizedMessage> = HashMap::new();
    let mut msg_index = 0usize;

    // Track function calls for matching with outputs
    let mut pending_tool_calls: HashMap<String, (String, String, serde_json::Value)> = HashMap::new(); // call_id -> (uuid, name, input)

    for line in content.lines() {
        if line.is_empty() {
            continue;
        }

        let record: CodexRecord = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue,
        };

        match record.record_type.as_str() {
            "session_meta" => {
                // Extract session metadata
                if let Some(payload) = record.payload.as_object() {
                    if let Some(id) = payload.get("id").and_then(|v| v.as_str()) {
                        meta.id = id.to_string();
                    }
                    if let Some(cwd) = payload.get("cwd").and_then(|v| v.as_str()) {
                        meta.cwd = cwd.to_string();
                    }
                    if let Some(model) = payload.get("model_provider").and_then(|v| v.as_str()) {
                        meta.model = Some(model.to_string());
                    }
                    if let Some(ts) = payload.get("timestamp").and_then(|v| v.as_str()) {
                        meta.timestamp = ts.to_string();
                    }
                }
            }
            "response_item" => {
                if let Some(payload) = record.payload.as_object() {
                    let item_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");

                    match item_type {
                        "message" => {
                            // User or assistant message
                            let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("user");

                            // Skip developer/system messages (internal prompts)
                            if role == "developer" || role == "system" {
                                continue;
                            }

                            let content_arr = payload.get("content").and_then(|v| v.as_array());
                            if let Some(content_arr) = content_arr {
                                let blocks = extract_content_blocks(content_arr);
                                if blocks.is_empty() {
                                    continue;
                                }

                                let uuid = generate_uuid(&session_id, &record.timestamp, msg_index);
                                msg_index += 1;

                                messages.insert(uuid.clone(), NormalizedMessage {
                                    uuid,
                                    role: role.to_string(),
                                    timestamp: record.timestamp.clone(),
                                    content: blocks,
                                    source_file: Some(filename.to_string()),
                                });
                            }
                        }
                        "function_call" => {
                            // Tool use - store for matching with output
                            let call_id = payload.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
                            let arguments = payload.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");

                            let input: serde_json::Value = serde_json::from_str(arguments)
                                .unwrap_or(serde_json::Value::Null);

                            let uuid = generate_uuid(&session_id, &record.timestamp, msg_index);
                            msg_index += 1;

                            pending_tool_calls.insert(call_id.to_string(), (uuid.clone(), name.to_string(), input.clone()));

                            // Create assistant message with tool_use
                            messages.insert(uuid.clone(), NormalizedMessage {
                                uuid,
                                role: "assistant".to_string(),
                                timestamp: record.timestamp.clone(),
                                content: vec![ContentBlock::ToolUse {
                                    id: call_id.to_string(),
                                    name: name.to_string(),
                                    input,
                                }],
                                source_file: Some(filename.to_string()),
                            });
                        }
                        "custom_tool_call" => {
                            // Same as function_call but for custom tools
                            let call_id = payload.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
                            let arguments = payload.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");

                            let input: serde_json::Value = serde_json::from_str(arguments)
                                .unwrap_or(serde_json::Value::Null);

                            let uuid = generate_uuid(&session_id, &record.timestamp, msg_index);
                            msg_index += 1;

                            pending_tool_calls.insert(call_id.to_string(), (uuid.clone(), name.to_string(), input.clone()));

                            messages.insert(uuid.clone(), NormalizedMessage {
                                uuid,
                                role: "assistant".to_string(),
                                timestamp: record.timestamp.clone(),
                                content: vec![ContentBlock::ToolUse {
                                    id: call_id.to_string(),
                                    name: name.to_string(),
                                    input,
                                }],
                                source_file: Some(filename.to_string()),
                            });
                        }
                        "function_call_output" | "custom_tool_call_output" => {
                            // Tool result
                            let call_id = payload.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                            let output = payload.get("output").cloned().unwrap_or(serde_json::Value::Null);

                            let uuid = generate_uuid(&session_id, &record.timestamp, msg_index);
                            msg_index += 1;

                            // Remove from pending and get the tool name
                            let _ = pending_tool_calls.remove(call_id);

                            messages.insert(uuid.clone(), NormalizedMessage {
                                uuid,
                                role: "user".to_string(), // Tool results are user messages in Claude format
                                timestamp: record.timestamp.clone(),
                                content: vec![ContentBlock::ToolResult {
                                    tool_use_id: call_id.to_string(),
                                    content: output,
                                    is_error: None,
                                }],
                                source_file: Some(filename.to_string()),
                            });
                        }
                        "reasoning" => {
                            // Extended thinking - only include summary (content is encrypted)
                            if let Some(summary) = payload.get("summary").and_then(|v| v.as_array()) {
                                let thinking_text: String = summary.iter()
                                    .filter_map(|item| {
                                        item.get("text").and_then(|t| t.as_str())
                                    })
                                    .collect::<Vec<_>>()
                                    .join("\n");

                                if !thinking_text.is_empty() {
                                    let uuid = generate_uuid(&session_id, &record.timestamp, msg_index);
                                    msg_index += 1;

                                    messages.insert(uuid.clone(), NormalizedMessage {
                                        uuid,
                                        role: "assistant".to_string(),
                                        timestamp: record.timestamp.clone(),
                                        content: vec![ContentBlock::Thinking { thinking: thinking_text }],
                                        source_file: Some(filename.to_string()),
                                    });
                                }
                            }
                        }
                        "web_search_call" => {
                            // Web search tool - treat as tool_use
                            let call_id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let status = payload.get("status").and_then(|v| v.as_str()).unwrap_or("");

                            if status == "completed" {
                                // Skip completed status, we already logged the call
                                continue;
                            }

                            let uuid = generate_uuid(&session_id, &record.timestamp, msg_index);
                            msg_index += 1;

                            messages.insert(uuid.clone(), NormalizedMessage {
                                uuid,
                                role: "assistant".to_string(),
                                timestamp: record.timestamp.clone(),
                                content: vec![ContentBlock::ToolUse {
                                    id: call_id.to_string(),
                                    name: "web_search".to_string(),
                                    input: serde_json::json!({}),
                                }],
                                source_file: Some(filename.to_string()),
                            });
                        }
                        _ => {
                            debug!("Skipping Codex response_item type: {}", item_type);
                        }
                    }
                }
            }
            "event_msg" | "turn_context" | "compacted" => {
                // Skip these record types
            }
            _ => {
                debug!("Skipping Codex record type: {}", record.record_type);
            }
        }
    }

    // Sort messages by timestamp
    let mut messages: Vec<NormalizedMessage> = messages.into_values().collect();
    messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    Ok((meta, messages))
}

/// Extract content blocks from Codex content array
fn extract_content_blocks(content: &[serde_json::Value]) -> Vec<ContentBlock> {
    content.iter()
        .filter_map(|item| {
            let block_type = item.get("type").and_then(|v| v.as_str())?;

            match block_type {
                "input_text" | "output_text" | "text" => {
                    let text = item.get("text").and_then(|v| v.as_str())?.to_string();
                    if text.is_empty() {
                        return None;
                    }
                    Some(ContentBlock::Text { text })
                }
                _ => None,
            }
        })
        .collect()
}

/// Convert Codex session metadata to normalized SessionMeta
pub fn to_session_meta(codex_meta: &CodexSessionMeta, project_id: &str, message_count: usize) -> SessionMeta {
    SessionMeta {
        id: codex_meta.id.clone(),
        project: project_id.to_string(),
        title: None,
        created_at: codex_meta.timestamp.clone(),
        updated_at: codex_meta.timestamp.clone(),
        message_count,
        last_memory_uuid: None,
        source: "codex".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_session_id() {
        assert_eq!(
            extract_session_id("rollout-2026-02-03T02-32-13-019c2157-e0e9-7bb2-a886-d3b1a9e24d4f.jsonl"),
            Some("019c2157-e0e9-7bb2-a886-d3b1a9e24d4f".to_string())
        );
    }

    #[test]
    fn test_generate_uuid() {
        let uuid = generate_uuid("abc123", "2026-02-03T10:30:00Z", 5);
        assert!(uuid.starts_with("codex-abc123-5-"));
    }
}

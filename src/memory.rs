//! Memory extraction - periodically extracts facts from sessions using Haiku.
//!
//! Every 5 minutes:
//! 1. Find sessions with 3+ new messages since last extraction
//! 2. Send last 50 messages to Haiku for fact extraction
//! 3. Append extracted facts to memory.jsonl

use crate::sessions::{ContentBlock, ExtractedFact, NormalizedMessage, SessionCache};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, error, info, warn};

const MIN_NEW_MESSAGES: usize = 3;
const MAX_CONTEXT_MESSAGES: usize = 50;
const EXTRACTION_INTERVAL: Duration = Duration::from_secs(30 * 60); // 30 minutes

/// Haiku extraction prompt
const EXTRACTION_PROMPT: &str = r#"You are a memory extraction system. Extract facts worth remembering from this conversation.

Conversation (most recent messages):
<conversation>
{conversation}
</conversation>

Facts already extracted from this conversation:
<existing_facts>
{existing_facts}
</existing_facts>

Extract NEW facts worth remembering long-term. Focus on:
- Decisions made
- Preferences expressed
- Events/appointments scheduled
- People mentioned with context
- Technical choices/architecture decisions
- Problems solved and how

Skip:
- Temporary debugging info
- File contents being read
- Routine tool usage

Return JSON array of facts:
[{"fact": "description", "msg_hint": "keyword from relevant message"}]

If no new facts worth extracting, return: []"#;

/// Start the memory extraction background task
pub async fn start(cache: Arc<SessionCache>, api_key: String) {
    info!("Starting memory extraction (interval: {:?})", EXTRACTION_INTERVAL);

    loop {
        tokio::time::sleep(EXTRACTION_INTERVAL).await;

        if let Err(e) = run_extraction_cycle(&cache, &api_key).await {
            error!("Memory extraction cycle failed: {}", e);
        }
    }
}

/// Run one extraction cycle
async fn run_extraction_cycle(
    cache: &Arc<SessionCache>,
    api_key: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sessions = cache.sessions_needing_extraction(MIN_NEW_MESSAGES);

    if sessions.is_empty() {
        debug!("No sessions need memory extraction");
        return Ok(());
    }

    info!("Extracting memories from {} sessions", sessions.len());

    for session_id in sessions {
        match extract_session_memories(cache, &session_id, api_key).await {
            Ok(facts) => {
                if !facts.is_empty() {
                    info!("Extracted {} facts from session {}", facts.len(), &session_id[..8]);
                    append_facts_to_file(&cache.memory_file, &facts)?;
                }
            }
            Err(e) => {
                warn!("Failed to extract from session {}: {}", &session_id[..8], e);
            }
        }
    }

    Ok(())
}

/// Extract memories from a single session
async fn extract_session_memories(
    cache: &Arc<SessionCache>,
    session_id: &str,
    api_key: &str,
) -> Result<Vec<ExtractedFact>, Box<dyn std::error::Error + Send + Sync>> {
    // Get messages for extraction
    let messages = match cache.get_messages_for_extraction(session_id, MAX_CONTEXT_MESSAGES) {
        Some(m) if !m.is_empty() => m,
        _ => return Ok(vec![]),
    };

    // Format conversation for the prompt
    let conversation = format_conversation(&messages);

    // Load existing facts for this session
    let existing_facts = load_existing_facts(&cache.memory_file, session_id)?;
    let existing_facts_str = existing_facts
        .iter()
        .map(|f| f.fact.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    // Build the prompt
    let prompt = EXTRACTION_PROMPT
        .replace("{conversation}", &conversation)
        .replace("{existing_facts}", &existing_facts_str);

    // Call Haiku API
    let response = call_haiku(api_key, &prompt).await?;

    // Parse response
    let facts = parse_extraction_response(&response, session_id, &messages)?;

    // Mark session as extracted
    if let Some(last_msg) = messages.last() {
        cache.mark_memory_extracted(session_id, last_msg.uuid.clone());
    }

    Ok(facts)
}

/// Format messages as conversation text
fn format_conversation(messages: &[NormalizedMessage]) -> String {
    messages
        .iter()
        .map(|msg| {
            let role = &msg.role;
            let content = msg.content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.clone()),
                    ContentBlock::Thinking { thinking } => Some(format!("[thinking: {}]", &thinking[..thinking.len().min(200)])),
                    ContentBlock::ToolUse { name, .. } => Some(format!("[tool: {}]", name)),
                    ContentBlock::ToolResult { .. } => None, // Skip tool results to save tokens
                    ContentBlock::Image { .. } => Some("[image]".to_string()),
                })
                .collect::<Vec<_>>()
                .join("\n");

            format!("{}: {}", role, content)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Load existing facts for a session from memory.jsonl
fn load_existing_facts(memory_file: &Path, session_id: &str) -> Result<Vec<ExtractedFact>, Box<dyn std::error::Error + Send + Sync>> {
    if !memory_file.exists() {
        return Ok(vec![]);
    }

    let file = File::open(memory_file)?;
    let reader = BufReader::new(file);

    let mut facts = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        if let Ok(fact) = serde_json::from_str::<ExtractedFact>(&line) {
            if fact.session.starts_with(&session_id[..8.min(session_id.len())]) {
                facts.push(fact);
            }
        }
    }

    Ok(facts)
}

/// Call Haiku API for extraction
async fn call_haiku(api_key: &str, prompt: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": "claude-3-5-haiku-20241022",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": prompt}
            ]
        }))
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Haiku API error {}: {}", status, body).into());
    }

    let body: serde_json::Value = response.json().await?;
    let text = body["content"][0]["text"]
        .as_str()
        .unwrap_or("[]")
        .to_string();

    Ok(text)
}

/// Parse Haiku's extraction response into facts
fn parse_extraction_response(
    response: &str,
    session_id: &str,
    messages: &[NormalizedMessage],
) -> Result<Vec<ExtractedFact>, Box<dyn std::error::Error + Send + Sync>> {
    // Try to extract JSON array from response
    let json_str = if let Some(start) = response.find('[') {
        if let Some(end) = response.rfind(']') {
            &response[start..=end]
        } else {
            "[]"
        }
    } else {
        "[]"
    };

    let raw_facts: Vec<serde_json::Value> = serde_json::from_str(json_str)?;

    let today = chrono_like_today();
    let short_session = &session_id[..8.min(session_id.len())];

    let facts = raw_facts
        .into_iter()
        .filter_map(|v| {
            let fact_text = v.get("fact")?.as_str()?.to_string();
            let msg_hint = v.get("msg_hint").and_then(|h| h.as_str()).unwrap_or("");

            // Try to find the message UUID based on hint
            let msg_uuid = messages
                .iter()
                .rev()
                .find(|m| {
                    m.content.iter().any(|block| match block {
                        ContentBlock::Text { text } => text.contains(msg_hint),
                        _ => false,
                    })
                })
                .map(|m| &m.uuid[..8.min(m.uuid.len())])
                .unwrap_or("unknown");

            Some(ExtractedFact {
                date: today.clone(),
                session: short_session.to_string(),
                msg: msg_uuid.to_string(),
                fact: fact_text,
                action: "add".to_string(),
                old: None,
            })
        })
        .collect();

    Ok(facts)
}

/// Append facts to memory.jsonl
fn append_facts_to_file(path: &Path, facts: &[ExtractedFact]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;

    for fact in facts {
        let json = serde_json::to_string(fact)?;
        writeln!(file, "{}", json)?;
    }

    Ok(())
}

/// Get today's date as YYYY-MM-DD
fn chrono_like_today() -> String {
    let now = std::time::SystemTime::now();
    let duration = now.duration_since(std::time::UNIX_EPOCH).unwrap();
    let secs = duration.as_secs();

    // Simple date calculation (not accounting for leap seconds, good enough)
    let days = secs / 86400;
    let years = (days / 365) + 1970;
    let remaining_days = days % 365;
    let month = remaining_days / 30 + 1;
    let day = remaining_days % 30 + 1;

    format!("{:04}-{:02}-{:02}", years, month.min(12), day.min(31))
}

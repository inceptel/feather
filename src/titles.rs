//! Session title generation - generates concise titles for sessions using Haiku.
//!
//! Supports both periodic scanning and on-demand triggers (e.g., new session spawn).
//! Active sessions (with tmux) get escalating retitle intervals: 1m, 3m, 5m, then 5m.
//! Untitled sessions get titled at startup regardless of activity.

use crate::sessions::{ContentBlock, NormalizedMessage, SessionCache};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Notify, RwLock};
use tracing::{debug, info};

/// Path to the title cache file
const TITLE_CACHE_PATH: &str = "title-cache.json";

const PERIODIC_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MIN_MESSAGES_FOR_TITLE: usize = 2;
const RETITLE_MESSAGE_THRESHOLD: usize = 50;

/// Escalating delays after a trigger: 1m, 3m, 5m
const TRIGGER_DELAYS: &[Duration] = &[
    Duration::from_secs(60),
    Duration::from_secs(180),
    Duration::from_secs(300),
];

/// Title generation prompt
const TITLE_PROMPT: &str = r#"Generate a concise title (3-6 words) for this conversation. Focus on the main topic or task.

Conversation start:
<conversation>
{conversation}
</conversation>

Return ONLY the title, no quotes or extra text."#;

/// Title + the message count when it was generated
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct TitleEntry {
    title: String,
    msg_count: usize,
}

/// Shared trigger for on-demand title generation
pub fn create_trigger() -> Arc<Notify> {
    Arc::new(Notify::new())
}

/// Load title cache from disk
fn load_title_cache() -> HashMap<String, TitleEntry> {
    let path = PathBuf::from(TITLE_CACHE_PATH);
    if !path.exists() {
        return HashMap::new();
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };
    // Try new format first (with msg_count)
    if let Ok(cache) = serde_json::from_str::<HashMap<String, TitleEntry>>(&content) {
        return cache;
    }
    // Fall back to old format (just title strings) — migrate
    if let Ok(old) = serde_json::from_str::<HashMap<String, String>>(&content) {
        return old.into_iter().map(|(k, v)| (k, TitleEntry { title: v, msg_count: 0 })).collect();
    }
    HashMap::new()
}

/// Save title cache to disk
fn save_title_cache(cache: &HashMap<String, TitleEntry>) {
    let _ = fs::write(TITLE_CACHE_PATH, serde_json::to_string_pretty(cache).unwrap_or_default());
}

/// Get active tmux session prefixes (session IDs that have a running tmux)
fn get_active_prefixes() -> HashSet<String> {
    let output = Command::new("tmux")
        .args(["list-sessions", "-F", "#{session_name}"])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|s| s.strip_prefix("feather-"))
                .filter(|s| !s.starts_with("new-"))
                .map(|s| s.to_string())
                .collect()
        }
        _ => HashSet::new(),
    }
}

/// Run one title generation cycle. Returns number of titles generated.
async fn run_cycle(
    cache: &Arc<SessionCache>,
    title_cache: &Arc<RwLock<HashMap<String, TitleEntry>>>,
    api_key: &str,
    active_only: bool,
) -> usize {
    let sessions = cache.list_sessions();
    let tc = title_cache.read().await;
    let active_prefixes = get_active_prefixes();

    let mut needs_title: Vec<(String, usize)> = Vec::new();
    for meta in &sessions {
        if meta.message_count < MIN_MESSAGES_FOR_TITLE {
            continue;
        }

        let is_active = active_prefixes.iter().any(|p| meta.id.starts_with(p));

        match tc.get(&meta.id) {
            None => {
                // Never titled - always title (untitled sessions)
                needs_title.push((meta.id.clone(), meta.message_count));
            }
            Some(entry) if is_active && meta.message_count >= entry.msg_count + RETITLE_MESSAGE_THRESHOLD => {
                // Active and grown significantly
                needs_title.push((meta.id.clone(), meta.message_count));
            }
            _ => {
                if !active_only && meta.title.as_deref() == Some("Untitled") {
                    // Startup fixup: retitle anything still called "Untitled"
                    needs_title.push((meta.id.clone(), meta.message_count));
                }
            }
        }
    }
    drop(tc);

    if needs_title.is_empty() {
        return 0;
    }

    // Prioritize: active sessions first, then untitled
    let active_set: HashSet<&str> = active_prefixes.iter().map(|s| s.as_str()).collect();
    needs_title.sort_by_key(|(id, _)| {
        let is_active = active_set.iter().any(|p| id.starts_with(p));
        if is_active { 0 } else { 1 }
    });

    let mut generated_count = 0;
    for (session_id, msg_count) in needs_title.iter().take(10) {
        if let Some(session) = cache.get(session_id) {
            match generate_title(&session.messages, api_key).await {
                Ok(title) => {
                    cache.update_title(session_id, title.clone());
                    {
                        let mut tc = title_cache.write().await;
                        tc.insert(session_id.clone(), TitleEntry {
                            title: title.clone(),
                            msg_count: *msg_count,
                        });
                        if generated_count % 5 == 0 {
                            save_title_cache(&tc);
                        }
                    }
                    info!("Generated title for {}: {} (at {} msgs)", &session_id[..8.min(session_id.len())], title, msg_count);
                    generated_count += 1;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(e) => {
                    debug!("Failed to generate title for {}: {}", &session_id[..8.min(session_id.len())], e);
                }
            }
        }
    }

    if generated_count > 0 {
        let tc = title_cache.read().await;
        save_title_cache(&tc);
    }

    generated_count
}

/// Start the title generation background task
pub async fn start(cache: Arc<SessionCache>, api_key: String, trigger: Arc<Notify>) {
    info!("Starting title generator");

    let title_cache: Arc<RwLock<HashMap<String, TitleEntry>>> =
        Arc::new(RwLock::new(load_title_cache()));

    // Apply any cached titles to the session cache on startup
    {
        let tc = title_cache.read().await;
        for (session_id, entry) in tc.iter() {
            cache.update_title(session_id, entry.title.clone());
        }
    }

    // Startup: fix any untitled sessions (active_only=false to catch everything)
    tokio::time::sleep(Duration::from_secs(10)).await; // Let normalizer populate sessions
    let startup_count = run_cycle(&cache, &title_cache, &api_key, false).await;
    if startup_count > 0 {
        info!("Startup: generated {} titles for untitled sessions", startup_count);
    }

    loop {
        tokio::select! {
            // On-demand trigger (new session spawned)
            _ = trigger.notified() => {
                info!("Title generation triggered (new session)");
                // Run escalating cycles: 1m, 3m, 5m
                for (i, delay) in TRIGGER_DELAYS.iter().enumerate() {
                    tokio::time::sleep(*delay).await;
                    let count = run_cycle(&cache, &title_cache, &api_key, true).await;
                    if count > 0 {
                        info!("Trigger cycle {}: generated {} titles", i + 1, count);
                    }
                }
            }
            // Periodic scan (every 5 minutes)
            _ = tokio::time::sleep(PERIODIC_INTERVAL) => {
                run_cycle(&cache, &title_cache, &api_key, true).await;
            }
        }
    }
}

/// Generate a title for a session
async fn generate_title(
    messages: &[NormalizedMessage],
    api_key: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    // Use last few messages for context (more relevant for mega sessions)
    let len = messages.len();
    let context_messages: Vec<_> = if len <= 10 {
        messages.iter().collect()
    } else {
        // First 3 (for initial context) + last 7 (for current focus)
        messages.iter().take(3)
            .chain(messages.iter().skip(len - 7))
            .collect()
    };

    if context_messages.is_empty() {
        return Err("No messages to generate title from".into());
    }

    let conversation = context_messages
        .iter()
        .map(|msg| {
            let role = &msg.role;
            let content = msg.content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text[..text.len().min(500)].to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" ");
            format!("{}: {}", role, content)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = TITLE_PROMPT.replace("{conversation}", &conversation);

    let client = reqwest::Client::new();

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": "claude-3-5-haiku-20241022",
            "max_tokens": 50,
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
    let title = body["content"][0]["text"]
        .as_str()
        .unwrap_or("Untitled Session")
        .trim()
        .to_string();

    let title = title.trim_matches('"').trim_matches('\'').to_string();

    let title = if title.len() > 60 {
        format!("{}...", &title[..57])
    } else {
        title
    };

    Ok(title)
}

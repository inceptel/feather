//! # Tmux Session Manager
//!
//! Manages tmux sessions for running Claude CLI instances.
//!
//! ## Session Naming Convention
//!
//! - `feather-{session_id}` - Resumed session (first 8 chars of Claude session ID)
//! - `feather-new-{timestamp}` - Newly spawned session (Claude creates its own ID)
//!
//! ## Usage
//!
//! The TmuxManager handles:
//! - Spawning new Claude CLI sessions in tmux
//! - Resuming existing sessions with `--resume`
//! - Sending messages and signals to running sessions
//! - Capturing terminal output for display

use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;


/// Information about an active tmux session
#[derive(Debug, Clone)]
pub struct TmuxSessionInfo {
    pub session_id: String,
    pub tmux_name: String,
    pub start_time: Instant,
    pub cwd: String,
}

/// Manages Claude CLI sessions running inside tmux.
///
/// Each Claude session runs in its own tmux session, allowing:
/// - Background execution without blocking the web server
/// - Persistent sessions that survive HTTP disconnects
/// - Terminal output capture for display in the UI
pub struct TmuxManager {
    active_sessions: Mutex<HashMap<String, TmuxSessionInfo>>,  // Tracks sessions we spawned
    default_cwd: String,  // Working directory for new sessions (e.g., /mnt/ebs/hft/code)
}

impl TmuxManager {
    /// Create a new TmuxManager with the given default working directory
    pub fn new(default_cwd: String) -> Self {
        Self {
            active_sessions: Mutex::new(HashMap::new()),
            default_cwd,
        }
    }

    /// Convert a Claude session ID to a tmux session name.
    ///
    /// - Full session IDs (UUIDs) are truncated to 8 chars: "abc12345-..."  -> "feather-abc12345"
    /// - Names already prefixed with "feather-" or "codex-" are used as-is
    pub fn get_session_name(&self, session_id: &str) -> String {
        if session_id.starts_with("feather-") || session_id.starts_with("codex-") {
            session_id.to_string()
        } else {
            format!("feather-{}", &session_id[..8.min(session_id.len())])
        }
    }

    /// Check if a tmux session exists for the given Claude session ID
    pub fn is_session_active(&self, session_id: &str) -> bool {
        let name = self.get_session_name(session_id);
        Command::new("tmux")
            .args(["has-session", "-t", &name])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Get info about an active session
    pub fn get_session_info(&self, session_id: &str) -> Option<TmuxSessionInfo> {
        self.active_sessions.lock().ok()?.get(session_id).cloned()
    }

    /// Spawn a brand new Claude CLI session.
    ///
    /// Claude CLI will generate its own session ID. The tmux session is named
    /// `feather-new-{timestamp}` to distinguish it from resumed sessions.
    ///
    /// Flags used:
    /// - `--dangerously-skip-permissions`: Auto-approve tool use
    /// - `--disallowed-tools AskUserQuestion`: Prevent interactive prompts
    pub fn spawn_new_claude_session(&self, cwd: Option<&str>) -> Result<String, String> {
        let working_dir = cwd.unwrap_or(&self.default_cwd);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let tmux_name = format!("feather-new-{}", timestamp);

        // Spawn Claude CLI without a session ID - it will create a new one
        // Also change tmux prefix to Meta-a to avoid conflicts
        // Use an interactive bash shell to ensure environment variables are loaded
        let command = format!(
            r#"tmux new-session -d -s {} -c "{}" "bash --rcfile ~/.bashrc -ic 'claude --dangerously-skip-permissions --disallowed-tools AskUserQuestion'" \; set-option -t {} prefix M-a"#,
            tmux_name, working_dir, tmux_name
        );

        let output = Command::new("sh")
            .args(["-c", &command])
            .output()
            .map_err(|e| format!("Failed to execute tmux: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "Failed to spawn new Claude session: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        Ok(tmux_name)
    }

    /// Spawn a Codex CLI session in tmux.
    ///
    /// `session_name` should be a full tmux session name (e.g., "codex-<id>").
    /// `flags` are passed directly to the codex CLI invocation.
    pub fn spawn_codex_session(&self, session_name: &str, cwd: &str, flags: &str) -> Result<String, String> {
        let command = format!(
            r#"tmux new-session -d -s {} -c "{}" "bash --rcfile ~/.bashrc -ic 'codex {}'" \; set-option -t {} prefix M-a"#,
            session_name, cwd, flags, session_name
        );

        let output = Command::new("sh")
            .args(["-c", &command])
            .output()
            .map_err(|e| format!("Failed to execute tmux: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "Failed to spawn Codex session: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        // Wait for Codex to be ready (shows the › prompt)
        // Poll up to 10 seconds (20 iterations * 500ms)
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let capture = Command::new("tmux")
                .args(["capture-pane", "-t", session_name, "-p"])
                .output();

            if let Ok(capture) = capture {
                let content = String::from_utf8_lossy(&capture.stdout);
                // Codex shows "›" (Unicode U+203A) when ready
                if content.contains('›') || content.contains("? for shortcuts") {
                    break;
                }
            }
        }

        Ok(session_name.to_string())
    }

    /// Spawn a Pi coding agent session in tmux.
    ///
    /// `session_name` should be a full tmux session name (e.g., "feather-pi-<id>").
    /// `flags` are passed directly to the pi CLI invocation.
    pub fn spawn_pi_session(&self, session_name: &str, cwd: &str, flags: &str, initial_message: Option<&str>) -> Result<String, String> {
        let msg_arg = initial_message
            .map(|m| format!(" {:?}", m))  // Shell-quoted message
            .unwrap_or_default();
        // Inject ~/SYSTEM_PROMPT.md, ~/memory/MEMORY.md, and project CLAUDE.md if it exists
        // Shell-level check so it runs in the right cwd context
        let command = format!(
            r#"tmux new-session -d -s {} -c "{}" "bash --rcfile ~/.bashrc -ic 'cd {} && APPEND=\"--append-system-prompt ~/SYSTEM_PROMPT.md --append-system-prompt ~/memory/MEMORY.md\"; test -f CLAUDE.md && APPEND=\"\$APPEND --append-system-prompt CLAUDE.md\"; pi \$APPEND {}{}'" \; set-option -t {} prefix M-a"#,
            session_name, cwd, cwd, flags, msg_arg, session_name
        );

        let output = Command::new("sh")
            .args(["-c", &command])
            .output()
            .map_err(|e| format!("Failed to execute tmux: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "Failed to spawn Pi session: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        // Don't wait for Pi's prompt here — pi_new sends a bootstrap message
        // and polls for the session file which is faster than waiting for the TUI prompt.

        Ok(session_name.to_string())
    }

    /// Resume an existing Claude session in a new tmux session.
    ///
    /// Uses `claude --resume {session_id}` to resume the conversation history.
    /// Returns error if a tmux session for this ID already exists.
    pub fn spawn_claude_session(&self, session_id: &str, cwd: Option<&str>) -> Result<TmuxSessionInfo, String> {
        let name = self.get_session_name(session_id);
        let working_dir = cwd.unwrap_or(&self.default_cwd);

        if self.is_session_active(session_id) {
            if let Some(existing) = self.get_session_info(session_id) {
                return Ok(existing);
            }
            return Err("Session already active".to_string());
        }

        // Spawn Claude CLI in tmux session with --resume
        // Use an interactive bash shell to ensure environment variables are loaded
        let command = format!(
            r#"tmux new-session -d -s {} -c "{}" "bash --rcfile ~/.bashrc -ic 'claude --resume {} --dangerously-skip-permissions --disallowed-tools AskUserQuestion'" \; set-option -t {} prefix M-a"#,
            name, working_dir, session_id, name
        );

        let output = Command::new("sh")
            .args(["-c", &command])
            .output()
            .map_err(|e| format!("Failed to execute tmux: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "Failed to spawn Claude session: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        let info = TmuxSessionInfo {
            session_id: session_id.to_string(),
            tmux_name: name,
            start_time: Instant::now(),
            cwd: working_dir.to_string(),
        };

        if let Ok(mut sessions) = self.active_sessions.lock() {
            sessions.insert(session_id.to_string(), info.clone());
        }

        Ok(info)
    }

    /// Send a message to Claude CLI via tmux send-keys.
    ///
    /// The message is escaped for shell safety, then sent with literal mode (-l)
    /// followed by Enter to submit.
    pub fn send_message(&self, session_id: &str, message: &str) -> Result<(), String> {
        let name = self.get_session_name(session_id);

        if !self.is_session_active(session_id) {
            return Err("Session not active".to_string());
        }

        // Send the message text literally with a small delay before Enter
        // This helps ensure the text is fully buffered before Enter is processed
        let send_text = Command::new("tmux")
            .args(["send-keys", "-t", &name, "-l", message])
            .output()
            .map_err(|e| format!("Failed to send text: {}", e))?;

        if !send_text.status.success() {
            return Err("Failed to send text to tmux".to_string());
        }

        // Small delay to ensure text is fully processed before Enter
        std::thread::sleep(std::time::Duration::from_millis(100));

        // Send Enter
        let send_enter = Command::new("tmux")
            .args(["send-keys", "-t", &name, "Enter"])
            .output()
            .map_err(|e| format!("Failed to send Enter: {}", e))?;

        if !send_enter.status.success() {
            return Err("Failed to send Enter to tmux".to_string());
        }

        Ok(())
    }

    /// Send a control signal to the tmux session
    pub fn send_signal(&self, session_id: &str, signal: &str) -> Result<(), String> {
        let name = self.get_session_name(session_id);

        if !self.is_session_active(session_id) {
            return Err("Session not active".to_string());
        }

        let output = Command::new("tmux")
            .args(["send-keys", "-t", &name, signal])
            .output()
            .map_err(|e| format!("Failed to send signal: {}", e))?;

        if !output.status.success() {
            return Err("Failed to send signal to tmux".to_string());
        }

        Ok(())
    }

    /// Kill the tmux session
    pub fn kill_session(&self, session_id: &str) {
        let name = self.get_session_name(session_id);

        let _ = Command::new("tmux")
            .args(["kill-session", "-t", &name])
            .output();

        if let Ok(mut sessions) = self.active_sessions.lock() {
            sessions.remove(session_id);
        }
    }

    /// Capture terminal output from a tmux pane.
    ///
    /// Uses `tmux capture-pane` to get the last N lines of output.
    /// Returns empty string if session doesn't exist or capture fails.
    pub fn capture_output(&self, session_id: &str, lines: u32) -> String {
        let name = self.get_session_name(session_id);

        if !self.is_session_active(session_id) {
            return String::new();
        }

        // -p: Print to stdout, -S -N: Start from N lines ago
        let output = Command::new("tmux")
            .args([
                "capture-pane",
                "-t", &name,
                "-p",
                "-S", &format!("-{}", lines),
            ])
            .output();

        match output {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
            _ => String::new(),
        }
    }

    /// List all feather-managed tmux sessions.
    ///
    /// Returns session names starting with "feather-" prefix.
    /// Used to show active sessions in the UI sidebar.
    pub fn list_tmux_sessions(&self) -> Vec<String> {
        let output = Command::new("tmux")
            .args(["list-sessions", "-F", "#{session_name}"])
            .output();

        match output {
            Ok(o) if o.status.success() => {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter(|s| s.starts_with("feather-"))
                    .map(|s| s.to_string())
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    /// Kill all feather tmux sessions
    pub fn kill_all_sessions(&self) {
        for session in self.list_tmux_sessions() {
            let _ = Command::new("tmux")
                .args(["kill-session", "-t", &session])
                .output();
        }

        if let Ok(mut sessions) = self.active_sessions.lock() {
            sessions.clear();
        }
    }
}

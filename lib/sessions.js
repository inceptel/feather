// Session list helpers shared by server.js and its tests.

// A finished session's tmux pane lingers up to the idle-reaper window (~1h),
// so "tmux is alive" alone is NOT a good signal for the green "active" dot —
// it showed finished sessions as online long after they went idle. Require a
// recent JSONL write too.
export const ACTIVE_MS = 10 * 60 * 1000; // 10 min since last write

// Returns true only when there is a live tmux session for `id` AND its JSONL
// was written within `activeMs`. `activeTmux` is the Set of 8-char id prefixes
// from getActiveTmuxSessions(); `mtimeMs`/`now` are epoch millis.
export function sessionIsActive(activeTmux, id, mtimeMs, now, activeMs = ACTIVE_MS) {
  return activeTmux.has(id.slice(0, 8)) && (now - mtimeMs) < activeMs;
}

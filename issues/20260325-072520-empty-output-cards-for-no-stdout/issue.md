# Bug: Empty OUTPUT cards rendered for tools with no stdout

## Status
new

## Severity
medium

## Steps to reproduce
1. Open any session in Feather (both mobile 390x844 and desktop 1280x800)
2. Scroll through the conversation to find tool call/result pairs
3. Look for Bash commands that redirect output (e.g., `printf "..." >> file`) or produce no stdout
4. The tool_result OUTPUT card shows just the "OUTPUT" header badge with no content below

## Expected behavior
When a tool result has empty content, the OUTPUT card should either:
- Not render at all (skip rendering for empty results)
- Show a placeholder like "(no output)" or "(empty)" in muted text
- Display a minimal indicator like a checkmark showing the command succeeded

## Actual behavior
A green-bordered OUTPUT card renders with just the "OUTPUT" header label and no content below it. This creates a confusing floating badge that takes up significant vertical space while conveying no information. The user sees "OUTPUT" and expects content but finds nothing.

## Data
- **86 instances** across **49 out of 50 sessions** (nearly universal)
- Primary causes:
  - **Bash commands** with redirected output (`printf ... >> file`, `mkdir -p`, loops with no echo)
  - **Read tool** on empty files (0-byte files)
- Distinct from issue #6 (image-content-dropped): that issue is about image content being silently dropped; this issue is about genuinely empty tool outputs

## Examples
- `printf "%s\tskip\tNo new issues\n" "$(date ...)" >> results.tsv` — output goes to file, stdout is empty
- `for d in $(ls -d $WORKTREE/issues/*/); do ... done` — loop processes files but echoes nothing to stdout

## Screenshots
- empty-output-desktop.png — Desktop view showing two empty OUTPUT badges (top-right and mid-right) vs. one OUTPUT card with actual content
- desktop-mid.png — Another desktop view showing the sparse empty OUTPUT cards

## Environment
- Viewport: 390x844 (mobile) and 1280x800 (desktop)
- Browser: Chromium (agent-browser)

# Bug: Mobile tool cards hard-wrap commands and output into unreadable fragments

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer.
3. Select a session that contains Bash/tool cards with long commands or output. One current repro is the session titled `WORKER_NUM=2 WORKTREE=/home/user/feather-dev/w2 PORT=3302 WORKER_DIR=/home/user/`.
4. Stay on the Chat tab and view the recent tool cards.

## Expected behavior
Long command lines and tool output should remain readable, typically by preserving line structure and allowing horizontal scrolling inside the code/tool block.

## Actual behavior
The Bash/tool cards wrap long commands and output aggressively inside the narrow mobile bubble, splitting tokens and file paths across multiple lines. In the repro screenshot, the `printf "%s\tskip...` command and the output path `/home/user/feather-aw/w2/breadcrumbs.md` are broken into unreadable fragments.

## Screenshots
- mobile-tool-card-wrap.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)

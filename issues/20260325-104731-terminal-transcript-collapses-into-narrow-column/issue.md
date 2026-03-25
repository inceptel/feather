# Bug: Terminal transcript collapses into a narrow column on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the seeded session to render.
3. Tap `Terminal`.

## Expected behavior
The terminal transcript should use the available mobile width so each line remains readable.

## Actual behavior
After switching to `Terminal`, the transcript wraps into a tiny vertical strip only a few characters wide even though the viewport still has the full mobile width available. In the captured state, normal prose like `Codex finder is a bug-finding machine...` is broken into one-word and one-syllable fragments stacked down the screen, making the terminal effectively unreadable.

## Screenshots
- terminal-drawer-open.png
- terminal-collapsed-full.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)

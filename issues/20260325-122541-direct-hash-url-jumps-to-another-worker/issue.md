# Bug: Direct session URL can jump to another worker root

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for Feather to settle after the initial load.

## Expected behavior
Feather should stay on port `3304` and either open the `hello old friend` session identified by the hash or show an error while preserving the original worker URL.

## Actual behavior
On `2026-03-25`, a fresh run on worker 4 did not stay on the requested URL. After opening `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf`, Feather ended on another worker's root URL with the hash stripped (`http://localhost:3302/`) and showed the empty `Select a session` state instead of the requested session.

## Screenshots
- final-mobile-session.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
- Verification note: `agent-browser eval 'location.href'` returned `http://localhost:3302/` after the page was opened from `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf`

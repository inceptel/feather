# Bug: Terminal tab never connects because the frontend uses the wrong WebSocket path

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open any session.
3. Switch from `Chat` to `Terminal`.
4. Wait for the terminal to connect.

## Expected behavior
The terminal tab should attach to the live tmux session and stream terminal output.

## Actual behavior
The frontend points the terminal WebSocket at `/new-dev/api/terminal`, but the server only upgrades `/api/terminal`, so the terminal connection never opens.

## Evidence
- `frontend/src/components/Terminal.tsx:6` uses `/new-dev/api/terminal`
- `server.js:318` only upgrades requests starting with `/api/terminal`
- Live verification on port `3304`:
  - `ws://localhost:3304/new-dev/api/terminal?session=370e2f60-1399-4ebf-a182-7a8ba6c59ccf` -> `socket hang up` / close `1006`
  - `ws://localhost:3304/api/terminal?session=370e2f60-1399-4ebf-a182-7a8ba6c59ccf` -> opens successfully

## Screenshots
- websocket-evidence.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium automation
- App URL: `http://localhost:3304/`

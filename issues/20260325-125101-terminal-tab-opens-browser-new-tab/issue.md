# Bug: Terminal tab opens browser new tab

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`) in Chromium.
2. Wait for the chat transcript to render.
3. Tap the `Terminal` tab in the chat header.

## Expected behavior
The app should stay on the current Feather session and switch the content pane to the terminal view.

## Actual behavior
Feather leaves the app entirely and opens Chrome's new-tab page. `agent-browser eval 'location.href'` returns `chrome://new-tab-page/` immediately after the tap.

## Screenshots
- before-terminal-tab.png
- after-terminal-tab.png
- terminal-newtab-verify.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)

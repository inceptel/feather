# Bug: Mobile session drawer reserves a desktop-style scrollbar gutter

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the session drawer.
3. Look at the right edge of the session list.

## Expected behavior
On mobile, the drawer should use the available width for session content. Any scrollbar should be overlayed or hidden until needed, not permanently consume a large gutter.

## Actual behavior
The session list reserves a full desktop-style scrollbar gutter that stays visible on mobile. In the live DOM, the scrollable list measured `offsetWidth: 299` but only `clientWidth: 284`, so about `15px` of the drawer width is lost to the gutter on a `390px` viewport. The screenshot shows a bright vertical scrollbar track permanently occupying that space.

## Screenshots
- drawer-scrollbar.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)

## Verification
`agent-browser eval` on the open drawer returned the top scroll container as:

```json
{
  "clientHeight": 440,
  "clientWidth": 284,
  "offsetWidth": 299,
  "overflowY": "auto",
  "scrollHeight": 2000,
  "scrollWidth": 284,
  "tag": "DIV",
  "text": "WORKER_NUM=1 WORKTREE=/home/user/feather"
}
```

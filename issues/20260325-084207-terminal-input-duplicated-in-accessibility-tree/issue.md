# Bug: Terminal input is duplicated in the accessibility tree

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Switch to the `Terminal` tab.
3. Capture an accessibility snapshot with `agent-browser snapshot -i`.

## Expected behavior
The terminal should expose one text input target for assistive technology.

## Actual behavior
The mobile Terminal tab exposes two `Terminal input` textboxes in the accessibility tree:
- `textbox "Terminal input"`
- child `textbox "Terminal input"`

That duplication makes the terminal input ambiguous for screen-reader and switch-control users.

## Evidence
- `agent-browser snapshot -i` returned:
  `- textbox "Terminal input"`
  `  - textbox "Terminal input"`
- DOM inspection on the same screen found both a `div[role="textbox"][aria-label="Terminal input"]` and a hidden `textarea[aria-label="Terminal input"]`.

## Screenshots
- terminal-mobile.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- URL: `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf`

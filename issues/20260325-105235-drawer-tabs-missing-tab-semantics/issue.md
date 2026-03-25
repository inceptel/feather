# Bug: Drawer Sessions and Links switchers missing tab semantics

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile at `390x844`.
2. Tap the hamburger button to open the left drawer.
3. Inspect the `Sessions` and `Links` switchers in the drawer.

## Expected behavior
The drawer switchers should be exposed as an actual tab interface, with a parent `tablist` and per-tab semantics such as `role="tab"`, selected state, and relationships to the controlled panel.

## Actual behavior
The switchers are plain `button` elements with no `tablist`, no `role="tab"`, no `aria-selected`, and no `aria-controls`, even though they behave like a two-tab view selector.

## Screenshots
- drawer-tabs-semantics.png

## Verification
- Selenium mobile emulation (`390x844`) found `Sessions` and `Links` as plain `button` elements with `role=null`, `aria-selected=null`, and `aria-controls=null`.
- DOM inspection found no element with `role="tablist"` while the drawer was open.

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium

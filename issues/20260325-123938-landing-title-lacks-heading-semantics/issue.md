# Bug: Mobile landing title lacks heading semantics

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Wait for the empty landing state that shows the visible title `Select a session`.
3. Inspect the DOM or Chrome accessibility tree for that title.

## Expected behavior
The primary page title should be exposed as a heading, for example with an `h1` or `role="heading"` plus an `aria-level`, so screen reader users can navigate to the page title.

## Actual behavior
The visible `Select a session` title renders inside a plain `DIV`, the page exposes no headings at all, and Chrome's accessibility tree reports the title only as `StaticText`.

## Evidence
- Selenium mobile emulation on `390x844` found `document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=\"heading\"]').length === 0`.
- The visible `Select a session` node resolved to `tag: DIV`, `role: null`, `ariaLevel: null`.
- `Accessibility.getFullAXTree` exposed `Select a session` as `StaticText` / `InlineTextBox`, not a heading.

## Screenshots
- landing-title-no-heading.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium and agent-browser

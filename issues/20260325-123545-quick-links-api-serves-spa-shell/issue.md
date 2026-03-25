# Bug: Quick links API serves the SPA shell instead of JSON

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/api/quick-links`.
2. Observe the network response headers and body.
3. Compare that response with the frontend call in `frontend/src/App.tsx`, which does `fetch(...).then(r => r.json())`.

## Expected behavior
`/api/quick-links` should return JSON so the Links drawer can load saved quick links.

## Actual behavior
`/api/quick-links` responds with the Feather SPA shell (`Content-Type: text/html; charset=utf-8`) instead of JSON. On port `3304`, `curl -i http://localhost:3304/api/quick-links` returned `200 OK` with the app `index.html` body, so the frontend's `r.json()` path throws and the Links tab can never populate from this endpoint.

## Screenshots
- quick-links-route.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- Verified at: 2026-03-25T12:35:45Z

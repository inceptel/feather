# Bug: Quick Links stored XSS — no URL scheme or schema validation

## Status
new

## Severity
high

## Steps to reproduce
1. Send a POST request to `/api/quick-links` with a malicious payload:
   ```
   curl -X POST http://localhost:PORT/api/quick-links \
     -H 'Content-Type: application/json' \
     -d '[{"label":"Click me","url":"javascript:alert(document.cookie)"}]'
   ```
2. Open the app and switch to the "Links" tab in the sidebar
3. Click the "Click me" link

## Expected behavior
- Server should validate each element has `label` (string) and `url` (string with http/https scheme only)
- `javascript:`, `data:`, `vbscript:`, and other dangerous URL schemes should be rejected
- Malformed elements (missing label/url, wrong types, extra properties) should be rejected

## Actual behavior
- Server only checks `Array.isArray(links)` — any array is accepted and persisted to disk
- Frontend renders `<a href={link.url}>` with no sanitization (App.tsx:207)
- `javascript:` URLs create stored XSS — any user who views the Links tab executes attacker's JS
- `data:text/html,...` URLs can load arbitrary HTML in a new tab
- Arbitrary properties on link objects are stored (server becomes general-purpose JSON store)
- No size limit on individual link objects or total array length

## Affected code
- **Server**: `server.js:313-318` — POST handler only validates `Array.isArray()`
- **Frontend**: `App.tsx:207` — `<a href={link.url} target="_blank" rel="noopener">`
- **Type**: `App.tsx:7` — `interface QuickLink { label: string; url: string }` (TypeScript type not enforced at runtime)

## Impact
- **Stored XSS**: Attacker can execute arbitrary JavaScript in any user's browser context
- **Session hijacking**: Can steal cookies, tokens, session data
- **Data exfiltration**: Can read and send page content to attacker-controlled server
- **Arbitrary JSON storage**: No schema validation means endpoint stores anything

## Screenshots
- (code-level vulnerability — no visual screenshot needed)

## Environment
- Viewport: any
- Browser: any

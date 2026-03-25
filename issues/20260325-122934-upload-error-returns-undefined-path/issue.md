# Bug: uploadFile silently returns undefined path on server error

## Status
new

## Severity
medium

## Steps to reproduce
1. Open any session in Feather
2. Attach an image or file to a message
3. If the server upload endpoint returns an HTTP error (500, 413, etc.), the upload "succeeds" silently
4. The sent message contains `[Attached image: undefined]` instead of showing an error

## Expected behavior
- `uploadFile` should check `r.ok` and throw an error on non-2xx responses
- The catch block in `handleSend` should trigger, showing `[Upload failed: filename]`
- The user should see clear feedback that the upload failed

## Actual behavior
- `uploadFile` (api.ts:56-64) calls `await r.json()` without checking `r.ok`
- On server error, response is `{ error: "..." }` — valid JSON but no `path` field
- Destructuring `const { path } = await r.json()` gives `path = undefined`
- Function returns `undefined` (no throw)
- `handleSend` (App.tsx:137) never enters the catch block
- Message text becomes `[Attached image: undefined]`
- This is sent to the Claude session as a real message with a broken reference

## Code trace

**api.ts:56-64:**
```typescript
export async function uploadFile(blob: Blob, name: string): Promise<string> {
  const r = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
    body: blob,
  })
  const { path } = await r.json()  // ← Missing: if (!r.ok) throw new Error(...)
  return path                       // ← Returns undefined on error
}
```

**App.tsx:135-140 (handleSend):**
```typescript
try {
    const uploadPath = await uploadFile(f.blob, f.name)
    // uploadPath is undefined but no error thrown
    parts.push(f.isImage ? `[Attached image: ${uploadPath}]` : `[Attached file: ${uploadPath}] (${f.name})`)
} catch { parts.push(`[Upload failed: ${f.name}]`) }  // ← Never reached
```

**server.js:289-300 (server error response):**
```javascript
catch (e) { res.status(500).json({ error: e.message }); }
// Returns { error: "..." } — valid JSON, no path field
```

## Impact
- User thinks file was uploaded successfully but the message references a non-existent path
- Claude agent receives broken `[Attached image: undefined]` text
- The error path exists in handleSend (catch block) but is never triggered due to missing r.ok check
- Same pattern as issue #24 (create-session-ignores-server-errors) — missing HTTP status checks

## Fix
Add `if (!r.ok) throw new Error(...)` to uploadFile, same as fetchSessions and fetchMessages already do.

## Screenshots
- session-view.png — general session view showing tool cards and message bubbles

## Environment
- Viewport: any
- Browser: any

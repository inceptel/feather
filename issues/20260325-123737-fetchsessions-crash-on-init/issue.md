# Bug: fetchSessions() crash in onMount breaks entire app initialization

## Status
new

## Severity
high

## Steps to reproduce
1. Open Feather when the server is temporarily unavailable, returns HTTP 500, or has a network error
2. Or: open Feather during a brief server restart / deploy

## Expected behavior
- App shows an error message like "Failed to load sessions"
- Hash-based navigation still attempts to load the session from the URL
- Quick links still load independently
- Retry mechanism or manual refresh prompt is shown

## Actual behavior
- App silently fails — `sessions()` stays as empty array `[]`
- **Quick-links fetch never runs** (line 71 never reached)
- **Hash navigation never runs** (lines 72-73 never reached)
- User sees empty sidebar with no error message
- No way to recover except manual full page refresh
- Browser console shows unhandled promise rejection

## Root cause

In `App.tsx:68-69`, `onMount` calls `fetchSessions()` without try/catch:

```typescript
onMount(async () => {
    setSessions(await fetchSessions())           // line 69 — throws if server returns non-2xx
    const base = location.pathname.replace(/\/+$/, '')
    fetch(`${base}/api/quick-links`).then(...)   // line 71 — NEVER REACHED on error
    const hash = location.hash.slice(1)
    if (hash) select(hash)                       // line 73 — NEVER REACHED on error
})
```

`fetchSessions()` in `api.ts:29-31` throws on non-OK responses:
```typescript
export async function fetchSessions(): Promise<SessionMeta[]> {
    const r = await fetch(`${BASE}/api/sessions`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return (await r.json()).sessions
}
```

When the await on line 69 throws, the entire async onMount callback aborts. This is a cascade failure — three independent operations (fetch sessions, fetch quick-links, hash navigation) are serialized so one failure kills all three.

Note: `handleNew()` at line 113 correctly handles this with `.catch(() => {})`, showing the pattern was considered elsewhere but missed in onMount.

## Impact
- Any transient server error during page load renders the entire app non-functional
- Hash URLs (bookmarks, shared links) break silently
- Quick links don't load
- Only recovery is a full page refresh after the server recovers
- This is especially impactful for mobile users who may have flaky connections

## Suggested fix
Wrap `fetchSessions()` in try/catch and make the three onMount operations independent:

```typescript
onMount(async () => {
    try { setSessions(await fetchSessions()) } catch { /* show error state */ }
    const base = location.pathname.replace(/\/+$/, '')
    fetch(`${base}/api/quick-links`).then(r => r.json()).then(setLinks).catch(() => {})
    const hash = location.hash.slice(1)
    if (hash) select(hash)
})
```

## Environment
- File: frontend/src/App.tsx, line 68-74
- Related: api.ts line 29-31

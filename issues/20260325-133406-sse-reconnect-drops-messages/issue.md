# Bug: SSE reconnection silently drops messages — server ignores Last-Event-ID

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ and select an active session with streaming messages
2. Trigger a brief network disconnection (e.g., server restart, network blip, or laptop sleep/wake)
3. Wait for the EventSource to auto-reconnect (typically 3-5 seconds)
4. Compare the chat view with the actual JSONL file

## Expected behavior
After reconnection, the SSE stream should replay any messages that were missed during the disconnection, using the `Last-Event-ID` header sent by the browser.

## Actual behavior
Messages emitted between the disconnect and reconnect are permanently lost from the live view. The chat shows a gap — the user sees older messages and new messages arriving after reconnection, but everything in between is missing. Only a full page refresh recovers the missing messages.

## Root cause

The server correctly assigns event IDs to each SSE message but completely ignores them on reconnection.

**Server sends event IDs (server.js:161):**
```javascript
const chunk = `id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`;
```

Each SSE event has an `id` field set to the byte offset in the JSONL file. Per the SSE spec, browsers store this and send it back as `Last-Event-ID` when reconnecting.

**Server ignores Last-Event-ID on reconnection (server.js:259-267):**
```javascript
app.get('/api/sessions/:id/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', ... });
  res.write('event: connected\ndata: {}\n\n');
  const sid = req.params.id;
  if (!sseClients.has(sid)) sseClients.set(sid, new Set());
  sseClients.get(sid).add(res);
  // ← Never reads req.headers['last-event-id']
  // ← Never replays messages from the missed offset
  ...
});
```

When EventSource reconnects, it sends `Last-Event-ID: <offset>`. The server has all the information needed to replay missed messages (the JSONL file and the byte offset), but it doesn't read the header or replay anything.

**Client has no fallback (api.ts:67-69):**
```javascript
export function subscribeMessages(id: string, onMessage: (msg: Message) => void): () => void {
  const es = new EventSource(`${BASE}/api/sessions/${id}/stream`)
  es.addEventListener('message', (e) => { try { onMessage(JSON.parse(e.data)) } catch {} })
  // ← No onerror handler — user gets no feedback about disconnection
  return () => es.close()
}
```

No `onerror` handler means:
1. User has no visual indication of SSE disconnection
2. No client-side fallback (like re-fetching messages) on reconnection
3. Silent data loss with no way to know messages were missed

## Impact
- During active coding sessions, brief network interruptions cause invisible gaps in the conversation
- Server restarts (common during development/deployment) lose in-flight messages
- Mobile users on flaky connections may see intermittent message loss
- The bug is particularly insidious because there's no error or indication — the conversation just has an invisible gap
- All the infrastructure for replay exists (event IDs, byte offsets, JSONL files) — it's just not wired up

## Fix suggestion
Read `Last-Event-ID` in the SSE handler and replay missed messages:

```javascript
app.get('/api/sessions/:id/stream', (req, res) => {
  // ... existing setup ...

  const lastEventId = parseInt(req.headers['last-event-id']);
  if (lastEventId > 0) {
    // Replay missed messages from the JSONL file starting at the offset
    const fpath = findJsonlPath(sid);
    if (fpath) {
      const stat = fs.statSync(fpath);
      if (stat.size > lastEventId) {
        const fd = fs.openSync(fpath, 'r');
        const buf = Buffer.alloc(stat.size - lastEventId);
        fs.readSync(fd, buf, 0, buf.length, lastEventId);
        fs.closeSync(fd);
        let offset = lastEventId;
        for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
          offset += Buffer.byteLength(line + '\n');
          const parsed = parseMessage(line);
          if (parsed) {
            res.write(`id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`);
          }
        }
      }
    }
  }

  sseClients.get(sid).add(res);
  // ... rest of handler ...
});
```

Also add an `onerror` handler on the client to provide disconnection feedback.

## Screenshots
- sse-test.png — App landing page (demonstrating active SSE connection architecture)

## Environment
- Viewport: any
- Browser: Chromium (agent-browser) / any browser with EventSource support

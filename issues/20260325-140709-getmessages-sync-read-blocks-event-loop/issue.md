# Bug: getMessages reads entire JSONL file synchronously, blocking event loop

## Status
new

## Severity
high

## Description

`getMessages()` in server.js (line 26-36) uses `fs.readFileSync` to read the entire JSONL file into memory, splits all lines, parses every JSON line, then returns only the last 100 messages. For large session files, this blocks the Node.js event loop for hundreds of milliseconds and causes a massive memory spike. The endpoint `/api/sessions/:id/messages` is called every time a user selects a session.

## Steps to reproduce
1. Open Feather and click on a session with a large JSONL file (e.g., 82MB / 19228 lines)
2. The server blocks completely for ~586ms while reading and parsing the entire file
3. All concurrent requests (SSE heartbeats, other session loads, health checks) are frozen

## Evidence — benchmark on actual data

Tested with the largest JSONL file on this instance:

```
File size: 81.9 MB
Lines:     19,228
readFileSync:  311ms (event loop blocked)
split+filter:   60ms (event loop blocked)
JSON.parse all: 214ms (event loop blocked)
Total blocking: 586ms
Peak RSS:       216 MB (from ~40MB baseline)
```

## Code location

server.js lines 26-36:
```js
function getMessages(sessionId, limit = 100) {
  const fpath = findJsonlPath(sessionId);
  if (!fpath || !fs.existsSync(fpath)) return [];
  const lines = fs.readFileSync(fpath, 'utf8').split('\n').filter(Boolean);
  const msgs = [];
  for (const line of lines) {
    const m = parseMessage(line);
    if (m) msgs.push(m);
  }
  return msgs.slice(-limit);
}
```

## Problems

1. **Event loop blocked for 586ms** on 82MB file — all HTTP requests frozen during this time
2. **216MB peak RSS** — 5x the file size due to string + array + parsed objects all in memory simultaneously
3. **Reads and parses ALL 19228 lines** only to keep the last 100 — 99.5% of work is wasted
4. **Scales with file size, not limit** — even `?limit=1` reads the entire file
5. **Repeated on every session select** — no caching, no streaming, no async read

## File size distribution

The top 20 JSONL files range from 7-82MB. There are 8,682 total JSONL files. Any session click on a large file freezes the server.

## Expected behavior

Read only the last N lines/bytes of the file (tail-read), or stream the file asynchronously, or cache parsed results. The `limit` parameter should control how much of the file is read, not just how many results are returned.

## Environment
- Server: Node.js, server.js
- Largest file: 82MB, 19228 lines
- Total files: 8682

# Bug: Upload endpoint has no request body size limit — DoS via memory exhaustion

## Status
new

## Severity
high

## Steps to reproduce
1. Send a POST request to `/api/upload` with a very large body (e.g., 1GB)
2. The server accumulates the entire body in memory before writing to disk
3. Server crashes with OOM or becomes unresponsive

```bash
# Example: send a 500MB payload to crash the server
dd if=/dev/zero bs=1M count=500 | curl -X POST http://localhost:3301/api/upload \
  -H "Content-Type: application/octet-stream" \
  -H "X-Filename: large-file.bin" \
  --data-binary @-
```

## Expected behavior
- The upload endpoint should enforce a maximum file size (e.g., 10MB)
- Requests exceeding the limit should be rejected with HTTP 413 (Payload Too Large)
- The server should remain responsive after receiving oversized requests
- Ideally, the server should stream to disk rather than buffering in memory

## Actual behavior
The upload handler (server.js:289-300) reads the ENTIRE request body into memory with no size limit:

```javascript
app.post('/api/upload', async (req, res) => {
  try {
    // ... filename handling ...
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);    // ← unbounded memory accumulation
    fs.writeFileSync(fpath, Buffer.concat(chunks));         // ← blocks event loop for large files
    res.json({ path: `/uploads/${dest}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

**No mitigating factors:**
- `express.json()` (line 247) only limits JSON bodies to 100KB — doesn't apply to `application/octet-stream`
- No `express.raw()` or body-parser middleware with size limits
- No Content-Length header validation
- Node.js HTTP server has no default body size limit
- No disk quota or file count limit on the uploads directory

**Two separate impacts from a single large request:**
1. **Memory exhaustion**: All chunks stored in an array, then concatenated into a single Buffer — peak memory usage is ~2x the payload size (array + concat result)
2. **Event loop blocking**: `fs.writeFileSync` blocks the entire Node.js process while writing a large file to disk, making the server unresponsive to all other requests during the write

## Additional concern
The uploads directory (server.js:243-244) has no cleanup mechanism — files accumulate indefinitely. Combined with no size limit per file and no authentication, this is also a disk exhaustion vector.

## Fix
Add request body size validation:
```javascript
app.post('/api/upload', async (req, res) => {
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_SIZE) return res.status(413).json({ error: 'File too large (max 10MB)' });
    chunks.push(chunk);
  }
  // ... rest of handler
});
```

Or better: use streaming writes with `fs.createWriteStream()` to avoid buffering the entire file in memory.

## Screenshots
N/A — server-side code analysis

## Environment
- Server: Node.js + Express
- File: server.js:289-300

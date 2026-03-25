# Bug: fs.watch creates duplicate watchers on project directories

## Status
new

## Severity
medium

## Location
server.js lines 224-238

## Description
The parent directory watcher on `CLAUDE_PROJECTS` (line 224) creates a new `fs.watch()` on a project subdirectory every time a filesystem event fires for that directory entry. There is no Set or Map tracking which directories already have watchers, so duplicate watchers accumulate.

## Root cause
```js
// line 224-238
fs.watch(CLAUDE_PROJECTS, (event, filename) => {
    if (!filename) return;
    const dp = path.join(CLAUDE_PROJECTS, filename);
    try {
      if (fs.statSync(dp).isDirectory()) {
        fs.watch(dp, (ev, fn) => { // <-- NEW watcher every time!
          // ...
          processFileChange(path.join(dp, fn));
        });
      }
    } catch {}
  });
```

Three problems:
1. **No deduplication** — no Set tracks which directories already have watchers
2. **Duplicate events** — Node.js `fs.watch` commonly fires 2+ events for a single filesystem operation (documented behavior: "the callback is not guaranteed to be called only once")
3. **Never closed** — old `fs.watch` instances are never `.close()`d, leaking file descriptors

## Impact
- Each duplicate watcher independently calls `processFileChange()` → `broadcast()`, sending duplicate SSE messages to all connected clients
- Client-side UUID dedup (`prev.some(m => m.uuid === msg.uuid)`) prevents duplicate rendering, but:
  - Wastes bandwidth (same SSE event sent N times per watcher)
  - Race condition on `fileOffsets` Map — concurrent reads of same file region from multiple watcher callbacks
- File descriptor leak — each stray `fs.watch` holds an fd indefinitely, accumulating over long server uptime
- With 18 project directories, a single directory creation event (2-3 duplicate fires) creates 2-3 redundant watchers per directory

## Fix suggestion
Track watched directories in a Set; check before creating new watchers:
```js
const watchedDirs = new Set();

// In the parent watcher callback:
if (fs.statSync(dp).isDirectory() && !watchedDirs.has(dp)) {
  watchedDirs.add(dp);
  fs.watch(dp, (ev, fn) => { ... });
}
```

## Environment
- Server: Node.js, Linux (inotify)
- 18 project directories, 9830 JSONL files

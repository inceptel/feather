# Bug: Command injection in spawnSession and resumeSession via unsanitized user input

## Status
new

## Severity
critical

## Steps to reproduce
1. Send a POST request to `/api/sessions` with a crafted `cwd` parameter:
   ```
   curl -X POST http://localhost:PORT/api/sessions \
     -H 'Content-Type: application/json' \
     -d '{"id":"test1234","cwd":"\" && whoami > /tmp/pwned #"}'
   ```
2. Or send a POST to `/api/sessions/PAYLOAD/resume` with a crafted session ID:
   ```
   curl -X POST http://localhost:PORT/api/sessions/$(whoami)/resume \
     -H 'Content-Type: application/json'
   ```
3. Or craft a malicious `id` in the create session request:
   ```
   curl -X POST http://localhost:PORT/api/sessions \
     -H 'Content-Type: application/json' \
     -d '{"id":"$(evil)x","cwd":"/tmp"}'
   ```

## Expected behavior
User-supplied `id` and `cwd` parameters should be sanitized or shell-escaped before being interpolated into shell command strings. Ideally, use `execFileSync` with argument arrays instead of `execSync` with string interpolation.

## Actual behavior
Both `spawnSession` (server.js:121) and `resumeSession` (server.js:128) use `execSync()` with template string interpolation:

```javascript
// spawnSession (line 121)
execSync(`tmux new-session -d -s ${name} -c "${cwd || HOME}" "bash --rcfile ~/.bashrc -ic 'claude --session-id ${id} ...'"`)

// resumeSession (line 128)  
execSync(`tmux new-session -d -s ${name} -c "${cwd || HOME}" "bash --rcfile ~/.bashrc -ic 'claude --resume ${id} ...'"`)
```

Three injection vectors:

1. **`cwd` parameter** (both functions): Wrapped in double quotes but not escaped. A `cwd` containing `"`, `$()`, or backticks breaks out of the quotes and executes arbitrary commands. Source: `req.body.cwd` (lines 270, 280).

2. **`id` parameter in `spawnSession`**: `req.body.id` (line 270) flows to `name` via `tmuxName(id)` = `feather-${id.slice(0, 8)}`. The first 8 chars of a crafted ID can contain shell metacharacters. Also used unsliced in `--session-id ${id}`.

3. **`id` parameter in `resumeSession`**: `req.params.id` (line 280) — the full URL path segment, used unsliced in `--resume ${id}`. An attacker-controlled session ID of any length goes directly into the shell command.

## Impact
Remote code execution. Any client with HTTP access to the Feather server can execute arbitrary commands as the server's user. Since Feather runs with access to `claude --dangerously-skip-permissions`, this is especially dangerous.

## Recommended fix
Replace `execSync` with `execFileSync` and pass arguments as arrays, or at minimum validate/sanitize `id` (UUID format only) and `cwd` (alphanumeric + path separators only) before interpolation.

## Environment
- server.js lines 118-130
- Affects: spawnSession, resumeSession
- Attack surface: `/api/sessions` POST, `/api/sessions/:id/resume` POST

import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { parseMessage } from './lib/parse.js';

const PORT = parseInt(process.env.PORT || '4870');
const HOME = process.env.HOME || '/home/user';
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects');
const STATIC_DIR = path.resolve(import.meta.dirname, 'static');

// ── JSONL parsing ───────────────────────────────────────────────────────────

function findJsonlPath(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return null;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const p = path.join(CLAUDE_PROJECTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

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

// ── Session discovery ───────────────────────────────────────────────────────

function getActiveTmuxSessions() {
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    const active = new Set();
    for (const line of out.split('\n')) {
      if (line.startsWith('feather-')) active.add(line.slice(8)); // first 8 chars of session id
    }
    return active;
  } catch { return new Set(); }
}

function discoverSessions(limit = 50) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];

  // Collect all JSONL files with mtime (cheap stat only, no reads yet)
  const candidates = [];
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dirPath = path.join(CLAUDE_PROJECTS, dir);
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const fpath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(fpath);
          if (stat.size < 50) continue;
          candidates.push({ id: file.replace('.jsonl', ''), fpath, mtime: stat.mtime });
        } catch {}
      }
    } catch {}
  }

  // Sort by mtime descending, take top N (avoid reading 7000+ files)
  candidates.sort((a, b) => b.mtime - a.mtime);
  const top = candidates.slice(0, limit);

  // One tmux call to get all active sessions
  const active = getActiveTmuxSessions();

  // Now read titles only for the top N
  const sessions = [];
  for (const { id, fpath, mtime } of top) {
    try {
      const fd = fs.openSync(fpath, 'r');
      const buf = Buffer.alloc(Math.min(4096, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);

      let title = null;
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        try {
          const d = JSON.parse(line);
          if (d.type === 'user' && !d.isMeta && !d.isSidechain && d.message?.content) {
            const text = typeof d.message.content === 'string' ? d.message.content : '';
            if (text && !text.startsWith('<')) { title = text.slice(0, 80); break; }
          }
        } catch {}
      }

      sessions.push({
        id, title: title || id.slice(0, 8),
        updatedAt: mtime.toISOString(),
        isActive: active.has(id.slice(0, 8)),
      });
    } catch {}
  }

  return sessions;
}

// ── Tmux management ─────────────────────────────────────────────────────────

function tmuxName(id) { return `feather-${id.slice(0, 8)}`; }

function tmuxIsActive(id) {
  try { execFileSync('tmux', ['has-session', '-t', tmuxName(id)], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function spawnSession(id, cwd) {
  const name = tmuxName(id);
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  execSync(`tmux new-session -d -s ${name} -c "${cwd || HOME}" "bash --rcfile ~/.bashrc -ic 'claude --session-id ${id} --dangerously-skip-permissions --disallowed-tools AskUserQuestion'" \\; set-option -t ${name} prefix M-a`, { stdio: 'ignore' });
  setTimeout(() => { try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {} }, 3000);
}

function resumeSession(id, cwd) {
  const name = tmuxName(id);
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  execSync(`tmux new-session -d -s ${name} -c "${cwd || HOME}" "bash --rcfile ~/.bashrc -ic 'claude --resume ${id} --dangerously-skip-permissions --disallowed-tools AskUserQuestion'" \\; set-option -t ${name} prefix M-a`, { stdio: 'ignore' });
  setTimeout(() => { try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {} }, 3000);
}

function sendInput(id, text) {
  if (!tmuxIsActive(id)) resumeSession(id);
  const target = tmuxName(id);
  if (text.length > 500) {
    const tmp = `/tmp/feather-send-${Date.now()}.txt`;
    fs.writeFileSync(tmp, text);
    try {
      execFileSync('tmux', ['load-buffer', tmp], { stdio: 'ignore' });
      execFileSync('tmux', ['paste-buffer', '-t', target], { stdio: 'ignore' });
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    // Give Claude CLI a moment to process the paste, then submit
    setTimeout(() => {
      try { execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, 500);
  } else {
    execFileSync('tmux', ['send-keys', '-t', target, '-l', text], { stdio: 'ignore' });
    execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' });
  }
}

// ── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Map(); // sessionId -> Set<res>

function broadcast(sessionId, line, offset) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const parsed = parseMessage(line);
  if (!parsed) return;
  const chunk = `id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`;
  for (const res of clients) {
    try { res.write(chunk); } catch { clients.delete(res); }
  }
}

// ── File watcher ────────────────────────────────────────────────────────────

const fileOffsets = new Map();

// Init offsets for existing files to current size
if (fs.existsSync(CLAUDE_PROJECTS)) {
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dp = path.join(CLAUDE_PROJECTS, dir);
    try {
      for (const f of fs.readdirSync(dp)) {
        if (!f.endsWith('.jsonl')) continue;
        try { fileOffsets.set(f.replace('.jsonl', ''), fs.statSync(path.join(dp, f)).size); } catch {}
      }
    } catch {}
  }
}

function processFileChange(filePath) {
  if (!filePath.endsWith('.jsonl')) return;
  const sessionId = path.basename(filePath, '.jsonl');
  const currentOffset = fileOffsets.get(sessionId) || 0;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= currentOffset) return;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - currentOffset);
    fs.readSync(fd, buf, 0, buf.length, currentOffset);
    fs.closeSync(fd);
    const content = buf.toString('utf8');
    const lastNL = content.lastIndexOf('\n');
    if (lastNL < 0) return;
    const complete = content.substring(0, lastNL + 1);
    let offset = currentOffset;
    for (const line of complete.split('\n').filter(Boolean)) {
      offset += Buffer.byteLength(line + '\n');
      broadcast(sessionId, line, offset);
    }
    fileOffsets.set(sessionId, currentOffset + Buffer.byteLength(complete));
  } catch {}
}

// Watch each project subdirectory with fs.watch
if (fs.existsSync(CLAUDE_PROJECTS)) {
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dp = path.join(CLAUDE_PROJECTS, dir);
    try {
      fs.watch(dp, (event, filename) => {
        if (filename?.endsWith('.jsonl')) {
          const full = path.join(dp, filename);
          const sid = filename.replace('.jsonl', '');
          if (!fileOffsets.has(sid)) fileOffsets.set(sid, 0);
          processFileChange(full);
        }
      });
    } catch {}
  }
  // Watch for new project directories
  fs.watch(CLAUDE_PROJECTS, (event, filename) => {
    if (!filename) return;
    const dp = path.join(CLAUDE_PROJECTS, filename);
    try {
      if (fs.statSync(dp).isDirectory()) {
        fs.watch(dp, (ev, fn) => {
          if (fn?.endsWith('.jsonl')) {
            const sid = fn.replace('.jsonl', '');
            if (!fileOffsets.has(sid)) fileOffsets.set(sid, 0);
            processFileChange(path.join(dp, fn));
          }
        });
      }
    } catch {}
  });
}

// ── Express ─────────────────────────────────────────────────────────────────

const UPLOADS_DIR = path.resolve(import.meta.dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const app = express();
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/api/sessions', (req, res) => {
  try { res.json({ sessions: discoverSessions(parseInt(req.query.limit) || 50) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/:id/messages', (req, res) => {
  res.json({ messages: getMessages(req.params.id, parseInt(req.query.limit) || 100) });
});

app.get('/api/sessions/:id/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('event: connected\ndata: {}\n\n');
  const sid = req.params.id;
  if (!sseClients.has(sid)) sseClients.set(sid, new Set());
  sseClients.get(sid).add(res);
  const hb = setInterval(() => { try { res.write('event: heartbeat\ndata: {}\n\n'); } catch { clearInterval(hb); } }, 15000);
  res.on('close', () => { clearInterval(hb); sseClients.get(sid)?.delete(res); });
});

app.post('/api/sessions', (req, res) => {
  try { spawnSession(req.body.id, req.body.cwd); res.json({ id: req.body.id, status: 'starting' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/send', (req, res) => {
  try { sendInput(req.params.id, req.body.text); res.json({ ok: true, sentAt: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/resume', (req, res) => {
  try { resumeSession(req.params.id, req.body?.cwd); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/interrupt', (req, res) => {
  try { execFileSync('tmux', ['send-keys', '-t', tmuxName(req.params.id), 'C-c'], { stdio: 'ignore' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload', async (req, res) => {
  try {
    const filename = decodeURIComponent(req.headers['x-filename'] || 'file');
    const safe = filename.replace(/[^a-zA-Z0-9._\- ]/g, '').slice(0, 100);
    const dest = `${Date.now()}-${safe || 'upload'}`;
    const fpath = path.join(UPLOADS_DIR, dest);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    fs.writeFileSync(fpath, Buffer.concat(chunks));
    res.json({ path: `/uploads/${dest}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quick Links ─────────────────────────────────────────────────────────────

const LINKS_FILE = path.resolve(import.meta.dirname, 'quick-links.json');

function readLinks() {
  try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); }
  catch { return []; }
}

app.get('/api/quick-links', (_req, res) => res.json(readLinks()));

app.post('/api/quick-links', (req, res) => {
  const links = req.body;
  if (!Array.isArray(links)) return res.status(400).json({ error: 'expected array' });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.use(express.static(STATIC_DIR));
app.get('/terminal', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'terminal.html')));
app.get('/{*path}', (_req, res) => {
  const index = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(404).send('Frontend not built. Run: cd frontend && npm run build');
});

const server = http.createServer(app);

// ── Terminal WebSocket ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/api/terminal') || req.url?.startsWith('/api/shell')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const isShell = url.pathname === '/api/shell';

  const cleanEnv = { ...process.env };
  delete cleanEnv.TMUX; delete cleanEnv.TMUX_PANE;
  cleanEnv.TERM = 'xterm-256color';

  let term;
  if (isShell) {
    term = pty.spawn('bash', ['--login'], {
      name: 'xterm-256color', cols: 120, rows: 30, cwd: HOME, env: cleanEnv,
    });
  } else {
    const sessionId = url.searchParams.get('session');
    if (!sessionId) { ws.close(1008, 'session required'); return; }
    const name = tmuxName(sessionId);
    if (!tmuxIsActive(sessionId)) { ws.close(1000, 'Session not active'); return; }
    term = pty.spawn('tmux', ['attach', '-t', name], {
      name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
    });
  }

  term.onData(data => { try { ws.send(data); } catch {} });
  term.onExit(() => { try { ws.close(); } catch {} });

  ws.on('message', (msg) => {
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === 'resize') { term.resize(parsed.cols, parsed.rows); return; }
    } catch {}
    term.write(str);
  });

  ws.on('close', () => {
    // Just kill the pty — tmux session survives when an attached client dies
    try { term.kill(); } catch {}
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Feather v2 on http://0.0.0.0:${PORT}`));

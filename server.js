import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { parseMessage } from './lib/parse.js';

const PORT = parseInt(process.env.PORT || '4870');
const HOME = process.env.HOME || '/home/user';
const STATIC_DIR = path.resolve(import.meta.dirname, 'static');
const USERS_FILE = path.resolve(import.meta.dirname, 'users.json');

// ── Users & Auth ────────────────────────────────────────────────────────────

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users; }
  catch { return {}; }
}

const SESSION_FILE = path.resolve(import.meta.dirname, '.sessions.json');
const sessionStore = new Map(); // token -> { username, home, admin, createdAt }
const loginAttempts = new Map(); // ip -> { count, resetAt }

// Persist sessions to disk so restarts don't log everyone out
function saveSessions() {
  const data = Object.fromEntries(sessionStore);
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data), 'utf8');
}
function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) {
      // Skip sessions older than 30 days
      if (v.createdAt && Date.now() - v.createdAt > 30 * 24 * 60 * 60 * 1000) continue;
      sessionStore.set(k, v);
    }
  } catch {}
}
loadSessions();

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k] = v.join('=');
  }
  return cookies;
}

function getSession(req) {
  const token = parseCookies(req).feather_session;
  if (!token) return null;
  return sessionStore.get(token) || null;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not authenticated' });
  req.user = session;
  next();
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

// ── Per-user path helpers ───────────────────────────────────────────────────

function userProjectsDir(userHome) {
  return path.join(userHome, '.claude/projects');
}

function userFeatherDir(userHome) {
  const d = path.join(userHome, '.feather');
  if (!fs.existsSync(d)) try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function userUploadsDir(userHome) {
  const d = path.join(userHome, 'feather-uploads');
  if (!fs.existsSync(d)) try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function safePath(userHome, filePath) {
  const resolved = path.resolve(filePath);
  const home = path.resolve(userHome);
  return resolved === home || resolved.startsWith(home + '/');
}

// ── JSONL parsing ───────────────────────────────────────────────────────────

function findJsonlPath(sessionId, userHome) {
  const projDir = userProjectsDir(userHome);
  if (!fs.existsSync(projDir)) return null;
  for (const dir of fs.readdirSync(projDir)) {
    const p = path.join(projDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Session metadata (per-user) ─────────────────────────────────────────────

function metaFilePath(userHome) {
  return path.join(userFeatherDir(userHome), 'session-meta.json');
}

function readMeta(userHome) {
  try { return JSON.parse(fs.readFileSync(metaFilePath(userHome), 'utf8')); }
  catch { return {}; }
}

function writeMeta(meta, userHome) {
  fs.writeFileSync(metaFilePath(userHome), JSON.stringify(meta, null, 2));
}

function readFileSudo(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch {
    const m = filePath.match(/^\/home\/([^/]+)\//);
    if (!m) return '';
    try { return execSync(`sudo -u ${m[1]} cat "${filePath}"`, { encoding: 'utf8', timeout: 10000 }); }
    catch { return ''; }
  }
}

function getMessages(sessionId, limit = 100, before = 0, userHome) {
  const fpath = findJsonlPath(sessionId, userHome);
  if (!fpath) return { messages: [], hasMore: false };
  const content = readFileSudo(fpath);
  if (!content) return { messages: [], hasMore: false };
  const lines = content.split('\n').filter(Boolean);
  const msgs = [];
  for (const line of lines) {
    const m = parseMessage(line);
    if (m) msgs.push(m);
  }
  if (before > 0) {
    const end = Math.max(0, msgs.length - before);
    const start = Math.max(0, end - limit);
    return { messages: msgs.slice(start, end), hasMore: start > 0 };
  }
  const start = Math.max(0, msgs.length - limit);
  return { messages: msgs.slice(start), hasMore: start > 0 };
}

// ── Project labels (per-user) ───────────────────────────────────────────────

function labelsFilePath(userHome) {
  return path.join(userFeatherDir(userHome), 'project-labels.json');
}

function readProjectLabels(userHome) {
  try { return JSON.parse(fs.readFileSync(labelsFilePath(userHome), 'utf8')); }
  catch { return {}; }
}

// ── Quick links (per-user) ──────────────────────────────────────────────────

function linksFilePath(userHome) {
  return path.join(userFeatherDir(userHome), 'quick-links.json');
}

function readLinks(userHome) {
  try { return JSON.parse(fs.readFileSync(linksFilePath(userHome), 'utf8')); }
  catch { return []; }
}

// ── Starred (per-user) ─────────────────────────────────────────────────────

function starredFilePath(userHome) {
  return path.join(userFeatherDir(userHome), 'starred.json');
}

function readStarred(userHome) {
  try { return JSON.parse(fs.readFileSync(starredFilePath(userHome), 'utf8')); }
  catch { return {}; }
}

// ── Tmux management (multi-user) ────────────────────────────────────────────

function tmuxName(id, username) {
  return `f-${username}-${id.slice(0, 8)}`;
}

// Run a tmux command as the given user
function tmuxExec(username, args, opts = {}) {
  if (username === "user") {
    return execFileSync('tmux', args, { encoding: 'utf8', ...opts });
  }
  return execFileSync('sudo', ['-u', username, 'tmux', ...args], { encoding: 'utf8', ...opts });
}

function tmuxExecShell(linuxUser, cmd, opts = {}) {
  if (linuxUser === "user") {
    return execSync(cmd, { encoding: 'utf8', ...opts });
  }
  return execSync(`sudo -u ${linuxUser} ${cmd}`, { encoding: 'utf8', ...opts });
}

function getActiveTmuxSessions(username) {
  const prefix = `f-${username}-`;
  try {
    const out = tmuxExec(username, ['list-sessions', '-F', '#{session_name}'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const active = new Set();
    for (const line of out.split('\n')) {
      if (line.startsWith(prefix)) active.add(line.slice(prefix.length));
      // Legacy compat for philip/user
      if (username === "user" && line.startsWith('feather-')) active.add(line.slice(8));
    }
    return active;
  } catch { return new Set(); }
}

function tmuxIsActive(id, username) {
  const name = tmuxName(id, username);
  try { tmuxExec(username, ['has-session', '-t', name], { stdio: 'ignore' }); return true; }
  catch {
    // Legacy compat for philip
    if (username === "user") {
      try { execFileSync('tmux', ['has-session', '-t', `feather-${id.slice(0, 8)}`], { stdio: 'ignore' }); return true; }
      catch { return false; }
    }
    return false;
  }
}

function spawnSession(id, cwd, username, userHome) {
  const name = tmuxName(id, username);
  try { tmuxExec(username, ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  const dir = cwd || userHome;
  const claudeCmd = `claude --session-id ${id} --dangerously-skip-permissions --disallowed-tools AskUserQuestion`;
  const tmuxCmd = `tmux new-session -d -s ${name} -c "${dir}" "bash --rcfile ~/.bashrc -ic 'umask 007 && ${claudeCmd}'" \\; set-option -t ${name} prefix M-a`;
  tmuxExecShell(username, tmuxCmd, { stdio: 'ignore' });
  // Send Enter at multiple intervals to clear trust prompt and any onboarding dialogs
  for (const delay of [3000, 5000, 8000]) {
    setTimeout(() => {
      try { tmuxExec(username, ["send-keys", '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, delay);
  }
}

function resumeSession(id, cwd, username, userHome) {
  const name = tmuxName(id, username);
  try { tmuxExec(username, ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  const dir = cwd || userHome;
  const claudeCmd = `claude --resume ${id} --dangerously-skip-permissions --disallowed-tools AskUserQuestion`;
  const tmuxCmd = `tmux new-session -d -s ${name} -c "${dir}" "bash --rcfile ~/.bashrc -ic 'umask 007 && ${claudeCmd}'" \\; set-option -t ${name} prefix M-a`;
  tmuxExecShell(username, tmuxCmd, { stdio: 'ignore' });
  for (const delay of [3000, 5000, 8000]) {
    setTimeout(() => {
      try { tmuxExec(username, ["send-keys", '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, delay);
  }
}

function sendInputToSession(id, text, username) {
  const name = tmuxName(id, username);
  // Also check legacy name for philip
  let target = name;
  try {
    tmuxExec(username, ['has-session', '-t', name], { stdio: 'ignore' });
  } catch {
    if (username === "user") target = `feather-${id.slice(0, 8)}`;
    else throw new Error('Session not active');
  }

  if (text.length > 500) {
    const tmp = `/tmp/feather-send-${Date.now()}.txt`;
    fs.writeFileSync(tmp, text);
    try {
      tmuxExec(username, ['load-buffer', tmp], { stdio: 'ignore' });
      tmuxExec(username, ['paste-buffer', '-t', target], { stdio: 'ignore' });
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    setTimeout(() => {
      try { tmuxExec(username, ["send-keys", '-t', target, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, 500);
  } else {
    tmuxExec(username, ["send-keys", '-t', target, '-l', text], { stdio: 'ignore' });
    tmuxExec(username, ["send-keys", '-t', target, 'Enter'], { stdio: 'ignore' });
  }
}

// ── Session discovery (per-user) ────────────────────────────────────────────

function discoverSessions(limit = 50, userHome, username) {
  const projDir = userProjectsDir(userHome);
  if (!fs.existsSync(projDir)) return [];

  const candidates = [];
  for (const dir of fs.readdirSync(projDir)) {
    const dirPath = path.join(projDir, dir);
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const fpath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(fpath);
          if (stat.size < 50) continue;
          candidates.push({ id: file.replace('.jsonl', ''), fpath, mtime: stat.mtime, projectId: dir });
        } catch {}
      }
    } catch {}
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const top = candidates.slice(0, limit);
  const active = getActiveTmuxSessions(username);
  const meta = readMeta(userHome);
  const labels = readProjectLabels(userHome);
  const sessions = [];

  for (const { id, fpath, mtime, projectId } of top) {
    try {
      const fd = fs.openSync(fpath, 'r');
      const buf = Buffer.alloc(Math.min(16384, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);

      let title = null;
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        try {
          const d = JSON.parse(line);
          if (d.type === 'user' && !d.isMeta && !d.isSidechain && d.message?.content) {
            let text = '';
            if (typeof d.message.content === 'string') text = d.message.content;
            else if (Array.isArray(d.message.content)) text = d.message.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
            // Clean up: strip attachment markers and whitespace
            text = text.replace(/\[Attached (?:image|file): [^\]]+\]\s*(?:\([^)]*\))?/g, '').trim();
            if (text && !text.startsWith('Generate a concise title')) {
              // Extract slash command name from <command-name>/foo</command-name>
              const cmdMatch = text.match(/<command-name>\/?([^<]+)</)
              if (cmdMatch) { title = '/' + cmdMatch[1].trim(); break; }
              if (!text.startsWith('<')) { title = text.slice(0, 80); break; }
            }
          }
        } catch {}
      }

      sessions.push({
        id, title: meta[id]?.title || title || id.slice(0, 8),
        updatedAt: mtime.toISOString(),
        isActive: active.has(id.slice(0, 8)),
        projectId,
        projectLabel: labels[projectId] || null,
      });
    } catch {}
  }

  return sessions;
}

// ── Auto-title generation ───────────────────────────────────────────────────

const titleQueue = new Set();
const TITLE_INTERVAL = 60000; // check every 60s
const MAX_CONCURRENT_TITLES = 2; // limit parallel title generation

async function generateTitle(sessionId, firstMessage, userHome) {
  if (titleQueue.has(sessionId) || titleQueue.size >= MAX_CONCURRENT_TITLES) return;
  titleQueue.add(sessionId);
  try {
    const prompt = `Generate a concise title (3-6 words) for a conversation that starts with: "${firstMessage.slice(0, 200).replace(/"/g, '\\"')}". Reply with ONLY the title, no quotes, no explanation.`;
    const { execFile: execFileAsync } = await import('child_process');
    const result = await new Promise((resolve, reject) => {
      execFileAsync('claude', ['-p', prompt, '--model', 'haiku'], { encoding: 'utf8', timeout: 20000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.trim());
      });
    });
    if (result && result.length < 60 && !result.includes('\n')) {
      const meta = readMeta(userHome);
      meta[sessionId] = { ...(meta[sessionId] || {}), title: result };
      writeMeta(meta, userHome);
    }
  } catch {}
  titleQueue.delete(sessionId);
}

// Periodically title untitled sessions (reuses discoverSessions logic)
setInterval(() => {
  const projDir = path.join(HOME, '.claude/projects');
  if (!fs.existsSync(projDir)) return;
  const meta = readMeta(HOME);
  for (const dir of fs.readdirSync(projDir)) {
    const dirPath = path.join(projDir, dir);
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const file of files.slice(0, 20)) {
      if (!file.endsWith('.jsonl')) continue;
      const id = file.replace('.jsonl', '');
      if (meta[id]?.title) continue; // already titled
      try {
        const fpath = path.join(dirPath, file);
        const stat = fs.statSync(fpath);
        if (stat.size < 100) continue;
        const buf = Buffer.alloc(Math.min(16384, stat.size));
        const fd = fs.openSync(fpath, 'r');
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
          try {
            const d = JSON.parse(line);
            if (d.type === 'user' && !d.isMeta && !d.isSidechain && d.message?.content) {
              let text = '';
              if (typeof d.message.content === 'string') text = d.message.content;
              else if (Array.isArray(d.message.content)) text = d.message.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
              text = text.replace(/\[Attached (?:image|file): [^\]]+\]\s*(?:\([^)]*\))?/g, '').trim();
              if (text && text.length > 10 && !text.startsWith('<') && !text.startsWith('Generate a concise title')) {
                generateTitle(id, text, HOME);
                break;
              }
            }
          } catch {}
        }
      } catch {}
    }
  }
}, TITLE_INTERVAL);

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

// ── File watcher (multi-user) ───────────────────────────────────────────────

const fileOffsets = new Map();

function initFileOffsets(projDir) {
  if (!fs.existsSync(projDir)) return;
  for (const dir of fs.readdirSync(projDir)) {
    const dp = path.join(projDir, dir);
    try {
      for (const f of fs.readdirSync(dp)) {
        if (!f.endsWith('.jsonl')) continue;
        try { fileOffsets.set(f.replace('.jsonl', ''), fs.statSync(path.join(dp, f)).size); } catch {}
      }
    } catch {}
  }
}

function readFileContent(filePath, offset, length) {
  // Try direct read first, fall back to sudo for cross-user files
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    // Find the owning user from the path (e.g. /home/lena/.claude/...)
    const m = filePath.match(/^\/home\/([^/]+)\//);
    if (!m) return null;
    try {
      return execSync(`sudo -u ${m[1]} tail -c +${offset + 1} "${filePath}"`, { encoding: 'utf8', timeout: 5000 });
    } catch { return null; }
  }
}

function processFileChange(filePath) {
  if (!filePath.endsWith('.jsonl')) return;
  const sessionId = path.basename(filePath, '.jsonl');
  const currentOffset = fileOffsets.get(sessionId) || 0;
  try {
    // stat via sudo if needed
    let fileSize;
    try { fileSize = fs.statSync(filePath).size; } catch {
      const m = filePath.match(/^\/home\/([^/]+)\//);
      if (!m) return;
      try { fileSize = parseInt(execSync(`sudo -u ${m[1]} stat -c %s "${filePath}"`, { encoding: 'utf8', timeout: 5000 })); } catch { return; }
    }
    if (fileSize <= currentOffset) return;
    const content = readFileContent(filePath, currentOffset, fileSize - currentOffset);
    if (!content) return;
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

function watchProjectDir(projDir) {
  if (!fs.existsSync(projDir)) return;
  for (const dir of fs.readdirSync(projDir)) {
    const dp = path.join(projDir, dir);
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
  fs.watch(projDir, (event, filename) => {
    if (!filename) return;
    const dp = path.join(projDir, filename);
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

// Init watchers for all configured users
const users = loadUsers();
for (const [username, cfg] of Object.entries(users)) {
  const projDir = userProjectsDir(cfg.home);
  initFileOffsets(projDir);
  watchProjectDir(projDir);
}

// ── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Serve static files (public, needed for login page)
// Disable caching for index.html to ensure users get latest builds
app.use(express.static(STATIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

// Serve legacy uploads
app.use('/uploads', express.static(path.resolve(import.meta.dirname, 'uploads')));

// Also serve files from /opt/feather/uploads (referenced in old messages)
app.use('/opt/feather/uploads', express.static('/opt/feather/uploads'));

// Serve user feather-uploads directories
app.use('/home/user/feather-uploads', express.static('/home/user/feather-uploads'));

// ── Auth routes (public) ────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const allUsers = loadUsers();
  const userCfg = allUsers[username.toLowerCase()];
  if (!userCfg || !bcrypt.compareSync(password, userCfg.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = crypto.randomUUID();
  sessionStore.set(token, {
    linuxUser: userCfg.linuxUser || username.toLowerCase(),
    username: username.toLowerCase(),
    home: userCfg.home,
    admin: userCfg.admin || false,
    createdAt: Date.now(),
  });
  saveSessions();

  res.cookie('feather_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/',
  });

  res.json({ ok: true, username: username.toLowerCase(), admin: userCfg.admin || false });
});

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not authenticated' });
  res.json({ username: session.username, admin: session.admin });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).feather_session;
  if (token) { sessionStore.delete(token); saveSessions(); }
  res.clearCookie('feather_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Auth middleware for all remaining /api routes ───────────────────────────

app.use('/api', requireAuth);

// ── Protected API routes ────────────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  const { home } = req.user;
  const projDir = userProjectsDir(home);
  const labels = readProjectLabels(home);
  const hidden = new Set(['memory', 'dashboards', '.claude', 'projects']);
  const projects = [];
  if (!fs.existsSync(projDir)) return res.json({ projects });
  for (const dir of fs.readdirSync(projDir)) {
    // Clean up project path: "-home-user-feather" -> "feather", "-home-lena" -> "lena"
    const segments = dir.replace(/^-/, '').split('-');
    const basename = (segments.length > 2 ? segments.slice(2).join('-') : segments[segments.length - 1]) || dir;
    if (hidden.has(basename)) continue;
    projects.push({ id: dir, label: labels[dir] || basename || dir });
  }
  res.json({ projects });
});

app.get('/api/sessions', (req, res) => {
  const { home, username, linuxUser } = req.user;
  try { res.json({ sessions: discoverSessions(parseInt(req.query.limit) || 50, home, linuxUser) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/:id/messages', (req, res) => {
  const { home } = req.user;
  const { messages, hasMore } = getMessages(req.params.id, parseInt(req.query.limit) || 100, parseInt(req.query.before) || 0, home);
  res.json({ messages, hasMore });
});

app.get('/api/sessions/:id/stream', (req, res) => {
  const { home } = req.user;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('event: connected\ndata: {}\n\n');
  const sid = req.params.id;

  const lastId = parseInt(req.query.lastEventId || req.headers['last-event-id'] || '0');
  if (lastId > 0) {
    const fpath = findJsonlPath(sid, home);
    if (fpath) {
      try {
        const stat = fs.statSync(fpath);
        if (stat.size > lastId) {
          const fd = fs.openSync(fpath, 'r');
          const buf = Buffer.alloc(stat.size - lastId);
          fs.readSync(fd, buf, 0, buf.length, lastId);
          fs.closeSync(fd);
          let offset = lastId;
          for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
            offset += Buffer.byteLength(line + '\n');
            const parsed = parseMessage(line);
            if (parsed) res.write(`id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`);
          }
        }
      } catch {}
    }
  }

  if (!sseClients.has(sid)) sseClients.set(sid, new Set());
  sseClients.get(sid).add(res);
  const hb = setInterval(() => { try { res.write('event: heartbeat\ndata: {}\n\n'); } catch { clearInterval(hb); } }, 15000);
  res.on('close', () => { clearInterval(hb); sseClients.get(sid)?.delete(res); });
});

app.post('/api/sessions', (req, res) => {
  const { username, home, linuxUser } = req.user;
  try { spawnSession(req.body.id, req.body.cwd, linuxUser, home); res.json({ id: req.body.id, status: 'starting' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/send', (req, res) => {
  const { username, linuxUser } = req.user;
  try { sendInputToSession(req.params.id, req.body.text, linuxUser); res.json({ ok: true, sentAt: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/resume', (req, res) => {
  const { username, home, linuxUser } = req.user;
  try { resumeSession(req.params.id, req.body?.cwd, linuxUser, home); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/interrupt', (req, res) => {
  const { username, linuxUser } = req.user;
  const name = tmuxName(req.params.id, linuxUser);
  try { tmuxExec(linuxUser, ["send-keys", '-t', name, 'C-c'], { stdio: 'ignore' }); res.json({ ok: true }); }
  catch (e) {
    // Legacy compat
    if (linuxUser === "user") {
      try { execFileSync('tmux', ['send-keys', '-t', `feather-${req.params.id.slice(0, 8)}`, 'C-c'], { stdio: 'ignore' }); return res.json({ ok: true }); }
      catch {}
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sessions/:id/delete', (req, res) => {
  const { username, home, linuxUser } = req.user;
  try {
    const id = req.params.id;
    try { tmuxExec(username, ['kill-session', '-t', tmuxName(id, username)], { stdio: 'ignore' }); } catch {}
    // Legacy compat
    if (linuxUser === "user") { try { execFileSync('tmux', ['kill-session', '-t', `feather-${id.slice(0, 8)}`], { stdio: 'ignore' }); } catch {} }
    const fpath = findJsonlPath(id, home);
    if (fpath) fs.unlinkSync(fpath);
    const meta = readMeta(home);
    delete meta[id];
    writeMeta(meta, home);
    sseClients.delete(id);
    fileOffsets.delete(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/rename', (req, res) => {
  const { home } = req.user;
  try {
    const meta = readMeta(home);
    meta[req.params.id] = { ...(meta[req.params.id] || {}), title: req.body.title };
    writeMeta(meta, home);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/fork', (req, res) => {
  const { username, home, linuxUser } = req.user;
  try {
    const id = req.params.id;
    const cwd = req.body?.cwd || home;
    const forkName = `f-${linuxUser}-f${Date.now().toString(36)}`;
    try { tmuxExec(username, ['kill-session', '-t', forkName], { stdio: 'ignore' }); } catch {}
    const claudeCmd = `claude --resume ${id} --fork-session --dangerously-skip-permissions --disallowed-tools AskUserQuestion`;
    const tmuxCmd = `tmux new-session -d -s ${forkName} -c "${cwd}" "bash --rcfile ~/.bashrc -ic '${claudeCmd}'" \\; set-option -t ${forkName} prefix M-a`;
    tmuxExecShell(linuxUser, tmuxCmd, { stdio: 'ignore' });
    res.json({ ok: true, tmux: forkName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload', async (req, res) => {
  const { home } = req.user;
  try {
    const uploadsDir = userUploadsDir(home);
    const filename = decodeURIComponent(req.headers['x-filename'] || 'file');
    const safe = filename.replace(/[^a-zA-Z0-9._\- ]/g, '').slice(0, 100);
    const dest = `${Date.now()}-${safe || 'upload'}`;
    const fpath = path.join(uploadsDir, dest);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    fs.writeFileSync(fpath, Buffer.concat(chunks));
    res.json({ path: fpath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quick Links (per-user) ──────────────────────────────────────────────────

app.get('/api/quick-links', (req, res) => res.json(readLinks(req.user.home)));

app.post('/api/quick-links', (req, res) => {
  const links = req.body;
  if (!Array.isArray(links)) return res.status(400).json({ error: 'expected array' });
  fs.writeFileSync(linksFilePath(req.user.home), JSON.stringify(links, null, 2));
  res.json({ ok: true });
});

// ── Starred (per-user) ─────────────────────────────────────────────────────

app.get('/api/starred', (req, res) => res.json(readStarred(req.user.home)));

app.post('/api/starred', (req, res) => {
  try {
    fs.writeFileSync(starredFilePath(req.user.home), JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Export ──────────────────────────────────────────────────────────────────

app.get('/api/sessions/:id/export', (req, res) => {
  const { home } = req.user;
  try {
    const { messages } = getMessages(req.params.id, 10000, 0, home);
    const lines = [];
    for (const msg of messages) {
      const role = msg.role === 'user' ? 'You' : 'Claude';
      lines.push(`## ${role} — ${msg.timestamp}\n`);
      for (const block of msg.content || []) {
        if (block.type === 'text' && block.text) lines.push(block.text);
        else if (block.type === 'tool_use') lines.push(`> **${block.name}** ${block.input?.file_path || block.input?.command?.split('\\n')[0] || ''}\n`);
      }
      lines.push('');
    }
    const md = lines.join('\n');
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="session-${req.params.id.slice(0, 8)}.md"`);
    res.send(md);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/open-in-editor', (req, res) => {
  const { home } = req.user;
  try {
    const fpath = req.body?.path;
    if (!fpath || !fpath.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
    if (!safePath(home, fpath)) return res.status(403).json({ error: 'access denied' });
    execFileSync('code-server', [fpath], { stdio: 'ignore', timeout: 3000 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Project labels management ───────────────────────────────────────────────

app.post('/api/projects/:id/label', (req, res) => {
  const { home } = req.user;
  try {
    const labels = readProjectLabels(home);
    labels[req.params.id] = req.body.label;
    fs.writeFileSync(labelsFilePath(home), JSON.stringify(labels, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Idle session reaper (multi-user) ────────────────────────────────────────

const IDLE_MS = 60 * 60 * 1000;

function reapIdleSessions() {
  const allUsers = loadUsers();
  const now = Date.now();
  for (const [username, cfg] of Object.entries(allUsers)) {
    const active = getActiveTmuxSessions(username);
    if (active.size === 0) continue;
    const projDir = userProjectsDir(cfg.home);
    if (!fs.existsSync(projDir)) continue;
    for (const dir of fs.readdirSync(projDir)) {
      const dirPath = path.join(projDir, dir);
      try {
        for (const file of fs.readdirSync(dirPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const id = file.replace('.jsonl', '');
          if (!active.has(id.slice(0, 8))) continue;
          const stat = fs.statSync(path.join(dirPath, file));
          if (now - stat.mtimeMs > IDLE_MS) {
            const name = tmuxName(id, username);
            try { tmuxExec(username, ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
            console.log(`[reaper] killed idle session ${name} (inactive ${Math.round((now - stat.mtimeMs) / 60000)}m)`);
          }
        }
      } catch {}
    }
  }
}

setInterval(reapIdleSessions, 5 * 60 * 1000);

// ── SPA catch-all ───────────────────────────────────────────────────────────

app.get('/terminal', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'terminal.html')));
app.get('/{*path}', (_req, res) => {
  const index = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(404).send('Frontend not built. Run: cd frontend && npm run build');
});

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(app);

// ── Terminal WebSocket (with auth) ──────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/api/terminal') && !req.url?.startsWith('/api/shell')) {
    socket.destroy();
    return;
  }
  // Verify auth
  const session = getSession(req);
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  req.featherUser = session;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const isShell = url.pathname === '/api/shell';
  const { username, home, linuxUser } = req.featherUser;

  const cleanEnv = { ...process.env };
  delete cleanEnv.TMUX; delete cleanEnv.TMUX_PANE;
  cleanEnv.TERM = 'xterm-256color';

  let term;
  if (isShell) {
    if (linuxUser === "user") {
      term = pty.spawn('bash', ['--login'], {
        name: 'xterm-256color', cols: 120, rows: 30, cwd: home, env: cleanEnv,
      });
    } else {
      term = pty.spawn('sudo', ['-u', username, '-i'], {
        name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
      });
    }
  } else {
    const sessionId = url.searchParams.get('session');
    if (!sessionId) { ws.close(1008, 'session required'); return; }
    if (!tmuxIsActive(sessionId, linuxUser)) { ws.close(1000, 'Session not active'); return; }
    const name = tmuxName(sessionId, linuxUser);
    // Check legacy name for philip
    let attachName = name;
    try { tmuxExec(username, ['has-session', '-t', name], { stdio: 'ignore' }); }
    catch { if (linuxUser === "user") attachName = `feather-${sessionId.slice(0, 8)}`; }

    if (linuxUser === "user") {
      term = pty.spawn('tmux', ['attach', '-t', attachName], {
        name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
      });
    } else {
      term = pty.spawn('sudo', ['-u', username, 'tmux', 'attach', '-t', attachName], {
        name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
      });
    }
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

  ws.on('close', () => { try { term.kill(); } catch {} });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Feather v2 (multi-user) on http://0.0.0.0:${PORT}`));

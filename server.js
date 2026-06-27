import express from 'express';
import compression from 'compression';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync, spawn } from 'child_process';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket as WS } from 'ws';
import pty from 'node-pty';
import { parseMessage, parseOmpMessage, parseCodexMessage, parseMessageForAgent } from './lib/parse.js';
import { generateRunSh, listPipelines } from './lib/auto-runsh.js';
import { sessionIsActive, lastMessageMs } from './lib/sessions.js';
import * as sidecar from './lib/sidecar.js';
import { createKeyedLock } from './lib/sendlock.js';

// Load ~/.env if present
try {
  const envFile = fs.readFileSync(path.join(process.env.HOME || '/home/user', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const DEEPGRAM_API_KEY = process.env.FEATHER_DEEPGRAM_API_KEY || '';

const PORT = parseInt(process.env.PORT || '4870');
const HOME = process.env.HOME || '/home/user';
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects');
const OMP_SESSIONS = path.join(HOME, '.feather/omp-sessions');
const CODEX_SESSIONS_ROOT = path.join(HOME, '.codex/sessions');
const STATIC_DIR = path.resolve(import.meta.dirname, 'static');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'version.json'), 'utf8')).version; } catch { return 'unknown'; } })();
const BRIDGE_EXT = path.resolve(import.meta.dirname, 'lib/feather-bridge.ts');
const BOXES_FILE = path.resolve(import.meta.dirname, 'boxes.json');
const SHARING_FILE = path.resolve(import.meta.dirname, 'sharing.json');
const SHARE_LOG = path.join(HOME, '.feather/share-access.log');
const COS_DIR = path.join(HOME, '.feather/cos');
const COS_FILE = path.join(COS_DIR, 'workstreams.json');

// Ensure omp session directory exists
try { fs.mkdirSync(OMP_SESSIONS, { recursive: true }); } catch {}

// ── Box proxy (remote machines) ────────────────────────────────────────────

function readBoxes() {
  try { return JSON.parse(fs.readFileSync(BOXES_FILE, 'utf8')); }
  catch { return {}; }
}

// ── Sharing (peers: other users' feather instances) ───────────────────────
// sharing.json (gitignored, 0600): { owner, peers: { id: { token, policy:
// 'all'|'selected', control: bool } }, grants: [{ peer, box, session|project }] }
// See docs/sharing-design.md.

function readSharing() {
  try { return JSON.parse(fs.readFileSync(SHARING_FILE, 'utf8')); }
  catch { return {}; }
}

function writeSharing(sharing) {
  fs.writeFileSync(SHARING_FILE, JSON.stringify(sharing, null, 2), { mode: 0o600 });
}

// CLI: node server.js --add-peer NAME [--all] [--control] — prints the token
// to hand to the peer, then exits without starting the server.
if (process.argv.includes('--add-peer')) {
  const name = process.argv[process.argv.indexOf('--add-peer') + 1];
  if (!name || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
    console.error('usage: node server.js --add-peer <name> [--all] [--control]');
    process.exit(1);
  }
  const sharing = readSharing();
  sharing.peers = sharing.peers || {};
  const existing = sharing.peers[name] || {};
  const token = existing.token || randomBytes(32).toString('hex');
  sharing.peers[name] = {
    ...existing,
    token,
    policy: process.argv.includes('--all') ? 'all' : (existing.policy || 'selected'),
    control: process.argv.includes('--control') || !!existing.control,
  };
  writeSharing(sharing);
  const p = sharing.peers[name];
  console.log(`peer "${name}": policy=${p.policy} control=${p.control}`);
  console.log(`token (give to ${name} for their boxes.json entry pointing at this instance):`);
  console.log(token);
  console.log(`\nexample entry for ${name}'s boxes.json:`);
  console.log(JSON.stringify({ [sharing.owner || 'friend']: { url: 'http://<this-host>:4870', label: sharing.owner || 'Friend', peer: true, token } }, null, 2));
  process.exit(0);
}

function findPeerByToken(token) {
  if (!token) return null;
  const peers = readSharing().peers || {};
  const given = createHash('sha256').update(token).digest();
  for (const [id, cfg] of Object.entries(peers)) {
    if (!cfg?.token) continue;
    const expected = createHash('sha256').update(cfg.token).digest();
    if (timingSafeEqual(given, expected)) return { id, policy: cfg.policy || 'selected', control: !!cfg.control };
  }
  return null;
}

// Can `peer` see this session? policy 'all' → everything; 'selected' →
// only session-meta share lists and sharing.json grants. Default deny.
function peerCanAccessSession(peer, sessionId, projectId = undefined) {
  if (peer.policy === 'all') return true;
  const meta = readMeta();
  if (Array.isArray(meta[sessionId]?.share) && meta[sessionId].share.includes(peer.id)) return true;
  const grants = (readSharing().grants || [])
    .filter(g => g?.peer === peer.id && (!g.box || g.box === 'local' || g.box === '*'));
  if (grants.length === 0) return false;
  if (grants.some(g => g.session === sessionId)) return true;
  if (projectId === undefined) {
    const fpath = findClaudeJsonlPath(sessionId);
    projectId = fpath ? path.basename(path.dirname(fpath)) : null;
  }
  return projectId ? grants.some(g => g.project === projectId) : false;
}

function shareLog(entry) {
  try { fs.appendFileSync(SHARE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

async function proxyToBox(boxId, req, res) {
  const boxes = readBoxes();
  const box = boxes[boxId];
  if (!box) return res.status(404).json({ error: `Unknown box: ${boxId}` });

  // Build target URL: strip ?box= param, forward everything else
  const url = new URL(req.originalUrl, 'http://localhost');
  url.searchParams.delete('box');
  let pathname = url.pathname;
  const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
  // Forward Accept so the remote's compression filter exempts SSE streams
  if (req.headers.accept) headers.Accept = req.headers.accept;

  // Peer boxes (another user's instance): only the share surface is ever
  // forwarded — rewritten onto their token-gated /api/share namespace. The
  // remote enforces its own grants; this allowlist just refuses to even ask
  // for anything outside view + send/interrupt.
  if (box.peer) {
    const allowed =
      (req.method === 'GET' && (pathname === '/api/sessions' || /^\/api\/sessions\/[^/]+\/(messages|stream|export)$/.test(pathname))) ||
      (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/(send|interrupt)$/.test(pathname));
    if (!allowed) return res.status(403).json({ error: `peer box ${boxId}: only viewing shared sessions (and send/interrupt if granted) is supported` });
    pathname = pathname.replace(/^\/api\/sessions/, '/api/share/sessions');
    if (box.token) headers.Authorization = `Bearer ${box.token}`;
  }

  const target = `${box.url}${pathname}${url.search}`;

  const ac = new AbortController();
  const connectTimeout = setTimeout(() => ac.abort(new Error('Connect timeout')), 15000);

  try {
    const opts = {
      method: req.method,
      headers,
      signal: ac.signal,
    };
    if (req.method === 'POST' && req.body) opts.body = JSON.stringify(req.body);

    const resp = await fetch(target, opts);
    clearTimeout(connectTimeout);

    // SSE streams need special handling — pipe through (no timeout on long-lived streams)
    if (resp.headers.get('content-type')?.includes('text/event-stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }
        } catch {}
        res.end();
      })();
      res.on('close', () => { try { reader.cancel(); } catch {} });
      return;
    }

    const data = await resp.text();
    res.status(resp.status);
    if (resp.headers.get('content-type')?.includes('json')) {
      res.setHeader('Content-Type', 'application/json');
    }
    res.send(data);
  } catch (e) {
    clearTimeout(connectTimeout);
    res.status(502).json({ error: `Box ${boxId} unreachable: ${e.message}` });
  }
}

// ── JSONL path lookup ──────────────────────────────────────────────────────

function findClaudeJsonlPath(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return null;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const p = path.join(CLAUDE_PROJECTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findOmpJsonlPath(sessionId) {
  const dir = path.join(OMP_SESSIONS, sessionId);
  if (!fs.existsSync(dir)) return null;
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return null;
    // Most recent JSONL (omp names them {timestamp}_{snowflake}.jsonl)
    files.sort().reverse();
    return path.join(dir, files[0]);
  } catch { return null; }
}

function findCodexJsonlPath(idOrUuid) {
  // Codex stores files at ~/.codex/sessions/YYYY/MM/DD/rollout-*-<UUID>.jsonl
  // Caller may pass either feather's local id (mapped via session-meta.codexUuid)
  // or the raw codex UUID itself.
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return null;
  const meta = readMeta();
  const uuid = meta[idOrUuid]?.codexUuid || idOrUuid;
  const stack = [CODEX_SESSIONS_ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith(`-${uuid}.jsonl`)) return full;
    }
  }
  return null;
}

function findJsonlPath(sessionId, agent) {
  if (agent === 'omp') return findOmpJsonlPath(sessionId);
  if (agent === 'codex') return findCodexJsonlPath(sessionId);
  if (agent === 'claude') return findClaudeJsonlPath(sessionId);
  // Unknown agent — try all
  return findClaudeJsonlPath(sessionId) || findOmpJsonlPath(sessionId) || findCodexJsonlPath(sessionId);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function getAgentForSession(sessionId) {
  const meta = readMeta();
  if (meta[sessionId]?.agent) return meta[sessionId].agent;
  // Auto-detect sessions discovered from disk but not tracked in this instance's
  // meta (session-meta.json is per-instance; ~/.feather/omp-sessions is shared
  // across all feather instances/worktrees). Without this, an omp session spawned
  // by another instance is misread with the Claude parser — getMessages returns
  // nothing and live broadcasts are dropped.
  if (findOmpJsonlPath(sessionId)) return 'omp';
  if (UUID_RE.test(sessionId) && findCodexJsonlPath(sessionId)) return 'codex';
  return 'claude';
}

// ── Session metadata ───────────────────────────────────────────────────────

const META_FILE = path.resolve(import.meta.dirname, 'session-meta.json');

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); }
  catch { return {}; }
}

function writeMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function getMessages(sessionId, limit = 100, before = 0) {
  const agent = getAgentForSession(sessionId);
  const fpath = findJsonlPath(sessionId, agent);
  if (!fpath || !fs.existsSync(fpath)) return { messages: [], hasMore: false };
  const lines = fs.readFileSync(fpath, 'utf8').split('\n').filter(Boolean);
  const msgs = [];
  for (const line of lines) {
    const m = parseMessageForAgent(line, agent);
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

function extractClaudeTitle(buf) {
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      if (d.type === 'user' && !d.isMeta && !d.isSidechain && d.message?.content) {
        let text = '';
        if (typeof d.message.content === 'string') text = d.message.content;
        else if (Array.isArray(d.message.content)) text = d.message.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
        text = text.replace(/\[Attached (?:image|file): [^\]]+\]\s*(?:\([^)]*\))?/g, '').trim();
        if (text.startsWith('<command-message>')) {
          const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
          const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
          if (argsMatch?.[1]?.trim()) return `${nameMatch?.[1] || '/cmd'} ${argsMatch[1].trim()}`.slice(0, 80);
          continue;
        }
        if (text && !text.startsWith('<')) return text.slice(0, 80);
      }
    } catch {}
  }
  return null;
}

function extractCodexTitle(buf) {
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      if (d.type !== 'response_item') continue;
      const p = d.payload;
      if (p?.type !== 'message' || p.role !== 'user') continue;
      const text = (p.content || [])
        .filter(b => b.type === 'input_text' && b.text)
        .map(b => b.text)
        .join(' ')
        .trim();
      if (!text) continue;
      if (text.startsWith('<environment_context>') || text.startsWith('<permissions instructions>') || text.startsWith('<skills_instructions>') || text.startsWith('<user_instructions>')) continue;
      return text.slice(0, 80);
    } catch {}
  }
  return null;
}

function extractCodexCwd(buf) {
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      if (d.type === 'session_meta' && d.payload?.cwd) return d.payload.cwd;
      if (d.type === 'turn_context' && d.payload?.cwd) return d.payload.cwd;
    } catch {}
  }
  return null;
}

function extractClaudeCwd(buf) {
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      if (d.cwd) return d.cwd;
    } catch {}
  }
  return null;
}

function extractCodexUuid(filename) {
  // rollout-2026-04-25T18-27-29-019d9cb2-afd3-7d30-aabb-d0b6f3f0f3e6.jsonl
  const m = filename.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return m ? m[1] : null;
}

function listCodexJsonlFiles() {
  // Returns [{ uuid, fpath, mtime }] across all year/month/day dirs
  const out = [];
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return out;
  const stack = [CODEX_SESSIONS_ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
        const uuid = extractCodexUuid(ent.name);
        if (!uuid) continue;
        try { out.push({ uuid, fpath: full, mtime: fs.statSync(full).mtime }); } catch {}
      }
    }
  }
  return out;
}

function extractOmpTitle(buf) {
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      // omp session header has title
      if (d.type === 'session' && d.title) return d.title.slice(0, 80);
      // Fall back to first user message
      if (d.type === 'message' && d.message?.role === 'user') {
        const content = d.message.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) text = content.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
        text = text.trim();
        if (text) return text.slice(0, 80);
      }
    } catch {}
  }
  return null;
}

function isAutoWorkerSession(buf, agent, projectId) {
  if (buf.includes('AUTO_WORKER=TRUE')) return true;
  if (projectId && /-home-user-(?:auto|autoweb)-/.test(projectId)) return true;

  let cwd = '';
  if (agent === 'codex') cwd = extractCodexCwd(buf) || '';
  else if (agent === 'claude') cwd = extractClaudeCwd(buf) || '';

  return /^\/home\/user\/(?:auto|autoweb)-/.test(cwd);
}

function discoverSessions(limit = 50) {
  const candidates = [];
  const meta = readMeta();
  const labels = readProjectLabels();
  const codexLocalIds = new Map();
  for (const [localId, entry] of Object.entries(meta)) {
    if (entry?.codexUuid) codexLocalIds.set(entry.codexUuid, localId);
  }

  // Claude sessions
  if (fs.existsSync(CLAUDE_PROJECTS)) {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
      const dirPath = path.join(CLAUDE_PROJECTS, dir);
      try {
        for (const file of fs.readdirSync(dirPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const fpath = path.join(dirPath, file);
          try {
            const stat = fs.statSync(fpath);
            if (stat.size < 50) continue;
            if (/-home-user-(?:auto|autoweb)-|feather-aw/.test(dir)) continue;
            candidates.push({ id: file.replace('.jsonl', ''), fpath, mtime: stat.mtime, agent: 'claude', projectId: dir });
          } catch {}
        }
      } catch {}
    }
  }

  // omp sessions
  if (fs.existsSync(OMP_SESSIONS)) {
    for (const dir of fs.readdirSync(OMP_SESSIONS)) {
      const dirPath = path.join(OMP_SESSIONS, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        if (files.length === 0) continue;
        files.sort().reverse();
        const fpath = path.join(dirPath, files[0]);
        const stat = fs.statSync(fpath);
        if (stat.size < 50) continue;
        candidates.push({ id: dir, fpath, mtime: stat.mtime, agent: 'omp' });
      } catch {}
    }
  }

  // codex sessions
  for (const { uuid, fpath, mtime } of listCodexJsonlFiles()) {
    try {
      const stat = fs.statSync(fpath);
      if (stat.size < 50) continue;
      candidates.push({ id: codexLocalIds.get(uuid) || uuid, fpath, mtime, agent: 'codex' });
    } catch {}
  }

  // Sort by mtime descending; loop until we have `limit` non-worker sessions.
  // Content-based worker detection requires reading the file, so we can't pre-filter.
  candidates.sort((a, b) => b.mtime - a.mtime);

  const active = getActiveTmuxSessions();
  // Green "active" dot = live tmux session AND a recent real message. We use the
  // last real message time (lastActivityMs), NOT the file mtime: a resumed agent
  // keeps appending system/permission lines to the JSONL while idle, which bump
  // mtime and lit the dot (and floated the row to the top) on sessions that had
  // no actual message in hours. See lib/sessions.js.
  const now = Date.now();

  const sessions = [];
  for (const { id, fpath, mtime, agent, projectId } of candidates) {
    if (sessions.length >= limit) break;
    try {
      const fd = fs.openSync(fpath, 'r');
      // Codex session_meta line alone can be ~15KB, plus a developer permissions
      // block before the first user message — read more for codex.
      const bufCap = agent === 'codex' ? 65536 : 16384;
      const buf = Buffer.alloc(Math.min(bufCap, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);

      // Worker detection: use explicit canary or actual worker cwd/project.
      // Broad path mentions in prompt/context are too noisy for Codex sessions.
      if (isAutoWorkerSession(buf, agent, projectId)) continue;

      let title;
      if (agent === 'omp') title = extractOmpTitle(buf);
      else if (agent === 'codex') title = extractCodexTitle(buf);
      else title = extractClaudeTitle(buf);

      // Project label is shown only for allowlisted projects (key present in labels);
      // unlisted sessions still carry projectId but appear unlabelled in the "All" view.
      const isAllowlisted = projectId && (projectId in labels);
      const activityMs = lastActivityMs(fpath, agent, mtime.getTime());
      sessions.push({
        id, title: meta[id]?.title || title || id.slice(0, 8),
        updatedAt: new Date(activityMs).toISOString(),
        isActive: sessionIsActive(active, id, activityMs, now),
        agent,
        projectId: projectId || null,
        projectLabel: isAllowlisted ? (labels[projectId] || cleanProjectLabel(projectId)) : null,
        share: Array.isArray(meta[id]?.share) && meta[id].share.length ? meta[id].share : undefined,
      });
    } catch {}
  }

  // Re-sort by real activity. Candidates were ordered by file mtime, which is
  // bumped by idle bookkeeping writes; ordering by last real message keeps the
  // list "sorted by last message time" as users expect.
  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return sessions;
}

// Epoch-ms of the last real user/assistant message in a session's JSONL — the
// true "last activity". Reads only the file tail (messages are appended), and
// falls back to `fallbackMs` (the file mtime) if no real message is found.
function lastActivityMs(fpath, agent, fallbackMs) {
  try {
    const size = fs.statSync(fpath).size;
    const TAIL = 512 * 1024;
    const readLen = Math.min(size, TAIL);
    const fd = fs.openSync(fpath, 'r');
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    fs.closeSync(fd);
    const ts = lastMessageMs(buf.toString('utf8'), agent, size > readLen);
    return ts ?? fallbackMs;
  } catch { return fallbackMs; }
}

// ── Tmux management ─────────────────────────────────────────────────────────

function tmuxName(id) { return `feather-${id.slice(0, 8)}`; }

function tmuxIsActive(id) {
  try { execFileSync('tmux', ['has-session', '-t', tmuxName(id)], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function launchInTmux(name, cmd, cwd) {
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  execSync(`tmux new-session -d -s ${name} -c "${cwd || HOME}" "${cmd}" \\; set-option -t ${name} prefix M-a`, { stdio: 'ignore' });
  for (const delay of [3000, 5000, 8000]) {
    setTimeout(() => {
      try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, delay);
  }
}

// Pre-mark cwd as trusted in ~/.codex/config.toml so codex skips the
// "Do you trust the contents of this directory?" prompt at startup.
// Codex persists trust per-cwd; runtime `-c` overrides do NOT skip this prompt.
function ensureCodexTrust(cwd) {
  if (!cwd) return;
  const cfg = path.join(HOME, '.codex/config.toml');
  let body = '';
  try { body = fs.readFileSync(cfg, 'utf8'); } catch {}
  const header = `[projects."${cwd}"]`;
  if (body.includes(header)) return;
  const block = `\n${header}\ntrust_level = "trusted"\n`;
  try { fs.appendFileSync(cfg, block); } catch (e) { console.warn(`[codex] could not write trust for ${cwd}:`, e.message); }
}

function spawnSession(id, cwd, agent = 'claude') {
  const name = tmuxName(id);
  // Persist agent type in metadata
  const meta = readMeta();
  meta[id] = { ...(meta[id] || {}), agent };
  writeMeta(meta);

  if (agent === 'omp') {
    const sessionDir = path.join(OMP_SESSIONS, id);
    fs.mkdirSync(sessionDir, { recursive: true });
    watchOmpSessionDir(sessionDir, id);
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic 'omp --session-dir ${sessionDir} --allow-home'`, cwd);
  } else if (agent === 'codex') {
    // Codex doesn't accept a preset session id (issue openai/codex#15767).
    // Snapshot existing rollout files, spawn codex, then poll for the new file
    // and adopt its UUID into session-meta.
    ensureCodexTrust(cwd);
    const before = new Set(listCodexJsonlFiles().map(f => f.uuid));
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic 'codex --dangerously-bypass-approvals-and-sandbox'`, cwd);
    adoptNewCodexUuid(id, before);
  } else {
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic 'claude --session-id ${id} --dangerously-skip-permissions --disallowed-tools AskUserQuestion'`, cwd);
  }
}

function adoptNewCodexUuid(featherId, beforeUuids, attempts = 30) {
  // Poll ~/.codex/sessions for a rollout file that didn't exist before spawn.
  // Codex usually writes the session_meta line within ~1s of launch.
  let n = 0;
  const tick = () => {
    n++;
    const after = listCodexJsonlFiles();
    const fresh = after.filter(f => !beforeUuids.has(f.uuid));
    if (fresh.length > 0) {
      // Pick the newest fresh file
      fresh.sort((a, b) => b.mtime - a.mtime);
      const uuid = fresh[0].uuid;
      const meta = readMeta();
      meta[featherId] = { ...(meta[featherId] || {}), agent: 'codex', codexUuid: uuid };
      writeMeta(meta);
      // Start watching this file for SSE broadcasts
      fileOffsets.set(featherId, 0);
      watchCodexFile(fresh[0].fpath, featherId);
      console.log(`[codex] adopted UUID ${uuid} for feather session ${featherId}`);
      return;
    }
    if (n < attempts) setTimeout(tick, 500);
    else console.warn(`[codex] failed to adopt UUID for ${featherId} after ${attempts} attempts`);
  };
  setTimeout(tick, 500);
}

function resumeSession(id, cwd) {
  const agent = getAgentForSession(id);
  const name = tmuxName(id);
  if (agent === 'omp') {
    const sessionDir = path.join(OMP_SESSIONS, id);
    // Read the omp Snowflake ID from the JSONL header for resume
    const ompId = getOmpSessionId(id);
    const resumeArg = ompId ? `--resume ${ompId}` : '--continue';
    watchOmpSessionDir(sessionDir, id);
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic 'omp ${resumeArg} --session-dir ${sessionDir} --allow-home'`, cwd);
  } else if (agent === 'codex') {
    const meta = readMeta();
    const codexUuid = meta[id]?.codexUuid || (UUID_RE.test(id) ? id : null);
    const fpath = findCodexJsonlPath(id);
    if (fpath) { fileOffsets.set(id, fs.statSync(fpath).size); watchCodexFile(fpath, id); }
    // Codex resume writes back to the same jsonl file (no UUID adoption needed).
    // Pass --cd to skip the "choose working directory" picker that appears when
    // the recorded session cwd differs from the launch cwd.
    let sessionCwd = cwd;
    if (!sessionCwd && fpath) {
      try { sessionCwd = extractCodexCwd(fs.readFileSync(fpath).slice(0, 65536)); } catch {}
    }
    sessionCwd = (sessionCwd || HOME).replace(/[^a-zA-Z0-9._\-/]/g, '');
    ensureCodexTrust(sessionCwd);
    const resumeArg = codexUuid ? `resume ${codexUuid}` : 'resume --last';
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic 'codex ${resumeArg} --cd ${sessionCwd} --dangerously-bypass-approvals-and-sandbox'`, cwd || sessionCwd);
  } else {
    // Claude resolves resumable sessions by project dir (cwd → ~/.claude/projects/<encoded>),
    // so launching from the wrong cwd makes --resume fail and the tmux session exits.
    let sessionCwd = cwd;
    if (!sessionCwd) {
      const fpath = findClaudeJsonlPath(id);
      if (fpath) {
        try {
          const fd = fs.openSync(fpath, 'r');
          const buf = Buffer.alloc(Math.min(8192, fs.fstatSync(fd).size));
          fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          sessionCwd = extractClaudeCwd(buf);
        } catch {}
      }
    }
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic 'claude --resume ${id} --dangerously-skip-permissions --disallowed-tools AskUserQuestion'`, sessionCwd);
  }
}

function getOmpSessionId(featherId) {
  const fpath = findOmpJsonlPath(featherId);
  if (!fpath) return null;
  try {
    const fd = fs.openSync(fpath, 'r');
    const buf = Buffer.alloc(Math.min(4096, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf8').split('\n')[0];
    const d = JSON.parse(firstLine);
    if (d.type === 'session' && d.id) return d.id;
  } catch {}
  return null;
}

// Per-session send lock (U1): serialize the tmux send-keys/paste-buffer
// sequence so two concurrent senders can't interleave bytes into the same pane.
// Keyed by session id, so different sessions still send in parallel. The lock is
// held through the Enter submission (sendInputUnlocked awaits it). See
// lib/sendlock.js for the keyed-lock semantics and its tests.
const sendLock = createKeyedLock();

async function sendInput(id, text) {
  return sendLock(id, () => sendInputUnlocked(id, text));
}

async function sendInputUnlocked(id, text) {
  if (!tmuxIsActive(id)) {
    resumeSession(id);
    // Wait for Claude CLI to fully load before sending input
    await new Promise(r => setTimeout(r, 6000));
  }
  const target = tmuxName(id);
  const agent = getAgentForSession(id);
  // Codex: typing via send-keys -l after the first message leaves the input
  // in a state where Enter inserts a newline instead of submitting. Routing
  // the text through paste-buffer (bracketed paste) avoids that and submits
  // reliably across many turns.
  if (agent === 'codex') {
    const tmp = `/tmp/feather-send-${Date.now()}.txt`;
    fs.writeFileSync(tmp, text);
    try {
      execFileSync('tmux', ['load-buffer', tmp], { stdio: 'ignore' });
      execFileSync('tmux', ['paste-buffer', '-t', target], { stdio: 'ignore' });
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    // Await (not fire-and-forget) so the lock is held until Enter submits.
    await new Promise(r => setTimeout(r, 300));
    try { execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' }); } catch {}
    return;
  }
  if (text.length > 500) {
    const tmp = `/tmp/feather-send-${Date.now()}.txt`;
    fs.writeFileSync(tmp, text);
    try {
      execFileSync('tmux', ['load-buffer', tmp], { stdio: 'ignore' });
      execFileSync('tmux', ['paste-buffer', '-t', target], { stdio: 'ignore' });
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    // Give Claude CLI a moment to process the paste, then submit (awaited so the
    // lock covers the Enter).
    await new Promise(r => setTimeout(r, 500));
    try { execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' }); } catch {}
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
  const agent = getAgentForSession(sessionId);
  const parsed = parseMessageForAgent(line, agent);
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

function processFileChange(filePath, sessionIdOverride) {
  if (!filePath.endsWith('.jsonl')) return;
  const sessionId = sessionIdOverride || path.basename(filePath, '.jsonl');
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

// ── omp session dir watchers ────────────────────────────────────────────────

const watchedOmpDirs = new Set();

function watchOmpSessionDir(dirPath, featherId) {
  if (watchedOmpDirs.has(dirPath)) return;
  watchedOmpDirs.add(dirPath);
  try {
    fs.watch(dirPath, (event, filename) => {
      if (!filename?.endsWith('.jsonl')) return;
      const full = path.join(dirPath, filename);
      if (!fileOffsets.has(featherId)) fileOffsets.set(featherId, 0);
      processFileChange(full, featherId);
    });
  } catch {}
}

// ── codex file watchers ────────────────────────────────────────────────────

const watchedCodexDirs = new Map(); // dirPath -> Map<filename, featherId>

function watchCodexFile(fpath, featherId) {
  const dirPath = path.dirname(fpath);
  const filename = path.basename(fpath);
  if (!watchedCodexDirs.has(dirPath)) {
    watchedCodexDirs.set(dirPath, new Map());
    try {
      fs.watch(dirPath, (event, fn) => {
        if (!fn) return;
        const map = watchedCodexDirs.get(dirPath);
        const fid = map?.get(fn);
        if (!fid) return;
        const full = path.join(dirPath, fn);
        if (!fileOffsets.has(fid)) fileOffsets.set(fid, 0);
        processFileChange(full, fid);
      });
    } catch {}
  }
  watchedCodexDirs.get(dirPath).set(filename, featherId);
}

// Watch existing codex session files on startup (only recent ones to avoid huge fs.watch fanout)
{
  const recent = listCodexJsonlFiles().sort((a, b) => b.mtime - a.mtime).slice(0, 100);
  for (const { uuid, fpath } of recent) {
    try {
      fileOffsets.set(uuid, fs.statSync(fpath).size);
      watchCodexFile(fpath, uuid);
    } catch {}
  }
}

// Watch existing omp session dirs on startup
if (fs.existsSync(OMP_SESSIONS)) {
  for (const dir of fs.readdirSync(OMP_SESSIONS)) {
    const dirPath = path.join(OMP_SESSIONS, dir);
    try {
      if (fs.statSync(dirPath).isDirectory()) {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        if (files.length > 0) {
          files.sort().reverse();
          const fpath = path.join(dirPath, files[0]);
          try { fileOffsets.set(dir, fs.statSync(fpath).size); } catch {}
        }
        watchOmpSessionDir(dirPath, dir);
      }
    } catch {}
  }

  // Watch for omp session dirs created after startup (mirrors the CLAUDE_PROJECTS
  // parent watcher below). Without this, an omp session whose dir appears later —
  // e.g. spawned by another feather instance/worktree sharing ~/.feather, by an
  // omp subagent, or by any path other than this process's spawnSession — is
  // discovered on disk (so it shows up in the list) but never registers a file
  // watcher, so its messages never stream live and the user must refresh.
  fs.watch(OMP_SESSIONS, (_event, filename) => {
    if (!filename) return;
    const dirPath = path.join(OMP_SESSIONS, filename);
    try {
      if (fs.statSync(dirPath).isDirectory()) watchOmpSessionDir(dirPath, filename);
    } catch {}
  });
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
app.use(compression({
  filter(req, res) {
    // Don't compress SSE streams — buffering breaks real-time delivery.
    // Check the response type too: server-to-server clients (box proxy,
    // peers) don't always send Accept: text/event-stream.
    if (req.headers.accept === 'text/event-stream') return false;
    if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/ootw', express.static('/home/user/auto-gan-otherworld/app', { extensions: ['html'] }));

// ── Box discovery (cached) ──────────────────────────────────────────────────

const boxStatusCache = new Map(); // id -> { available, ts }
const BOX_CACHE_TTL = 30_000; // 30 seconds

app.get('/api/boxes', async (_req, res) => {
  const boxes = readBoxes();
  const result = [{ id: 'local', label: 'Local', available: true }];
  const now = Date.now();
  for (const [id, box] of Object.entries(boxes)) {
    const cached = boxStatusCache.get(id);
    if (cached && now - cached.ts < BOX_CACHE_TTL) {
      result.push({ id, label: box.label || id, available: cached.available, peer: !!box.peer });
      continue;
    }
    let available = false;
    try {
      const r = await fetch(`${box.url}/api/health`, { signal: AbortSignal.timeout(8000) });
      available = r.ok;
    } catch {}
    boxStatusCache.set(id, { available, ts: now });
    result.push({ id, label: box.label || id, available, peer: !!box.peer });
  }
  res.json({ boxes: result });
});

// ── Box proxy middleware for session routes ──────────────────────────────────

app.use('/api/sessions', (req, res, next) => {
  const box = req.query.box;
  if (box && box !== 'local') return proxyToBox(box, req, res);
  next();
});

app.get('/api/sessions', (req, res) => {
  try { res.json({ sessions: discoverSessions(parseInt(req.query.limit) || 50) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/:id/messages', (req, res) => {
  const { messages, hasMore } = getMessages(req.params.id, parseInt(req.query.limit) || 100, parseInt(req.query.before) || 0);
  res.json({ messages, hasMore });
});

function sessionStreamHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('event: connected\ndata: {}\n\n');
  const sid = req.params.id;

  // Replay missed messages from lastEventId (byte offset)
  const lastId = parseInt(req.query.lastEventId || req.headers['last-event-id'] || '0');
  if (lastId > 0) {
    const agent = getAgentForSession(sid);
    const fpath = findJsonlPath(sid, agent);
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
            const parsed = parseMessageForAgent(line, agent);
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
}

app.get('/api/sessions/:id/stream', sessionStreamHandler);

app.post('/api/sessions', (req, res) => {
  try {
    const agent = req.body.agent || 'claude';
    spawnSession(req.body.id, req.body.cwd, agent);
    res.json({ id: req.body.id, status: 'starting', agent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/send', async (req, res) => {
  try { await sendInput(req.params.id, req.body.text); res.json({ ok: true, sentAt: new Date().toISOString() }); }
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

app.post('/api/sessions/:id/delete', (req, res) => {
  try {
    const id = req.params.id;
    const agent = getAgentForSession(id);
    try { execFileSync('tmux', ['kill-session', '-t', tmuxName(id)], { stdio: 'ignore' }); } catch {}
    if (agent === 'omp') {
      const dir = path.join(OMP_SESSIONS, id);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    } else {
      const fpath = findJsonlPath(id, agent);
      if (fpath) fs.unlinkSync(fpath);
    }
    const meta = readMeta();
    delete meta[id];
    writeMeta(meta);
    sseClients.delete(id);
    fileOffsets.delete(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/rename', (req, res) => {
  try {
    const meta = readMeta();
    meta[req.params.id] = { ...(meta[req.params.id] || {}), title: req.body.title };
    writeMeta(meta);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/fork', (req, res) => {
  try {
    const agent = getAgentForSession(req.params.id);
    const forkName = `feather-f${Date.now().toString(36)}`;
    if (agent === 'omp') {
      // omp doesn't have --fork-session; just resume in a new tmux
      const sessionDir = path.join(OMP_SESSIONS, req.params.id);
      const ompId = getOmpSessionId(req.params.id);
      const resumeArg = ompId ? `--resume ${ompId}` : '--continue';
      launchInTmux(forkName, `bash --rcfile ~/.bashrc -ic 'omp ${resumeArg} --session-dir ${sessionDir} --allow-home'`, req.body?.cwd);
    } else {
      launchInTmux(forkName, `bash --rcfile ~/.bashrc -ic 'claude --resume ${req.params.id} --fork-session --dangerously-skip-permissions --disallowed-tools AskUserQuestion'`, req.body?.cwd);
    }
    res.json({ ok: true, tmux: forkName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sidecar API: paired agent threads with a chat channel ──────────────────
// See docs/plans/2026-06-27-001-feature-sidecar-plan.md

const sidecarClients = new Map(); // groupId -> Set<res>

function sidecarBroadcast(groupId, msg) {
  const clients = sidecarClients.get(groupId);
  if (!clients || clients.size === 0) return;
  const chunk = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) {
    try { res.write(chunk); } catch { clients.delete(res); }
  }
}

// Resolve a group from the request: explicit group id, or the sender's tmux prefix.
function sidecarResolveGroup({ group, fromPrefix }) {
  if (group) return sidecar.getGroup(group);
  if (fromPrefix) return sidecar.groupForSessionPrefix(fromPrefix);
  return null;
}

// Core broker: record the message, broadcast to the GUI, inject into the recipient.
function sidecarDeliver(group, fromRole, toRole, text) {
  const toSession = sidecar.resolveRecipient(group, toRole);
  if (!toSession) return { error: `unknown recipient role: ${toRole}` };
  const msg = sidecar.appendMessage(group.id, { from: fromRole, to: toRole, text });
  sidecarBroadcast(group.id, msg);
  // Push into the recipient's tmux (locked sendInput); fire-and-forget so the
  // HTTP caller isn't blocked on the ~6s resume-if-dormant path.
  sendInput(toSession, sidecar.formatInbound(fromRole, text))
    .catch(e => console.warn('[sidecar] route failed:', e.message));
  return { ok: true, message: msg };
}

app.get('/api/sidecar', (_req, res) => {
  res.json({ groups: sidecar.listGroups() });
});

app.get('/api/sidecar/:id', (req, res) => {
  const g = sidecar.getGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  res.json({ group: g, thread: sidecar.readThread(g.id) });
});

app.get('/api/sidecar/:id/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('event: connected\ndata: {}\n\n');
  const id = req.params.id;
  for (const m of sidecar.readThread(id)) {
    res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
  }
  if (!sidecarClients.has(id)) sidecarClients.set(id, new Set());
  sidecarClients.get(id).add(res);
  const hb = setInterval(() => { try { res.write('event: heartbeat\ndata: {}\n\n'); } catch { clearInterval(hb); } }, 15000);
  res.on('close', () => { clearInterval(hb); sidecarClients.get(id)?.delete(res); });
});

// Create a sidecar: spawn a peer session, register the group, prime the peer.
app.post('/api/sidecar', (req, res) => {
  try {
    const { driverSessionId, driverRole = 'driver', peerRole = 'peer', agent = 'claude', cwd, task = '' } = req.body || {};
    if (!driverSessionId) return res.status(400).json({ error: 'driverSessionId required' });
    const peerId = randomUUID();
    const group = sidecar.createGroup({
      id: randomUUID(),
      members: [
        { sessionId: driverSessionId, role: driverRole, spawned: false },
        { sessionId: peerId, role: peerRole, spawned: true },
      ],
      agent, task,
    });
    spawnSession(peerId, cwd, agent);
    // The tmux session is active immediately but the agent needs a few seconds to
    // boot, so delay the priming send (sendInput's resume-wait only fires when the
    // session is inactive, which it isn't here).
    const priming = sidecar.priming({ selfRole: peerRole, otherRole: driverRole, task });
    setTimeout(() => {
      sendInput(peerId, priming).catch(e => console.warn('[sidecar] prime failed:', e.message));
    }, 7000);
    res.json({ group, peerSessionId: peerId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post a message. Sender identified by tmux prefix (CLI) or explicit group+from (GUI).
app.post('/api/sidecar/post', (req, res) => {
  try {
    const { group: groupId, fromPrefix, from, to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text required' });
    const group = sidecarResolveGroup({ group: groupId, fromPrefix });
    if (!group || group.status !== 'active') return res.status(404).json({ error: 'no active sidecar group for sender' });
    const fromRole = from || (fromPrefix ? sidecar.roleForPrefix(group, fromPrefix) : null) || 'unknown';
    const out = sidecarDeliver(group, fromRole, to, text);
    if (out.error) return res.status(400).json(out);
    res.json({ ok: true, group: group.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post addressed by explicit group id (used by the GUI).
app.post('/api/sidecar/:id/post', (req, res) => {
  try {
    const { from, to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text required' });
    const group = sidecar.getGroup(req.params.id);
    if (!group || group.status !== 'active') return res.status(404).json({ error: 'no active sidecar group' });
    const out = sidecarDeliver(group, from || 'driver', to, text);
    if (out.error) return res.status(400).json(out);
    res.json({ ok: true, group: group.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sidecar/:id/delete', (req, res) => {
  try {
    const g = sidecar.getGroup(req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    for (const m of g.members) {
      if (m.spawned) { try { execFileSync('tmux', ['kill-session', '-t', tmuxName(m.sessionId)], { stdio: 'ignore' }); } catch {} }
    }
    sidecar.teardownGroup(g.id);
    sidecarClients.delete(g.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Share API: the only surface peers can reach (docs/sharing-design.md) ───

function requirePeer(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  const peer = findPeerByToken(m?.[1]);
  if (!peer) return res.status(401).json({ error: 'invalid peer token' });
  req.peer = peer;
  shareLog({ peer: peer.id, method: req.method, path: req.path, ...(typeof req.body?.text === 'string' ? { text: req.body.text } : {}) });
  next();
}

function requireShareAccess(req, res, next) {
  // 404 (not 403) so a non-granted peer can't probe which session ids exist
  if (!peerCanAccessSession(req.peer, req.params.id)) return res.status(404).json({ error: 'not found' });
  next();
}

app.use('/api/share', requirePeer);

app.get('/api/share/sessions', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const sessions = discoverSessions(limit)
      .filter(s => peerCanAccessSession(req.peer, s.id, s.projectId))
      .map(({ share, ...s }) => s); // don't leak who else a session is shared with
    res.json({ sessions, control: !!req.peer.control, owner: readSharing().owner || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/share/sessions/:id/messages', requireShareAccess, (req, res) => {
  const { messages, hasMore } = getMessages(req.params.id, parseInt(req.query.limit) || 100, parseInt(req.query.before) || 0);
  res.json({ messages, hasMore });
});

app.get('/api/share/sessions/:id/stream', requireShareAccess, sessionStreamHandler);

app.get('/api/share/sessions/:id/export', requireShareAccess, sessionExportHandler);

// Talk together: control peers can send into a shared session. The peer's
// name is prefixed into the text so the agent and both UIs know who spoke.
app.post('/api/share/sessions/:id/send', requireShareAccess, async (req, res) => {
  if (!req.peer.control) return res.status(403).json({ error: 'view-only access' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'empty message' });
  try { await sendInput(req.params.id, `[${req.peer.id}] ${text}`); res.json({ ok: true, sentAt: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/share/sessions/:id/interrupt', requireShareAccess, (req, res) => {
  if (!req.peer.control) return res.status(403).json({ error: 'view-only access' });
  try { execFileSync('tmux', ['send-keys', '-t', tmuxName(req.params.id), 'C-c'], { stdio: 'ignore' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Owner-side helpers: list configured peers (no tokens) + set a session's share list
app.get('/api/sharing/peers', (_req, res) => {
  const sharing = readSharing();
  res.json({
    owner: sharing.owner || null,
    peers: Object.entries(sharing.peers || {}).map(([id, p]) => ({ id, policy: p?.policy || 'selected', control: !!p?.control })),
  });
});

app.post('/api/sessions/:id/share', (req, res) => {
  try {
    const peers = Array.isArray(req.body?.peers) ? req.body.peers.map(String).filter(Boolean) : [];
    const meta = readMeta();
    meta[req.params.id] = { ...(meta[req.params.id] || {}), share: peers };
    writeMeta(meta);
    res.json({ ok: true, share: peers });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.json({ path: fpath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Project labels ──────────────────────────────────────────────────────────

const PROJECT_LABELS_FILE = path.resolve(import.meta.dirname, 'project-labels.json');

function readProjectLabels() {
  try { return JSON.parse(fs.readFileSync(PROJECT_LABELS_FILE, 'utf8')); }
  catch { return {}; }
}

// "-home-user-feather" → "feather"; "-home-lena" → "lena"
function cleanProjectLabel(dir) {
  const segments = dir.replace(/^-/, '').split('-');
  return (segments.length > 2 ? segments.slice(2).join('-') : segments[segments.length - 1]) || dir;
}

// Allowlist: only IDs present as keys in project-labels.json show up. Value
// is the display label (string), or null/empty to use the auto-derived basename.
app.get('/api/projects', (_req, res) => {
  const labels = readProjectLabels();
  const projects = Object.keys(labels)
    .filter(id => fs.existsSync(path.join(CLAUDE_PROJECTS, id)))
    .map(id => ({ id, label: labels[id] || cleanProjectLabel(id) }));
  res.json({ projects });
});

app.post('/api/projects/:id/label', (req, res) => {
  const id = req.params.id;
  if (!fs.existsSync(path.join(CLAUDE_PROJECTS, id))) {
    return res.status(404).json({ error: `no such claude project dir: ${id}` });
  }
  const labels = readProjectLabels();
  labels[id] = req.body.label != null ? String(req.body.label) : null;
  fs.writeFileSync(PROJECT_LABELS_FILE, JSON.stringify(labels, null, 2));
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const labels = readProjectLabels();
  delete labels[req.params.id];
  fs.writeFileSync(PROJECT_LABELS_FILE, JSON.stringify(labels, null, 2));
  res.json({ ok: true });
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

// ── Starred messages ───────────────────────────────────────────────────────

const STARRED_FILE = path.resolve(import.meta.dirname, 'starred.json');

function readStarred() {
  try { return JSON.parse(fs.readFileSync(STARRED_FILE, 'utf8')); }
  catch { return {}; }
}

app.get('/api/starred', (_req, res) => res.json(readStarred()));

app.post('/api/starred', (req, res) => {
  try {
    fs.writeFileSync(STARRED_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Export ──────────────────────────────────────────────────────────────────

function sessionExportHandler(req, res) {
  try {
    const { messages } = getMessages(req.params.id, 10000);
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
}

app.get('/api/sessions/:id/export', sessionExportHandler);

// ── File serving (for attached files by absolute path) ─────────────────────

app.get('/api/file', (req, res) => {
  const fpath = req.query.path;
  if (!fpath || !fpath.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'not found' });
  try {
    const stat = fs.statSync(fpath);
    if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });
    if (stat.size > 100 * 1024 * 1024) return res.status(413).json({ error: 'file too large' });
    res.sendFile(fpath);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files', (req, res) => {
  const dir = req.query.path || HOME;
  if (!dir.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') || req.query.hidden === '1')
      .map(e => {
        const full = path.join(dir, e.name);
        try {
          const s = fs.statSync(full);
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs };
        } catch { return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: 0, mtime: 0 }; }
      })
      .sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
    res.json({ path: dir, parent: dir === '/' ? null : path.dirname(dir), entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/file', (req, res) => {
  const fpath = req.query.path;
  if (!fpath || !fpath.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'not found' });
  try {
    const stat = fs.statSync(fpath);
    if (stat.isDirectory()) fs.rmSync(fpath, { recursive: true });
    else fs.unlinkSync(fpath);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/open-in-editor', (req, res) => {
  try {
    const fpath = req.body?.path;
    if (!fpath || !fpath.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
    execFileSync('code-server', [fpath], { stdio: 'ignore', timeout: 3000 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Idle session reaper (kill after 1 hour of inactivity) ──────────────────

const IDLE_MS = 60 * 60 * 1000; // 1 hour

function reapIdleSessions() {
  const active = getActiveTmuxSessions();
  if (active.size === 0) return;
  const now = Date.now();

  // Reap Claude sessions
  let dirs;
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch { dirs = []; }
  for (const dir of dirs) {
    const dirPath = path.join(CLAUDE_PROJECTS, dir);
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const id = file.replace('.jsonl', '');
        if (!active.has(id.slice(0, 8))) continue;
        const stat = fs.statSync(path.join(dirPath, file));
        if (now - stat.mtimeMs > IDLE_MS) {
          const name = tmuxName(id);
          try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
          console.log(`[reaper] killed idle session ${name} (inactive ${Math.round((now - stat.mtimeMs) / 60000)}m)`);
        }
      }
    } catch {}
  }

  // Reap omp sessions
  try {
    for (const dir of fs.readdirSync(OMP_SESSIONS)) {
      if (!active.has(dir.slice(0, 8))) continue;
      const dirPath = path.join(OMP_SESSIONS, dir);
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      if (files.length === 0) continue;
      files.sort().reverse();
      const stat = fs.statSync(path.join(dirPath, files[0]));
      if (now - stat.mtimeMs > IDLE_MS) {
        const name = tmuxName(dir);
        try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
        console.log(`[reaper] killed idle omp session ${name} (inactive ${Math.round((now - stat.mtimeMs) / 60000)}m)`);
      }
    }
  } catch {}

  // Reap codex sessions
  try {
    for (const { uuid, fpath, mtime } of listCodexJsonlFiles()) {
      if (!active.has(uuid.slice(0, 8))) continue;
      if (now - mtime.getTime() > IDLE_MS) {
        const name = tmuxName(uuid);
        try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
        console.log(`[reaper] killed idle codex session ${name} (inactive ${Math.round((now - mtime.getTime()) / 60000)}m)`);
      }
    }
  } catch {}
}

setInterval(reapIdleSessions, 5 * 60 * 1000); // check every 5 minutes

app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: VERSION, uptime: process.uptime() }));

// ── Agent discovery ─────────────────────────────────────────────────────────

app.get('/api/agents', (_req, res) => {
  const agents = [{ id: 'claude', label: 'Claude Code', available: true }];
  try {
    const ver = execFileSync('omp', ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
    agents.push({ id: 'omp', label: `oh-my-pi ${ver}`, available: true });
  } catch {
    agents.push({ id: 'omp', label: 'oh-my-pi', available: false });
  }
  try {
    const ver = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
    agents.push({ id: 'codex', label: `Codex ${ver}`, available: true });
  } catch {
    agents.push({ id: 'codex', label: 'Codex', available: false });
  }
  res.json({ agents });
});

// ── /api/auto: instances ────────────────────────────────────────────────────

// New instances live at ~/auto-NAME/. Legacy instances (created before the
// rename) live at ~/autoweb-NAME/ and are still resolved for back-compat.
const AUTO_PREFIX = 'auto-';
const LEGACY_PREFIX = 'autoweb-';

function autoDir(name) {
  const fresh = path.join(HOME, AUTO_PREFIX + name);
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(HOME, LEGACY_PREFIX + name);
  if (fs.existsSync(legacy)) return legacy;
  return fresh; // default for not-yet-created
}

const safeName = (n) => /^[a-z0-9][a-z0-9-]{0,30}$/.test(n);

function readSafe(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

function isRunning(pidPath) {
  const pid = parseInt(readSafe(pidPath).trim());
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function summarizeInstance(name) {
  const dir = autoDir(name);
  if (!fs.existsSync(path.join(dir, 'run.sh'))) return null;
  const tsv = readSafe(path.join(dir, 'results.tsv'));
  const rows = tsv.split('\n').slice(1).filter(Boolean);
  let keeps = 0, reverts = 0, crashes = 0, skips = 0;
  for (const r of rows) {
    const status = r.split('\t')[1];
    if (status === 'keep') keeps++;
    else if (status === 'revert') reverts++;
    else if (status === 'crash') crashes++;
    else if (status === 'skip') skips++;
  }
  const last = rows.slice(-1)[0]?.split('\t') || [];
  const mainChat = readSafe(path.join(dir, 'main_chat.txt')).trim() || null;
  const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  const mtime = Math.max(
    mtimeOf(path.join(dir, 'current.txt')),
    mtimeOf(path.join(dir, 'results.tsv')),
    mtimeOf(path.join(dir, 'findings.md')),
    mtimeOf(path.join(dir, 'auto.pid')),
    mtimeOf(dir)
  );
  return {
    name,
    dir,
    running: isRunning(path.join(dir, 'auto.pid')),
    current: readSafe(path.join(dir, 'current.txt')).trim(),
    keeps, reverts, crashes, skips,
    iterations: rows.length,
    last: last.length ? { timestamp: last[0], status: last[1], description: last[2] } : null,
    mainChat,
    mtime,
  };
}

function listInstances() {
  const out = [];
  const seen = new Set();
  for (const entry of fs.readdirSync(HOME)) {
    let name;
    if (entry.startsWith(AUTO_PREFIX)) name = entry.slice(AUTO_PREFIX.length);
    else if (entry.startsWith(LEGACY_PREFIX)) name = entry.slice(LEGACY_PREFIX.length);
    else continue;
    if (!safeName(name) || seen.has(name)) continue;
    seen.add(name);
    const s = summarizeInstance(name);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/api/auto/instances', (_req, res) => {
  res.json({ instances: listInstances() });
});

app.get('/api/auto/instances/:name', (req, res) => {
  const { name } = req.params;
  if (!safeName(name)) return res.status(400).json({ error: 'bad name' });
  const s = summarizeInstance(name);
  if (!s) return res.status(404).json({ error: 'not found' });
  s.program = readSafe(path.join(s.dir, 'program.md'));
  s.results = readSafe(path.join(s.dir, 'results.tsv'));
  s.workerSessions = listWorkerSessions(name);
  res.json(s);
});

function listWorkerSessions(name, limit = 20) {
  const out = [];
  // Claude project dir convention: leading dash + path with slashes → dashes.
  // Check the new path first, then the legacy autoweb- path.
  const projDirs = [
    path.join(CLAUDE_PROJECTS, `-home-user-${AUTO_PREFIX}${name}`),
    path.join(CLAUDE_PROJECTS, `-home-user-${LEGACY_PREFIX}${name}`),
  ];
  for (const projDir of projDirs) {
    if (!fs.existsSync(projDir)) continue;
    try {
      for (const f of fs.readdirSync(projDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(projDir, f);
        const st = fs.statSync(fp);
        if (st.size < 50) continue;
        out.push({ id: f.replace('.jsonl', ''), agent: 'claude', mtime: st.mtime.toISOString() });
      }
    } catch {}
  }
  // Codex: scan recent files for the instance dir path in their buffers.
  for (const { uuid, fpath, mtime } of listCodexJsonlFiles().slice(0, 200)) {
    try {
      const fd = fs.openSync(fpath, 'r');
      const buf = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      if (buf.includes(`${AUTO_PREFIX}${name}`) || buf.includes(`${LEGACY_PREFIX}${name}`)) {
        out.push({ id: uuid, agent: 'codex', mtime: mtime.toISOString() });
      }
    } catch {}
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out.slice(0, limit);
}

app.get('/api/auto/pipelines', (_req, res) => {
  res.json({ pipelines: listPipelines() });
});

// Map legacy `template` values onto pipeline names.
function resolvePipelineName({ pipeline, template }) {
  if (pipeline) return pipeline;
  if (!template || template === 'full') return 'claude-codex';
  if (template === 'simple') return 'simple';
  return template;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function createAutoInstance({ name, target, url, repo, template, pipeline, goal }) {
  if (!safeName(name)) throw httpError(400, 'bad name (lowercase, digits, dashes)');
  // Refuse if either the new path or a legacy autoweb- path already exists.
  const dir = path.join(HOME, AUTO_PREFIX + name);
  const legacyDir = path.join(HOME, LEGACY_PREFIX + name);
  if (fs.existsSync(dir) || fs.existsSync(legacyDir)) {
    throw httpError(409, 'already exists');
  }

  const pipelineName = resolvePipelineName({ pipeline, template });
  const available = listPipelines();
  if (!available.includes(pipelineName)) {
    throw httpError(400, `unknown pipeline: ${pipelineName}. Available: ${available.join(', ')}`);
  }

  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

  const runSh = generateRunSh({
    pipelineName,
    instanceName: name,
    instanceDir: dir,
    repo,
  });

  const programParts = [
    `# auto — ${name}`,
    `Pipeline: ${pipelineName}`,
    '',
    '## Goal',
    goal || target || '(set me)',
    '',
  ];
  if (target) programParts.push('## Target file', target, '');
  if (url) programParts.push('## Target URL', url, '');
  if (repo) programParts.push('## Repo', repo, '');
  programParts.push(
    '## CURRENT FOCUS',
    'general',
    '',
    '## Known issues',
    '(none)',
    '',
    '## CAN',
    '- (list)',
    '',
    '## CANNOT',
    '- Break the page',
    '',
    '## How to verify',
    url ? 'Screenshot the URL, sanity check.' : 'Run tests, check sanity conditions.',
    '',
  );

  fs.writeFileSync(path.join(dir, 'run.sh'), runSh, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'program.md'), programParts.join('\n'));
  fs.writeFileSync(path.join(dir, 'results.tsv'), 'timestamp\tstatus\tdescription\n');
  return summarizeInstance(name);
}

function startAutoInstance(name) {
  if (!safeName(name)) throw httpError(400, 'bad name');
  const dir = autoDir(name);
  if (!fs.existsSync(path.join(dir, 'run.sh'))) throw httpError(404, 'not found');
  const pidPath = path.join(dir, 'auto.pid');
  if (isRunning(pidPath)) return { ok: true, alreadyRunning: true };
  const out = fs.openSync(path.join(dir, 'auto.log'), 'a');
  const child = spawn('bash', [path.join(dir, 'run.sh')], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: dir,
  });
  fs.writeFileSync(pidPath, String(child.pid));
  child.unref();
  return { ok: true, pid: child.pid };
}

app.post('/api/auto/instances', express.json(), (req, res) => {
  try {
    res.json({ ok: true, instance: createAutoInstance(req.body || {}) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/auto/instances/:name/start', (req, res) => {
  try {
    res.json(startAutoInstance(req.params.name));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/auto/instances/:name/stop', (req, res) => {
  const { name } = req.params;
  if (!safeName(name)) return res.status(400).json({ error: 'bad name' });
  const pidPath = path.join(autoDir(name), 'auto.pid');
  const pid = parseInt(readSafe(pidPath).trim());
  if (!pid) return res.json({ ok: true, alreadyStopped: true });
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  try { process.kill(pid, 'SIGTERM'); } catch {}
  fs.unlinkSync(pidPath);
  res.json({ ok: true });
});

app.post('/api/auto/instances/:name/focus', express.json(), (req, res) => {
  const { name } = req.params;
  const { focus } = req.body || {};
  if (!safeName(name) || !focus) return res.status(400).json({ error: 'bad input' });
  const programPath = path.join(autoDir(name), 'program.md');
  let p = readSafe(programPath);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (/^## CURRENT FOCUS\n.*$/m.test(p)) {
    p = p.replace(/^## CURRENT FOCUS\n.*$/m, `## CURRENT FOCUS\n${focus}`);
  } else {
    p += `\n## CURRENT FOCUS\n${focus}\n`;
  }
  fs.writeFileSync(programPath, p);
  res.json({ ok: true });
});

app.post('/api/auto/instances/:name/btw', express.json(), (req, res) => {
  const { name } = req.params;
  const { note } = req.body || {};
  if (!safeName(name) || !note) return res.status(400).json({ error: 'bad input' });
  const programPath = path.join(autoDir(name), 'program.md');
  let p = readSafe(programPath);
  if (!p) return res.status(404).json({ error: 'not found' });
  const stamp = new Date().toISOString();
  const line = `- (${stamp}) ${note}`;
  if (/^## Known issues\n/m.test(p)) {
    p = p.replace(/^## Known issues\n(\(none\)\n)?/m, `## Known issues\n${line}\n`);
  } else {
    p += `\n## Known issues\n${line}\n`;
  }
  fs.writeFileSync(programPath, p);
  res.json({ ok: true });
});

app.post('/api/auto/instances/:name/link', express.json(), (req, res) => {
  const { name } = req.params;
  const { sessionId } = req.body || {};
  if (!safeName(name) || !sessionId) return res.status(400).json({ error: 'bad input' });
  const dir = autoDir(name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
  fs.writeFileSync(path.join(dir, 'main_chat.txt'), sessionId);
  res.json({ ok: true });
});

app.delete('/api/auto/instances/:name', (req, res) => {
  const { name } = req.params;
  if (!safeName(name)) return res.status(400).json({ error: 'bad name' });
  const dir = autoDir(name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
  if (isRunning(path.join(dir, 'auto.pid'))) return res.status(409).json({ error: 'still running, stop first' });
  res.json({ ok: true, hint: 'rm -rf ' + dir + ' to remove on disk (server does not delete)' });
});

// ── /api/cos: chief-of-staff workstreams ─────────────────────────────────────

function readCosState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(COS_FILE, 'utf8'));
    return {
      chiefSessionId: parsed.chiefSessionId || null,
      workstreams: Array.isArray(parsed.workstreams) ? parsed.workstreams : [],
    };
  } catch {
    return { chiefSessionId: null, workstreams: [] };
  }
}

function writeCosState(state) {
  fs.mkdirSync(COS_DIR, { recursive: true });
  fs.writeFileSync(COS_FILE, JSON.stringify(state, null, 2));
}

function titleSession(id, title) {
  const meta = readMeta();
  meta[id] = { ...(meta[id] || {}), title };
  writeMeta(meta);
}

function slugifyWorkstreamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''));
}

function createGoalFiles({ repo, slug, title, goal }) {
  const root = path.join(repo, 'docs/goals', slug);
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const goalMd = `# ${title}

## Objective

${goal}

## Original Request

${JSON.stringify(goal)}

## Intake Summary

- Input shape: \`specific\`
- Audience: operator
- Authority: \`approved\`
- Proof type: \`artifact\`
- Completion proof: The child agent records a receipt with changed files, verification, blockers, and next recommendation.
- Likely misfire: The workstream produces planning notes but no executable next step or proof.
- Blind spots considered:
  - Scope may need decomposition after first scout pass.
  - External credentials or destructive actions require explicit approval.

## Goal Kind

\`specific\`

## Current Tranche

Produce the smallest useful result for this workstream, then leave a durable receipt.

## Non-Negotiable Constraints

- Keep work scoped to the named workstream.
- Do not perform destructive actions or spend money without explicit approval.
- Record verification or a concrete blocker before stopping.

## Stop Rule

Stop only when the workstream has a receipt that the CoS can summarize.

## Canonical Board

\`docs/goals/${slug}/state.yaml\`

## Run Command

\`\`\`text
/goal Follow docs/goals/${slug}/goal.md.
\`\`\`
`;
  const stateYaml = `version: 2

goal:
  title: ${yamlQuote(title)}
  slug: ${yamlQuote(slug)}
  kind: specific
  tranche: ${yamlQuote('Produce the first useful workstream result and receipt.')}
  status: active
  intake:
    original_request: ${yamlQuote(goal)}
    interpreted_outcome: ${yamlQuote(goal)}
    input_shape: specific
    audience: operator
    authority: approved
    proof_type: artifact
    completion_proof: ${yamlQuote('Child agent records a receipt with verification, blockers, and next recommendation.')}
    likely_misfire: ${yamlQuote('Planning without a useful result or receipt.')}
    blind_spots_considered:
      - ${yamlQuote('Scope may need decomposition after first scout pass.')}
      - ${yamlQuote('External credentials or destructive actions require approval.')}
    existing_plan_facts: []

rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true
  planning_is_not_completion: true
  continuous_until_full_outcome: true

agents:
  scout: unknown
  worker: unknown
  judge: unknown

visual_board:
  selected: none

active_task: T001

tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: active
    reasoning_hint: default
    objective: ${yamlQuote(goal)}
    constraints:
      - ${yamlQuote('Keep the slice narrow and leave a receipt.')}
      - ${yamlQuote('Stop before destructive operations, credentials, purchases, or production writes that need approval.')}
    expected_output:
      - ${yamlQuote('Useful result or concrete blocker.')}
      - ${yamlQuote('Verification command or reason verification was not possible.')}
      - ${yamlQuote('Next recommendation for the CoS.')}
    receipt: null

checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`;
  fs.writeFileSync(path.join(root, 'goal.md'), goalMd);
  fs.writeFileSync(path.join(root, 'state.yaml'), stateYaml);
  return {
    goalPath: path.join(root, 'goal.md'),
    goalCommand: `/goal Follow docs/goals/${slug}/goal.md.`,
  };
}

function chiefPrompt() {
  return `You are Allan's Chief of Staff inside Feather.

Operating model:
- Keep a short list of active workstreams and ask for clarification only when a decision changes scope, money, credentials, or risk.
- Prefer launching bounded child workstreams through Feather CoS, /goal, or /auto instead of doing every task in the parent thread.
- Every child needs a receipt: current status, proof, blockers, and next recommendation.
- msgvault and tg-in already work; treat them as available intake channels once this CoS thread is wired to a heartbeat.
- Default to read-only discovery before writes. Do not spend money, send external messages, or change production state without explicit approval.

First action: summarize the current CoS operating model in 5 bullets and ask Allan for the first workstream to launch.`;
}

function workstreamPrompt(w) {
  return `You are a child workstream launched by Allan's Chief of Staff.

Name: ${w.name}
Goal: ${w.goal}

Rules:
- Work only on this workstream.
- Prefer a small useful result over a broad plan.
- Do not spend money, send external messages, or perform destructive operations without explicit approval.
- Before stopping, leave a receipt with: status, files/artifacts touched, verification, blockers, and next recommendation.

Start now.`;
}

function refreshCosWorkstream(w) {
  const next = { ...w };
  if (next.autoName) {
    const auto = summarizeInstance(next.autoName);
    if (auto) {
      next.status = auto.running ? 'running' : 'stopped';
      next.lastReceipt = auto.current || auto.last?.description || `${auto.iterations} iterations`;
      next.updatedAt = new Date(Math.max(auto.mtime || 0, Date.parse(next.updatedAt || '') || 0)).toISOString();
    }
  } else if (next.sessionId) {
    const fpath = findJsonlPath(next.sessionId, next.agent);
    next.status = tmuxIsActive(next.sessionId) ? 'running' : (fpath ? 'idle' : 'starting');
    if (fpath) {
      try {
        const stat = fs.statSync(fpath);
        next.updatedAt = stat.mtime.toISOString();
        next.lastReceipt = `${next.status}; session updated ${stat.mtime.toISOString()}`;
      } catch {}
    }
  }
  if (next.goalPath && fs.existsSync(next.goalPath)) {
    try {
      const stat = fs.statSync(next.goalPath);
      if (!next.updatedAt || stat.mtime > new Date(next.updatedAt)) next.updatedAt = stat.mtime.toISOString();
    } catch {}
  }
  return next;
}

function refreshCosState(state, persist = false) {
  const next = { ...state, workstreams: state.workstreams.map(refreshCosWorkstream) };
  if (persist) writeCosState(next);
  return next;
}

app.get('/api/cos', (_req, res) => {
  const state = refreshCosState(readCosState(), true);
  res.json({
    ...state,
    msgvault: fs.existsSync(path.join(HOME, '.msgvault/msgvault.db')) || fs.existsSync(path.join(HOME, '.local/bin/msgvault')),
    tgIn: fs.existsSync(path.join(HOME, 'telegram-bot')) || fs.existsSync(path.join(HOME, '.telegram-bot')),
  });
});

app.post('/api/cos/chief', (req, res) => {
  try {
    const state = readCosState();
    if (state.chiefSessionId) return res.json({ ok: true, sessionId: state.chiefSessionId, reused: true });
    const sessionId = randomUUID();
    const agent = req.body?.agent || 'codex';
    spawnSession(sessionId, HOME, agent);
    titleSession(sessionId, 'Chief of Staff');
    state.chiefSessionId = sessionId;
    writeCosState(state);
    setTimeout(() => sendInput(sessionId, chiefPrompt()).catch(e => console.warn('[cos] chief prompt failed:', e.message)), 7000);
    res.json({ ok: true, sessionId });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/cos/workstreams', (req, res) => {
  try {
    const body = req.body || {};
    const name = slugifyWorkstreamName(body.name);
    const goal = String(body.goal || '').trim();
    if (!safeName(name) || !goal) throw httpError(400, 'name and goal required');

    const state = readCosState();
    if (state.workstreams.some(w => w.name === name)) throw httpError(409, 'workstream already exists');

    const now = new Date().toISOString();
    const launcher = ['session', 'auto', 'goal'].includes(body.launcher) ? body.launcher : 'session';
    const repo = body.repo && path.isAbsolute(body.repo) ? body.repo : path.resolve(import.meta.dirname);
    const agent = body.agent || 'codex';
    const workstream = {
      id: randomUUID(),
      name,
      goal,
      launcher,
      agent,
      repo,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
      lastReceipt: `launched via ${launcher}`,
    };

    if (launcher === 'auto') {
      const pipeline = body.pipeline || 'claude-codex';
      createAutoInstance({ name, goal, repo, pipeline });
      if (body.start !== false) startAutoInstance(name);
      workstream.autoName = name;
      workstream.status = body.start === false ? 'stopped' : 'running';
    } else {
      const sessionId = randomUUID();
      if (launcher === 'goal') {
        const created = createGoalFiles({ repo, slug: name, title: name, goal });
        workstream.goalPath = created.goalPath;
        workstream.goalCommand = created.goalCommand;
      }
      spawnSession(sessionId, repo, agent);
      titleSession(sessionId, `CoS: ${name}`);
      workstream.sessionId = sessionId;
      const prompt = launcher === 'goal' ? `/goal Follow docs/goals/${name}/goal.md.` : workstreamPrompt(workstream);
      setTimeout(() => sendInput(sessionId, prompt).catch(e => console.warn(`[cos] workstream prompt failed for ${name}:`, e.message)), 7000);
    }

    state.workstreams.unshift(workstream);
    writeCosState(state);
    res.json({ ok: true, workstream: refreshCosWorkstream(workstream) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/cos/workstreams/:id/check', (req, res) => {
  try {
    const state = readCosState();
    const idx = state.workstreams.findIndex(w => w.id === req.params.id || w.name === req.params.id);
    if (idx < 0) throw httpError(404, 'not found');
    const checked = refreshCosWorkstream({ ...state.workstreams[idx], lastCheckedAt: new Date().toISOString() });
    state.workstreams[idx] = checked;
    writeCosState(state);
    res.json({ ok: true, workstream: checked });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.use(express.static(STATIC_DIR, {
  maxAge: '0',
  setHeaders(res, filePath) {
    if (filePath.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  },
}));
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

// ── Deepgram batch transcription ────────────────────────────────────────────

app.post('/api/transcribe', async (req, res) => {
  if (!DEEPGRAM_API_KEY) return res.status(500).json({ error: 'No Deepgram API key configured' });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const audio = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || 'audio/webm';
    const dgRes = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&smart_format=true', {
      method: 'POST',
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': contentType },
      body: audio,
    });
    if (!dgRes.ok) {
      const errText = await dgRes.text();
      return res.status(dgRes.status).json({ error: errText });
    }
    const data = await dgRes.json();
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

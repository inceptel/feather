import express from 'express';
import compression from 'compression';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { WebSocketServer, WebSocket as WS } from 'ws';
import pty from 'node-pty';
import { parseMessage, parseOmpMessage, parseCodexMessage, parseMessageForAgent } from './lib/parse.js';

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

// Ensure omp session directory exists
try { fs.mkdirSync(OMP_SESSIONS, { recursive: true }); } catch {}

// ── Box proxy (remote machines) ────────────────────────────────────────────

function readBoxes() {
  try { return JSON.parse(fs.readFileSync(BOXES_FILE, 'utf8')); }
  catch { return {}; }
}

async function proxyToBox(boxId, req, res) {
  const boxes = readBoxes();
  const box = boxes[boxId];
  if (!box) return res.status(404).json({ error: `Unknown box: ${boxId}` });

  // Build target URL: strip ?box= param, forward everything else
  const url = new URL(req.originalUrl, 'http://localhost');
  url.searchParams.delete('box');
  const target = `${box.url}${url.pathname}${url.search}`;

  const ac = new AbortController();
  const connectTimeout = setTimeout(() => ac.abort(new Error('Connect timeout')), 15000);

  try {
    const opts = {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
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
  // Auto-detect codex sessions discovered from disk (id is the codex UUID itself).
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

function discoverSessions(limit = 50) {
  const candidates = [];
  const meta = readMeta();

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
            const isWorker = /autoweb|feather-aw/.test(dir);
            candidates.push({ id: file.replace('.jsonl', ''), fpath, mtime: stat.mtime, agent: 'claude', isWorker });
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
      candidates.push({ id: uuid, fpath, mtime, agent: 'codex' });
    } catch {}
  }

  // Sort by mtime descending, take top N
  candidates.sort((a, b) => b.mtime - a.mtime);
  const top = candidates.slice(0, limit);

  const active = getActiveTmuxSessions();

  const sessions = [];
  for (const { id, fpath, mtime, agent, isWorker } of top) {
    try {
      const fd = fs.openSync(fpath, 'r');
      // Codex session_meta line alone can be ~15KB, plus a developer permissions
      // block before the first user message — read more for codex.
      const bufCap = agent === 'codex' ? 65536 : 16384;
      const buf = Buffer.alloc(Math.min(bufCap, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);

      let title;
      if (agent === 'omp') title = extractOmpTitle(buf);
      else if (agent === 'codex') title = extractCodexTitle(buf);
      else title = extractClaudeTitle(buf);
      if (title && /You have a hard 20.minute timeout/i.test(title)) title = 'Worker (20min)';

      sessions.push({
        id, title: meta[id]?.title || title || id.slice(0, 8),
        updatedAt: mtime.toISOString(),
        isActive: active.has(id.slice(0, 8)),
        agent,
        ...(isWorker ? { isWorker: true } : {}),
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
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic 'claude --resume ${id} --dangerously-skip-permissions --disallowed-tools AskUserQuestion'`, cwd);
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

async function sendInput(id, text) {
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
    setTimeout(() => {
      try { execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' }); } catch {}
    }, 300);
    return;
  }
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
    // Don't compress SSE streams — buffering breaks real-time delivery
    if (req.headers.accept === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

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
      result.push({ id, label: box.label || id, available: cached.available });
      continue;
    }
    let available = false;
    try {
      const r = await fetch(`${box.url}/api/health`, { signal: AbortSignal.timeout(8000) });
      available = r.ok;
    } catch {}
    boxStatusCache.set(id, { available, ts: now });
    result.push({ id, label: box.label || id, available });
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

app.get('/api/sessions/:id/stream', (req, res) => {
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
});

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

app.get('/api/sessions/:id/export', (req, res) => {
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
});

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

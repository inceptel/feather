import express from 'express';
import compression from 'compression';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket as WS } from 'ws';
import pty from 'node-pty';
import { parseMessage, parseOmpMessage, parseCodexMessage, parseMessageForAgent } from './lib/parse.js';
import { sessionIsActive, lastMessageMs, latestSessionActivityMs } from './lib/sessions.js';
import { extractCodexTitle } from './lib/session-titles.js';
import * as sidecar from './lib/sidecar.js';
import { createKeyedLock } from './lib/sendlock.js';
import { resolveCodexWatchId, codexAdoptionPending } from './lib/codex-watch.js';
import { createSnapshotCache } from './lib/snapshot-cache.js';
import { ensureStateLayout, resolveStatePaths } from './lib/state-paths.js';
import { resolveOmpModel, resolveOmpThinking, ompModelFlags, sanitizeOmpModel } from './lib/omp.js';
import { ompSessionCwdFromHead, ompSessionIdFromHead, ompTurnBoundaryFromLine } from './lib/omp-session.js';
import { createJsonState, isJsonRecord } from './lib/json-state.js';
import { encodeProjectPath, groupRoomSessions } from './lib/rooms.js';
import { listWikiPages, readWikiPage, verifiedWikiRoot } from './lib/room-wiki.js';
import { ROOM_LEADER_PROMPT_VERSION, roomLeaderPrompt } from './lib/room-leader.js';
import { parseFrictionNotes } from './lib/friction.js';
import { createProtocolRunStore } from './lib/protocol-runs.js';

// Load ~/.env if present
try {
  const envFile = fs.readFileSync(path.join(process.env.HOME || '/home/user', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

// A Feather-scoped OpenAI key is also the credential for Feather-launched
// Codex sessions. Keep an explicit OPENAI_API_KEY authoritative when present,
// but make the instance-owned key usable by the CLI without a second login.
if (!process.env.OPENAI_API_KEY && process.env.FEATHER_OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = process.env.FEATHER_OPENAI_API_KEY;
}

const DEEPGRAM_API_KEY = process.env.FEATHER_DEEPGRAM_API_KEY || '';
const envEnabled = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim());
const READ_ONLY_MODE = envEnabled(process.env.FEATHER_READ_ONLY);
const ROOM_PULSES_ENABLED = !READ_ONLY_MODE && !/^(0|false|no|off)$/i.test(String(process.env.FEATHER_ROOM_PULSES || '').trim());
const configuredPulseInterval = Number(process.env.FEATHER_ROOM_PULSE_INTERVAL_MS);
const ROOM_PULSE_INTERVAL_MS = Math.max(60_000, Number.isFinite(configuredPulseInterval) && configuredPulseInterval > 0
  ? configuredPulseInterval : 15 * 60 * 1000);
const configuredPulseCheck = Number(process.env.FEATHER_ROOM_PULSE_CHECK_MS);
const ROOM_PULSE_CHECK_MS = Math.max(50, Number.isFinite(configuredPulseCheck) && configuredPulseCheck > 0
  ? configuredPulseCheck : 60_000);
const configuredPulseMax = Number(process.env.FEATHER_ROOM_PULSE_MAX_CONCURRENT);
const ROOM_PULSE_MAX_CONCURRENT = Math.max(1, Number.isFinite(configuredPulseMax) && configuredPulseMax > 0
  ? Math.floor(configuredPulseMax) : 3);
const ROOM_PULSE_STARTED_AT = Date.now();
const READ_ONLY_ERROR = Object.freeze({ error: 'read-only canary', code: 'FEATHER_READ_ONLY' });
const SESSION_READ_ROUTE = /^\/api\/sessions\/[^/]+\/(messages|stream|export|protocol-runs)$/;
const SESSION_ROOM_ROUTE = /^\/api\/sessions\/[^/]+\/room$/;

const PORT = parseInt(process.env.PORT || '4870');
const HOME = process.env.HOME || '/home/user';
const STATE_PATHS = resolveStatePaths({ releaseDir: import.meta.dirname, homeDir: HOME });
const CLAUDE_PROJECTS = STATE_PATHS.harness.claudeProjectsDir;
const OMP_SESSIONS = STATE_PATHS.harness.ompSessionsDir;
// Every Feather-launched omp session gets an explicit model + reasoning level
// (see lib/omp.js). Passing them on resume also migrates existing sessions.
const OMP_MODEL = resolveOmpModel(process.env);
const OMP_THINKING = resolveOmpThinking(process.env);
const OMP_BRIDGE_EXTENSION = path.join(import.meta.dirname, 'omp-extensions', 'feather-bridge.js');
const OMP_PROTOCOL_EXTENSION = path.join(import.meta.dirname, 'omp-tools', 'feather-protocol-tools.js');
const OMP_COUNCIL_SKILL = path.join(import.meta.dirname, 'skills', 'council');
const OMP_FEATHER_CONFIG = path.join(import.meta.dirname, 'omp-feather.yml');
const ompBridgeTokens = new Map();
const ompBridgeLastSeen = new Map();
const OMP_DISCOVERED_BRIDGE = path.join(HOME, '.omp/agent/extensions/feather-bridge.js');
const OMP_DISCOVERED_PROTOCOL = path.join(HOME, '.omp/agent/extensions/feather-protocol-tools.js');
const OMP_DISCOVERED_COUNCIL = path.join(HOME, '.omp/agent/skills/council');
const OMP_BRIDGE_TOKENS_DIR = path.join(OMP_SESSIONS, '.feather-bridge-tokens');
// v1-v3 payloads remain accepted for compatibility, but only v4 marks the
// mirror live. Older sessions therefore keep the existing turn-boundary
// migration path into the current extension.
const OMP_BRIDGE_VERSION = 4;
const OMP_WORK_THINKING_CHARS = 3_000;
const OMP_BRIDGE_MAX_EVENT_BYTES = 120_000;
const OMP_BRIDGE_JSON_LIMITS = Object.freeze({
  maxDepth: 6,
  maxNodes: 500,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxKeyBytes: 240,
  maxStringBytes: 20_000,
  maxTotalBytes: 80_000,
});
const OMP_REPLAY_MAX_SESSIONS = 64;
const OMP_REPLAY_MAX_EVENTS = 128;
const OMP_REPLAY_MAX_BYTES = 512_000;
const OMP_BRIDGE_EVENT_TYPES = Object.freeze({
  assistant_snapshot: true,
  work_snapshot: true,
  assistant_end: true,
  assistant_cancel: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  agent_start: true,
  agent_end: true,
  auto_retry_start: true,
  auto_retry_end: true,
  auto_compaction_start: true,
  auto_compaction_end: true,
  credential_disabled: true,
  todo: true,
  tool_approval_requested: true,
  tool_approval_resolved: true,
  subagent_lifecycle: true,
  subagent_progress: true,
  async_jobs: true,
  session_state: true,
});
const CODEX_SESSIONS_ROOT = STATE_PATHS.harness.codexSessionsDir;
// Head bytes to read when looking for a codex session's first real user
// message (title, worker detection). The session_meta line plus permissions/
// context blocks before it now total ~66-88KB, so 64KB missed it; 256KB
// leaves headroom for further preamble growth.
const CODEX_HEAD_BYTES = 256 * 1024;
const STATIC_DIR = STATE_PATHS.release.staticDir;
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(STATE_PATHS.release.versionFile, 'utf8')).version; } catch { return 'unknown'; } })();
const BRIDGE_EXT = STATE_PATHS.release.bridgeExtension;
const BOXES_FILE = STATE_PATHS.instance.boxesFile;
const SHARING_FILE = STATE_PATHS.instance.sharingFile;
const SHARE_LOG = STATE_PATHS.coordination.shareAccessLog;

function isMessageReceiptState(value) {
  if (!isJsonRecord(value)) return false;
  return Object.values(value).every((session) => isJsonRecord(session)
    && Object.values(session).every((receipt) => isJsonRecord(receipt)
      && /^[0-9a-f]{64}$/.test(receipt.textHash)
      && isJsonRecord(receipt.response)
      && receipt.response.ok === true
      && typeof receipt.response.sentAt === 'string'));
}

// A canary must be able to inspect a prepared copy without creating directories,
// changing secret modes, or otherwise becoming a second state writer.
if (!READ_ONLY_MODE) ensureStateLayout(STATE_PATHS);

const BOXES_STATE = createJsonState({
  file: BOXES_FILE, root: STATE_PATHS.instance.root, document: 'boxes state',
  defaultValue: {}, validate: isJsonRecord, mode: 0o600,
});
const SHARING_STATE = createJsonState({
  file: SHARING_FILE, root: STATE_PATHS.instance.root, document: 'sharing state',
  defaultValue: {}, validate: isJsonRecord, mode: 0o600,
});
const MESSAGE_RECEIPTS_STATE = createJsonState({
  // Keep delivery metadata inside the already-classified, externally movable
  // uploads tree so immutable releases never gain a new writable root file.
  file: path.join(STATE_PATHS.instance.uploadsDir, '.message-receipts.json'),
  root: STATE_PATHS.instance.root,
  document: 'message delivery receipts',
  defaultValue: {},
  validate: isMessageReceiptState,
  mode: 0o600,
});

// Ensure omp session directory exists
if (!READ_ONLY_MODE) {
  try { fs.mkdirSync(OMP_SESSIONS, { recursive: true }); } catch {}
}

// ── Box proxy (remote machines) ────────────────────────────────────────────

function readBoxes() {
  return BOXES_STATE.read();
}

// ── Sharing (peers: other users' feather instances) ───────────────────────
// sharing.json (gitignored, 0600): { owner, peers: { id: { token, policy:
// 'all'|'selected', control: bool } }, grants: [{ peer, box, session|project }] }
// See docs/sharing-design.md.

function readSharing() {
  return SHARING_STATE.read();
}

// CLI: node server.js --add-peer NAME [--all] [--control] — prints the token
// to hand to the peer, then exits without starting the server.
if (process.argv.includes('--add-peer')) {
  if (READ_ONLY_MODE) {
    console.error('cannot add a peer while FEATHER_READ_ONLY is enabled');
    process.exit(1);
  }
  const name = process.argv[process.argv.indexOf('--add-peer') + 1];
  if (!name || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
    console.error('usage: node server.js --add-peer <name> [--all] [--control]');
    process.exit(1);
  }
  const sharing = SHARING_STATE.update((current) => {
    const peers = isJsonRecord(current.peers) ? current.peers : {};
    const existing = peers[name] || {};
    const token = existing.token || randomBytes(32).toString('hex');
    return {
      ...current,
      peers: {
        ...peers,
        [name]: {
          ...existing,
          token,
          policy: process.argv.includes('--all') ? 'all' : (existing.policy || 'selected'),
          control: process.argv.includes('--control') || !!existing.control,
        },
      },
    };
  });
  const p = sharing.peers[name];
  console.log(`peer "${name}": policy=${p.policy} control=${p.control}`);
  console.log(`token (give to ${name} for their boxes.json entry pointing at this instance):`);
  console.log(p.token);
  console.log(`\nexample entry for ${name}'s boxes.json:`);
  console.log(JSON.stringify({ [sharing.owner || 'friend']: { url: 'http://<this-host>:4870', label: sharing.owner || 'Friend', peer: true, token: p.token } }, null, 2));
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

function findPeerById(id) {
  const cfg = readSharing().peers?.[id];
  return cfg ? { id, policy: cfg.policy || 'selected', control: !!cfg.control } : null;
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
  // Preserve client idempotency across owner/peer box proxies. The remote
  // validates the value before using it as a durable delivery receipt key.
  if (req.headers['x-feather-message-id']) {
    headers['X-Feather-Message-ID'] = req.headers['x-feather-message-id'];
  }

  // Peer boxes (another user's instance): only the share surface is ever
  // forwarded — rewritten onto their token-gated /api/share namespace. The
  // remote enforces its own grants; this allowlist just refuses to even ask
  // for anything outside view + send/interrupt/interactive terminal controls.
  if (box.peer) {
    const allowed =
      (req.method === 'GET' && (pathname === '/api/sessions' || SESSION_READ_ROUTE.test(pathname))) ||
      (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/(send|interrupt|keys)$/.test(pathname));
    if (!allowed) return res.status(403).json({ error: `peer box ${boxId}: only viewing shared sessions (and controls if granted) is supported` });
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

const META_FILE = STATE_PATHS.instance.metaFile;
const META_STATE = createJsonState({
  file: META_FILE, root: STATE_PATHS.instance.root, document: 'session metadata',
  defaultValue: {}, validate: isJsonRecord,
});

function readMeta() {
  return META_STATE.read();
}

function updateMeta(mutator) { return META_STATE.update(mutator); }

const MESSAGE_TAIL_CHUNK_BYTES = 1024 * 1024;

function readLatestMessages(fpath, agent, count) {
  const wanted = Math.max(1, count);
  const reverse = [];
  const fd = fs.openSync(fpath, 'r');
  let position = fs.fstatSync(fd).size;
  let suffix = Buffer.alloc(0);
  try {
    while (position > 0 && reverse.length <= wanted) {
      const length = Math.min(MESSAGE_TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, position);
      const data = suffix.length ? Buffer.concat([chunk, suffix]) : chunk;
      let end = data.length;
      while (reverse.length <= wanted) {
        const newline = data.lastIndexOf(10, end - 1);
        if (newline < 0) break;
        const line = data.subarray(newline + 1, end);
        end = newline;
        if (!line.length) continue;
        const message = parseMessageForAgent(line.toString('utf8'), agent);
        if (message) reverse.push(message);
      }
      suffix = Buffer.from(data.subarray(0, end));
    }
    if (position === 0 && reverse.length <= wanted && suffix.length) {
      const message = parseMessageForAgent(suffix.toString('utf8'), agent);
      if (message) reverse.push(message);
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    messages: reverse.slice(0, wanted).reverse(),
    hasEarlier: reverse.length > wanted,
  };
}

function getMessages(sessionId, limit = 100, before = 0) {
  const agent = getAgentForSession(sessionId);
  const fpath = findJsonlPath(sessionId, agent);
  if (!fpath || !fs.existsSync(fpath)) return { messages: [], hasMore: false };
  const pageSize = Math.max(1, limit);
  const offset = Math.max(0, before);
  const tail = readLatestMessages(fpath, agent, pageSize + offset);
  const end = Math.max(0, tail.messages.length - offset);
  const start = Math.max(0, end - pageSize);
  return {
    messages: tail.messages.slice(start, end),
    hasMore: tail.hasEarlier || start > 0,
  };
}

// ── Session discovery ───────────────────────────────────────────────────────

function getActiveTmuxSessions() {
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}|#{session_created}'], { encoding: 'utf8' });
    const active = new Map();
    for (const line of out.split('\n')) {
      const [name, created] = line.split('|');
      if (name?.startsWith('feather-')) {
        active.set(name.slice(8), Number(created) * 1000 || 0); // first 8 chars of session id
      }
    }
    return active;
  } catch { return new Map(); }
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
          if (argsMatch?.[1]?.trim()) return `${nameMatch?.[1] || '/cmd'} ${argsMatch[1].trim()}`.slice(0, 240);
          continue;
        }
        if (text && !text.startsWith('<')) return text.slice(0, 240);
      }
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
        try {
          const stat = fs.statSync(full);
          out.push({ uuid, fpath: full, mtime: stat.mtime, size: stat.size });
        } catch {}
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
      if (d.type === 'session' && d.title) return d.title.slice(0, 240);
      // Fall back to first user message
      if (d.type === 'message' && d.message?.role === 'user') {
        const content = d.message.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) text = content.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
        text = text.trim();
        if (text) return text.slice(0, 240);
      }
    } catch {}
  }
  return null;
}

function extractSessionCwd(buf, agent) {
  if (agent === 'codex') return extractCodexCwd(buf) || '';
  if (agent === 'claude') return extractClaudeCwd(buf) || '';
  return '';
}

function isAutoWorkerSession(buf, agent, projectId, cwd) {
  if (buf.includes('AUTO_WORKER=TRUE')) return true;
  if (projectId && /-home-user-(?:auto|autoweb)-/.test(projectId)) return true;
  // Sealed room workers (bin/room lookup/council/second-opinion) run headless
  // in ~/.feather/room-runs/<room>/<run>/ — transcript noise, not sessions.
  if (projectId && projectId.includes('-feather-room-runs-')) return true;
  if (/^\/home\/user\/\.feather\/room-runs\//.test(cwd)) return true;
  return /^\/home\/user\/(?:auto|autoweb)-/.test(cwd);
}

// Full-content search across session JSONL files. Shells out to grep (fixed
// string, case-insensitive) because session files can be >100MB and node-side
// scanning would be slow. Returns the Set of file paths that contain `q`.
function grepSessionFiles(q, files) {
  const matches = new Set();
  const CHUNK = 200; // stay well under ARG_MAX
  for (let i = 0; i < files.length; i += CHUNK) {
    const batch = files.slice(i, i + CHUNK);
    let out = '';
    try {
      out = execFileSync('grep', ['-lisF', '--', q, ...batch], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 }).toString();
    } catch (e) {
      // grep exits 1 when some files have no match; partial matches are still on stdout
      out = e.stdout ? e.stdout.toString() : '';
    }
    for (const line of out.split('\n')) if (line) matches.add(line);
  }
  return matches;
}

const sessionCandidateCache = new Map();

function inspectSessionCandidate({ fpath, mtime, size, agent, projectId: candidateProjectId }) {
  const mtimeMs = mtime.getTime();
  const cached = sessionCandidateCache.get(fpath);
  if (cached && cached.agent === agent && size >= cached.size) {
    if (cached.mtimeMs === mtimeMs && cached.size === size) return cached;
    try {
      let activityMs = cached.activityMs;
      const appendedBytes = size - cached.size;
      if (appendedBytes > 0) {
        if (appendedBytes <= 4 * 1024 * 1024) {
          const fd = fs.openSync(fpath, 'r');
          try {
            const appended = Buffer.allocUnsafe(appendedBytes);
            fs.readSync(fd, appended, 0, appendedBytes, cached.size);
            activityMs = Math.max(activityMs, lastMessageMs(appended.toString('utf8'), agent) || 0);
          } finally {
            fs.closeSync(fd);
          }
        } else {
          activityMs = lastActivityMs(fpath, agent, mtimeMs);
        }
      }
      const next = { ...cached, mtimeMs, size, activityMs };
      sessionCandidateCache.set(fpath, next);
      return next;
    } catch {}
  }
  const fd = fs.openSync(fpath, 'r');
  let buf;
  try {
    const bufCap = agent === 'codex' ? CODEX_HEAD_BYTES : 16384;
    buf = Buffer.alloc(Math.min(bufCap, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const sessionCwd = extractSessionCwd(buf, agent);
  const projectId = candidateProjectId || (sessionCwd ? encodeProjectPath(sessionCwd) : null);
  let title;
  if (agent === 'omp') title = extractOmpTitle(buf);
  else if (agent === 'codex') title = extractCodexTitle(buf);
  else title = extractClaudeTitle(buf);
  const facts = {
    mtimeMs,
    size,
    agent,
    projectId,
    title,
    worker: isAutoWorkerSession(buf, agent, projectId, sessionCwd),
    activityMs: lastActivityMs(fpath, agent, mtimeMs),
  };
  sessionCandidateCache.set(fpath, facts);
  return facts;
}

// `query`, when set, filters to sessions whose title OR full JSONL content
// contains it (case-insensitive). Search ignores the mtime-ranked candidate
// cutoff that the plain listing has: every candidate is considered, so old
// threads that fell off the sidebar are still findable.
function discoverSessions(limit = 50, query = null, requiredIds = []) {
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
            candidates.push({ id: file.replace('.jsonl', ''), fpath, mtime: stat.mtime, size: stat.size, agent: 'claude', projectId: dir });
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
        candidates.push({ id: dir, fpath, mtime: stat.mtime, size: stat.size, agent: 'omp' });
      } catch {}
    }
  }

  // codex sessions
  for (const { uuid, fpath, mtime, size } of listCodexJsonlFiles()) {
    if (size < 50) continue;
    candidates.push({ id: codexLocalIds.get(uuid) || uuid, fpath, mtime, size, agent: 'codex' });
  }

  // Sort by mtime descending; loop until we have `limit` non-worker sessions.
  // Content-based worker detection requires reading the file, so we can't pre-filter.
  candidates.sort((a, b) => b.mtime - a.mtime);

  // Content matches are computed up front in one grep pass over all candidate
  // files; title matches are checked per-candidate inside the loop below.
  const contentMatches = query ? grepSessionFiles(query, candidates.map(c => c.fpath)) : null;
  const queryLc = query ? query.toLowerCase() : null;

  const active = getActiveTmuxSessions();
  // Green "active" dot = live tmux session AND a recent real message. We use the
  // last real message time (lastActivityMs), NOT the file mtime: a resumed agent
  // keeps appending system/permission lines to the JSONL while idle, which bump
  // mtime and lit the dot (and floated the row to the top) on sessions that had
  // no actual message in hours. See lib/sessions.js.
  const now = Date.now();

  const sessions = [];
  const required = new Set(requiredIds);
  for (const candidate of candidates) {
    const { id, fpath, agent } = candidate;
    if (sessions.length >= limit) {
      if (required.size === 0) break;
      if (!required.has(id)) continue;
    }
    try {
      const facts = inspectSessionCandidate(candidate);
      if (facts.worker) continue;
      const effectiveTitle = meta[id]?.title || facts.title || id.slice(0, 8);
      if (queryLc && !id.toLowerCase().includes(queryLc) && !effectiveTitle.toLowerCase().includes(queryLc) && !contentMatches.has(fpath)) continue;

      // Project label is shown only for allowlisted projects (key present in labels);
      // unlisted sessions still carry projectId but appear unlabelled in the "All" view.
      const isAllowlisted = facts.projectId && (facts.projectId in labels);
      sessions.push({
        id, title: effectiveTitle,
        updatedAt: new Date(facts.activityMs).toISOString(),
        isActive: sessionIsActive(active, id, facts.activityMs, now),
        agent,
        projectId: facts.projectId || null,
        projectLabel: isAllowlisted ? (labels[facts.projectId] || cleanProjectLabel(facts.projectId)) : null,
        share: Array.isArray(meta[id]?.share) && meta[id].share.length ? meta[id].share : undefined,
      });
      required.delete(id);
    } catch {}
  }

  // Re-sort by real activity. Candidates were ordered by file mtime, which is
  // bumped by idle bookkeeping writes; ordering by last real message keeps the
  // list "sorted by last message time" as users expect.
  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return sessions;
}

// Tail sizes tried in order, growing only when the smaller read found no real
// message. Some agents append bookkeeping lines (heartbeats, status) while
// idle, so on a session left open for days the last real message can sit
// megabytes back from EOF: a fixed 512KB tail found nothing, fell back to the
// (always fresh) mtime, and lit the green dot on long-idle sessions.
const ACTIVITY_TAILS = [512 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024];

// Epoch-ms of the last real user/assistant message in a session's JSONL — the
// true "last activity". Reads only the file tail (messages are appended), and
// falls back to `fallbackMs` (the file mtime) if no real message is found.
function lastActivityMs(fpath, agent, fallbackMs) {
  try {
    const size = fs.statSync(fpath).size;
    const fd = fs.openSync(fpath, 'r');
    try {
      for (const tail of ACTIVITY_TAILS) {
        const readLen = Math.min(size, tail);
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, size - readLen);
        const ts = lastMessageMs(buf.toString('utf8'), agent, size > readLen);
        if (ts) return ts;
        if (readLen >= size) break; // whole file already scanned
      }
    } finally { fs.closeSync(fd); }
    return fallbackMs;
  } catch { return fallbackMs; }
}

// ── Tmux management ─────────────────────────────────────────────────────────

function tmuxName(id) { return `feather-${id.slice(0, 8)}`; }

function tmuxIsActive(id) {
  try { execFileSync('tmux', ['has-session', '-t', tmuxName(id)], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function validateFreshSessionId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw httpError(400, 'session id must be a UUID');
  const assignments = readRoomAssignments();
  const leaders = ROOM_LEADERS_STATE.read();
  const residentIds = Object.values(ROOM_RESIDENTS_STATE.read())
    .flatMap((residents) => Object.values(residents).map((resident) => resident.sessionId));
  if (readMeta()[id]
    || assignments[id]
    || Object.values(leaders).includes(id)
    || residentIds.includes(id)
    || tmuxIsActive(id)
    || fs.existsSync(path.join(OMP_SESSIONS, id))
    || findJsonlPath(id)) {
    throw httpError(409, 'session id already exists');
  }
  return id;
}

function launchInTmux(name, cmd, cwd) {
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  execFileSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd || HOME, cmd], { stdio: 'ignore' });
  execFileSync('tmux', ['set-option', '-t', name, 'prefix', 'M-a'], { stdio: 'ignore' });
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

// Claude Code's workspace trust prompt defaults to "No, exit". Feather sends
// Enter after launch to dismiss harmless startup prompts, so an untrusted cwd
// otherwise exits before the first message and leaves /send targeting no tmux.
function ensureClaudeTrust(cwd) {
  const trustedCwd = cwd || HOME;
  const cfg = path.join(HOME, '.claude.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[claude] could not read workspace trust for ${trustedCwd}:`, error.message);
      return;
    }
  }
  const projects = isJsonRecord(settings.projects) ? settings.projects : {};
  const current = isJsonRecord(projects[trustedCwd]) ? projects[trustedCwd] : {};
  if (current.hasTrustDialogAccepted === true) return;
  const next = {
    ...settings,
    projects: {
      ...projects,
      [trustedCwd]: { ...current, hasTrustDialogAccepted: true },
    },
  };
  const temporary = `${cfg}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temporary, cfg);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    console.warn(`[claude] could not trust workspace ${trustedCwd}:`, error.message);
  }
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}
function ompBridgeTokenPath(sessionId) {
  const file = createHash('sha256').update(String(sessionId)).digest('hex');
  return path.join(OMP_BRIDGE_TOKENS_DIR, file);
}
function ensureManagedOmpSymlink(discoveredPath, targetPath, expectedSuffix, label) {
  fs.mkdirSync(path.dirname(discoveredPath), { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(discoveredPath);
    if (!stat.isSymbolicLink()) {
      console.warn(`[omp ${label}] discovery path is occupied: ${discoveredPath}`);
      return false;
    }
    const currentTarget = path.resolve(path.dirname(discoveredPath), fs.readlinkSync(discoveredPath));
    if (currentTarget === targetPath) return true;
    if (!currentTarget.endsWith(expectedSuffix)) {
      console.warn(`[omp ${label}] refusing to replace unrelated symlink: ${discoveredPath}`);
      return false;
    }
    const replacement = `${discoveredPath}.tmp-${process.pid}`;
    try { fs.unlinkSync(replacement); } catch {}
    fs.symlinkSync(targetPath, replacement);
    fs.renameSync(replacement, discoveredPath);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.symlinkSync(targetPath, discoveredPath);
  return true;
}

function ensureOmpBridgeDiscovery() {
  return ensureManagedOmpSymlink(
    OMP_DISCOVERED_BRIDGE,
    OMP_BRIDGE_EXTENSION,
    path.join('omp-extensions', 'feather-bridge.js'),
    'bridge',
  );
}

function ensureOmpCouncilDiscovery() {
  ensureManagedOmpSymlink(
    OMP_DISCOVERED_PROTOCOL,
    OMP_PROTOCOL_EXTENSION,
    path.join('omp-tools', 'feather-protocol-tools.js'),
    'protocols',
  );
  ensureManagedOmpSymlink(
    OMP_DISCOVERED_COUNCIL,
    OMP_COUNCIL_SKILL,
    path.join('skills', 'council'),
    'council',
  );
}





// Per-session OMP model override: persisted in session meta (ompModel) so
// spawn, resume, fork, pulse, and bridge migration all keep the same model.
function ompSessionModel(id) {
  const stored = sanitizeOmpModel(readMeta()[id]?.ompModel || '');
  return stored || OMP_MODEL;
}

function roomLeaderNameForSession(id) {
  const leaders = ROOM_LEADERS_STATE.read();
  return Object.entries(leaders).find(([, sessionId]) => sessionId === id)?.[0] || null;
}

function writeRoomLeaderPrompt(id, roomName) {
  if (!roomName) return null;
  const promptDir = path.join(HOME, '.feather', 'room-leader-prompts');
  fs.mkdirSync(promptDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(promptDir, 0o700);
  const promptPath = path.join(promptDir, `${id}-v${ROOM_LEADER_PROMPT_VERSION}.md`);
  fs.writeFileSync(promptPath, roomLeaderPrompt(roomName), { mode: 0o600 });
  fs.chmodSync(promptPath, 0o600);
  return promptPath;
}
function launchOmpSession(id, cwd, { resume = false, promptFile = null, autoApprove = false } = {}) {
  if (!resume) resetOmpBridgeSessionState(id);
  const sessionDir = path.join(OMP_SESSIONS, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const leaderPromptFile = writeRoomLeaderPrompt(id, roomLeaderNameForSession(id));
  watchOmpSessionDir(sessionDir, id);
  const ompId = resume ? getOmpSessionId(id) : null;
  if (resume && !ompId) throw new Error(`Cannot resume OMP session ${id}: exact OMP session id not found`);
  const bridgeToken = randomUUID();
  const bridgeUrl = `http://127.0.0.1:${PORT}/api/internal/sessions/${id}/events`;
  ompBridgeTokens.set(id, bridgeToken);
  ompBridgeLastSeen.delete(id);
  const bridgeDiscovered = ensureOmpBridgeDiscovery();
  ensureOmpCouncilDiscovery();
  fs.mkdirSync(OMP_BRIDGE_TOKENS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(OMP_BRIDGE_TOKENS_DIR, 0o700);
  fs.writeFileSync(ompBridgeTokenPath(id), bridgeToken, { mode: 0o600 });
  fs.chmodSync(ompBridgeTokenPath(id), 0o600);
  fs.writeFileSync(path.join(sessionDir, '.feather-bridge.json'), JSON.stringify({
    url: bridgeUrl, token: bridgeToken, sessionId: id,
  }), { mode: 0o600 });
  fs.chmodSync(path.join(sessionDir, '.feather-bridge.json'), 0o600);
  const args = [
    'omp',
    ompModelFlags(ompSessionModel(id), OMP_THINKING).trim(),
    resume ? `--resume ${shellQuote(ompId)}` : '',
    leaderPromptFile ? `--append-system-prompt ${shellQuote(leaderPromptFile)}` : '',
    promptFile ? `-p ${autoApprove ? '--auto-approve ' : ''}${shellQuote(`@${promptFile}`)}` : '',
    bridgeDiscovered ? '' : `--extension ${shellQuote(OMP_BRIDGE_EXTENSION)}`,
    `--config ${shellQuote(OMP_FEATHER_CONFIG)}`,
    `--session-dir ${shellQuote(sessionDir)}`,
    '--allow-home',
  ].filter(Boolean).join(' ');
  const env = [
    `FEATHER_BRIDGE_URL=${shellQuote(bridgeUrl)}`,
    `FEATHER_BRIDGE_TOKEN=${shellQuote(bridgeToken)}`,
    `FEATHER_SESSION_ID=${shellQuote(id)}`,
  ].join(' ');
  const command = `bash --rcfile ~/.bashrc -ic ${shellQuote(`${env} ${args}`)}`;
  launchInTmux(tmuxName(id), command, cwd);
}

function spawnSession(id, cwd, agent = 'claude', { ompModel = '' } = {}) {
  const name = tmuxName(id);
  // Persist agent type (and any OMP model override) in metadata
  const model = agent === 'omp' ? sanitizeOmpModel(ompModel) : '';
  updateMeta((meta) => ({ ...meta, [id]: { ...(meta[id] || {}), agent, ...(model ? { ompModel: model } : {}) } }));

  if (agent === 'omp') {
    launchOmpSession(id, cwd);
  } else if (agent === 'codex') {
    // Codex doesn't accept a preset session id (issue openai/codex#15767).
    // Snapshot existing rollout files, spawn codex, then poll for the new file
    // and adopt its UUID into session-meta.
    ensureCodexTrust(cwd);
    const before = new Set(listCodexJsonlFiles().map(f => f.uuid));
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic 'codex -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox'`, cwd);
    adoptNewCodexUuid(id, before, cwd);
  } else {
    ensureClaudeTrust(cwd);
    const leaderPromptFile = writeRoomLeaderPrompt(id, roomLeaderNameForSession(id));
    const args = [
      'claude',
      `--session-id ${shellQuote(id)}`,
      leaderPromptFile ? `--append-system-prompt-file ${shellQuote(leaderPromptFile)}` : '',
      '--dangerously-skip-permissions',
      '--disallowed-tools AskUserQuestion',
    ].filter(Boolean).join(' ');
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic ${shellQuote(args)}`, cwd);
  }
}

function adoptNewCodexUuid(featherId, beforeUuids, spawnCwd = null, attempts = 320) {
  // Poll ~/.codex/sessions for a rollout file that didn't exist before spawn.
  // Newer codex builds only write the rollout on the FIRST user message, which
  // can be minutes after launch — so poll fast for ~10s, then back off to 2s
  // for ~10 minutes total. When spawnCwd is given, only rollouts whose
  // session_meta cwd matches are considered, so two sessions spawned close
  // together can't adopt each other's file.
  let n = 0;
  const tick = () => {
    // Deleting a starting Codex session removes its metadata. Stop its delayed
    // adopter too, or a later unrelated rollout can resurrect a ghost entry.
    if (!codexAdoptionPending(readMeta(), featherId)) return;
    n++;
    const after = listCodexJsonlFiles();
    let fresh = after.filter(f => !beforeUuids.has(f.uuid));
    if (spawnCwd && fresh.length > 0) {
      fresh = fresh.filter(f => {
        try {
          const fd = fs.openSync(f.fpath, 'r');
          const buf = Buffer.alloc(Math.min(CODEX_HEAD_BYTES, fs.fstatSync(fd).size));
          fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          return extractCodexCwd(buf) === spawnCwd;
        } catch { return false; }
      });
    }
    if (fresh.length > 0) {
      // Pick the newest fresh file
      fresh.sort((a, b) => b.mtime - a.mtime);
      const uuid = fresh[0].uuid;
      updateMeta((meta) => ({
        ...meta,
        [featherId]: { ...(meta[featherId] || {}), agent: 'codex', codexUuid: uuid },
      }));
      // Start watching this file for SSE broadcasts
      fileOffsets.set(featherId, 0);
      watchCodexFile(fresh[0].fpath, featherId);
      console.log(`[codex] adopted UUID ${uuid} for feather session ${featherId}`);
      return;
    }
    if (n < attempts) setTimeout(tick, n < 20 ? 500 : 2000);
    else console.warn(`[codex] failed to adopt UUID for ${featherId} after ${attempts} attempts`);
  };
  setTimeout(tick, 500);
}

function resumeSession(id, cwd) {
  const agent = getAgentForSession(id);
  const name = tmuxName(id);
  if (agent === 'omp') {
    launchOmpSession(id, cwd || getOmpSessionCwd(id), { resume: true });
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
      try { sessionCwd = extractCodexCwd(fs.readFileSync(fpath).slice(0, CODEX_HEAD_BYTES)); } catch {}
    }
    sessionCwd = (sessionCwd || HOME).replace(/[^a-zA-Z0-9._\-/]/g, '');
    ensureCodexTrust(sessionCwd);
    const resumeArg = codexUuid ? `resume ${codexUuid}` : 'resume --last';
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic 'codex -c check_for_update_on_startup=false ${resumeArg} --cd ${sessionCwd} --dangerously-bypass-approvals-and-sandbox'`, cwd || sessionCwd);
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
    ensureClaudeTrust(sessionCwd);
    const leaderPromptFile = writeRoomLeaderPrompt(id, roomLeaderNameForSession(id));
    const args = [
      'claude',
      `--resume ${shellQuote(id)}`,
      leaderPromptFile ? `--append-system-prompt-file ${shellQuote(leaderPromptFile)}` : '',
      '--dangerously-skip-permissions',
      '--disallowed-tools AskUserQuestion',
    ].filter(Boolean).join(' ');
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic ${shellQuote(args)}`, sessionCwd);
  }
}

function readOmpSessionHead(featherId) {
  const fpath = findOmpJsonlPath(featherId);
  if (!fpath) return null;
  try {
    const fd = fs.openSync(fpath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function getOmpSessionId(featherId) {
  return ompSessionIdFromHead(readOmpSessionHead(featherId));
}

function getOmpSessionCwd(featherId) {
  return ompSessionCwdFromHead(readOmpSessionHead(featherId));
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

async function sendInputIdempotent(id, text, messageId) {
  return sendLock(id, async () => {
    const textHash = createHash('sha256').update(String(text)).digest('hex');
    const existing = MESSAGE_RECEIPTS_STATE.read()[id]?.[messageId];
    if (existing) {
      if (existing.textHash !== textHash) throw httpError(409, 'message id already used with different text');
      return existing.response;
    }

    await sendInputUnlocked(id, text);
    const response = { ok: true, sentAt: new Date().toISOString() };
    MESSAGE_RECEIPTS_STATE.update((current) => ({
      ...current,
      [id]: {
        ...(isJsonRecord(current[id]) ? current[id] : {}),
        [messageId]: { textHash, response },
      },
    }));
    return response;
  });
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
  // Multi-line text must go through paste-buffer too: send-keys -l types the
  // literal \n, which Claude CLI treats as Enter — submitting after the first
  // line (e.g. only the first of several [Attached image: …] markers).
  if (text.length > 500 || text.includes('\n')) {
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
const ssePeerAuth = new WeakMap();
let sharingRevision = 0;
const ssePendingWrites = new WeakMap();
const SSE_WRITE_QUEUE_MAX_BYTES = 1_048_576;

function ssePeerAuthorized(sessionId, res, force = false) {
  const auth = ssePeerAuth.get(res);
  if (!auth) return true;
  if (!force && auth.revision === sharingRevision) return true;
  const peer = findPeerById(auth.peerId);
  if (!peer || !peerCanAccessSession(peer, sessionId)) return false;
  auth.revision = sharingRevision;
  return true;
}

function closeSseClient(clients, res) {
  clients.delete(res);
  ssePendingWrites.delete(res);
  try { res.end(); } catch {}
}

function flushSseWrites(sessionId, clients, res, state) {
  if (!ssePeerAuthorized(sessionId, res)) {
    closeSseClient(clients, res);
    return;
  }
  try {
    while (!state.waiting && state.queue.length > 0) {
      const chunk = state.queue.shift();
      state.bytes -= Buffer.byteLength(chunk);
      if (!res.write(chunk)) {
        state.waiting = true;
        res.once('drain', () => {
          state.waiting = false;
          flushSseWrites(sessionId, clients, res, state);
        });
      }
    }
  } catch {
    closeSseClient(clients, res);
  }
}

function writeSse(sessionId, clients, res, chunk, forceAuth = false) {
  if (!ssePeerAuthorized(sessionId, res, forceAuth)) {
    closeSseClient(clients, res);
    return false;
  }
  let state = ssePendingWrites.get(res);
  if (!state) {
    state = { queue: [], bytes: 0, waiting: false };
    ssePendingWrites.set(res, state);
  }
  if (state.waiting) {
    const bytes = Buffer.byteLength(chunk);
    if (state.bytes + bytes > SSE_WRITE_QUEUE_MAX_BYTES) {
      closeSseClient(clients, res);
      return false;
    }
    state.queue.push(chunk);
    state.bytes += bytes;
    return true;
  }
  try {
    if (!res.write(chunk)) {
      state.waiting = true;
      res.once('drain', () => {
        state.waiting = false;
        flushSseWrites(sessionId, clients, res, state);
      });
    }
    return true;
  } catch {
    closeSseClient(clients, res);
    return false;
  }
}

function evictRevokedSseClients(sessionId) {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  for (const res of clients) {
    if (ssePeerAuthorized(sessionId, res, true)) continue;
    closeSseClient(clients, res);
  }
}

function broadcast(sessionId, line, offset) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const agent = getAgentForSession(sessionId);
  const parsed = parseMessageForAgent(line, agent);
  if (!parsed) return;
  const chunk = `id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`;
  for (const res of clients) writeSse(sessionId, clients, res, chunk);
}

function broadcastNamedEvent(sessionId, eventName, data) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const chunk = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) writeSse(sessionId, clients, res, chunk);
}

const protocolRuns = createProtocolRunStore({
  root: path.join(HOME, '.feather', 'protocol-runs'),
  onSnapshot: (sessionId, snapshot) => broadcastNamedEvent(sessionId, 'protocol_run', snapshot),
  readOnly: READ_ONLY_MODE,
});

function replayProtocolRuns(sessionId, clients, res) {
  for (const snapshot of protocolRuns.list(sessionId, 50)) {
    const chunk = `event: protocol_run\ndata: ${JSON.stringify(snapshot)}\n\n`;
    if (!writeSse(sessionId, clients, res, chunk)) break;
  }
}

function ompTranscriptLines(sessionId, cache) {
  if (cache?.has(sessionId)) return cache.get(sessionId);
  const file = findOmpJsonlPath(sessionId);
  let lines = [];
  try { lines = file ? fs.readFileSync(file, 'utf8').split('\n') : []; } catch {}
  cache?.set(sessionId, lines);
  return lines;
}

function ompOwnerExecutionIsTerminal(sessionId, ownerExecutionId, cache) {
  const lines = ompTranscriptLines(sessionId, cache);
  if (lines.length === 0) return false;
  let found = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Corruption cannot provide a positive owner-terminal signal.
      return false;
    }
    if (!found) {
      found = entry?.type === 'message' && entry.id === ownerExecutionId && entry.message?.role === 'user';
      continue;
    }
    if (entry?.type === 'message' && entry.message?.role === 'user') return true;
    if (entry?.type === 'custom' && entry.customType === 'session_exit') return true;
    if (ompTurnBoundaryFromLine(line) === 'completed') return true;
  }
  return false;
}

function ompUserText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
}

function ompAdvisoryOwnerForRun(run, cache) {
  const lines = ompTranscriptLines(run.sessionId, cache);
  if (lines.length === 0) return null;
  const expected = `Run Advisory: ${run.question}`;
  const createdAt = Date.parse(run.createdAt || '');
  let owner = null;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { return null; }
    if (entry?.type !== 'message' || entry.message?.role !== 'user' || ompUserText(entry.message) !== expected) continue;
    if (Number.isFinite(createdAt) && Number.isFinite(Date.parse(entry.timestamp)) && Date.parse(entry.timestamp) + 5_000 < createdAt) continue;
    if (typeof entry.id === 'string' && entry.id) owner = entry.id;
  }
  return owner;
}

async function bindUnclaimedProtocolOwner(sessionId, ownerExecutionId, cache) {
  const run = protocolRuns.unclaimedStarting(sessionId)
    .find(candidate => ompAdvisoryOwnerForRun(candidate, cache) === ownerExecutionId);
  if (!run) return false;
  try {
    await protocolRuns.claim(sessionId, { ownerExecutionId, invocationMessageId: ownerExecutionId });
    return true;
  } catch (error) {
    if (error.code === 'PROTOCOL_CLAIM_AMBIGUOUS') return false;
    throw error;
  }
}

async function reconcileProtocolRunOwners() {
  const transcriptCache = new Map();
  for (const initial of protocolRuns.active()) {
    let run = initial;
    if (!run.ownerExecutionId) {
      const ownerExecutionId = ompAdvisoryOwnerForRun(run, transcriptCache);
      if (!ownerExecutionId) continue;
      if (!await bindUnclaimedProtocolOwner(run.sessionId, ownerExecutionId, transcriptCache)) continue;
      run = protocolRuns.get(run.sessionId, run.runId);
    }
    if (ompOwnerExecutionIsTerminal(run.sessionId, run.ownerExecutionId, transcriptCache)) {
      await protocolRuns.ownerTerminated(run.sessionId, run.ownerExecutionId);
    }
  }
}

const ompBridgeReplay = new Map();
let ompBridgeReplaySequence = 0;

function resetOmpBridgeSessionState(sessionId) {
  cancelOmpBridgeMigration(sessionId);
  ompBridgeReplay.delete(sessionId);
  ompBridgeLastSeen.delete(sessionId);
  const clients = sseClients.get(sessionId);
  if (clients) {
    for (const res of clients) closeSseClient(clients, res);
    sseClients.delete(sessionId);
  }
}

function replayOwner(event) {
  return event.subagentId || 'parent';
}

function replayKey(event) {
  const owner = replayOwner(event);
  if (event.type === 'agent_start' && !event.subagentId) return 'run:parent';
  if (event.type === 'session_state' || event.type === 'async_jobs') return `singleton:${event.type}`;
  if (event.type === 'todo') return `todo:${owner}`;
  if (event.type === 'tool_approval_requested') return `approval:${event.toolCallId}`;
  if (event.type === 'subagent_lifecycle' || event.type === 'subagent_progress') return `subagent:${event.id}`;
  if (event.type.startsWith('tool_execution_')) return `tool:${owner}:${event.toolCallId}`;
  if (event.type === 'assistant_snapshot' || event.type === 'work_snapshot') {
    return `${event.type}:${owner}:${event.messageId}`;
  }
  if (event.type === 'assistant_cancel' && event.willContinue) return null;
  if ((event.type === 'assistant_end' || event.type === 'assistant_cancel') && event.subagentId) {
    return `terminal:${owner}:${event.messageId}`;
  }
  if (event.type === 'assistant_end' || event.type === 'assistant_cancel') return 'terminal:parent';
  return null;
}

function replayStoreFor(sessionId) {
  let store = ompBridgeReplay.get(sessionId);
  if (store) {
    store.touchedAt = Date.now();
    return store;
  }
  if (ompBridgeReplay.size >= OMP_REPLAY_MAX_SESSIONS) {
    let oldestId;
    let oldestAt = Infinity;
    for (const [id, candidate] of ompBridgeReplay) {
      if (candidate.touchedAt < oldestAt) {
        oldestId = id;
        oldestAt = candidate.touchedAt;
      }
    }
    if (oldestId) ompBridgeReplay.delete(oldestId);
  }
  store = { entries: new Map(), bytes: 0, touchedAt: Date.now() };
  ompBridgeReplay.set(sessionId, store);
  return store;
}

function deleteReplayEntries(store, predicate) {
  for (const [key, entry] of store.entries) {
    if (!predicate(entry.event)) continue;
    store.entries.delete(key);
    store.bytes -= entry.bytes;
  }
}

function isTransientReplayEventForOwner(event, owner) {
  return replayOwner(event) === owner && (
    event.type === 'assistant_snapshot' ||
    event.type === 'work_snapshot' ||
    event.type.startsWith('tool_execution_')
  );
}

function isParentTransientReplayEvent(event) {
  return isTransientReplayEventForOwner(event, 'parent');
}

function pruneSettledSubagentReplay(store) {
  const running = new Set();
  for (const { event } of store.entries.values()) {
    if (event.type !== 'subagent_lifecycle' && event.type !== 'subagent_progress') continue;
    if (event.status === 'started' || event.status === 'running' || event.status === 'working') running.add(event.id);
  }
  deleteReplayEntries(store, event => {
    const childId = event.subagentId || ((event.type === 'subagent_lifecycle' || event.type === 'subagent_progress') ? event.id : null);
    return childId && !running.has(childId);
  });
}

function rememberOmpBridgeEvent(sessionId, event) {
  const store = replayStoreFor(sessionId);
  if (event.type === 'assistant_cancel' && event.willContinue) {
    const owner = replayOwner(event);
    deleteReplayEntries(store, candidate => isTransientReplayEventForOwner(candidate, owner));
    return;
  }
  if (event.type === 'tool_approval_resolved') {
    const existing = store.entries.get(`approval:${event.toolCallId}`);
    if (existing) {
      store.entries.delete(`approval:${event.toolCallId}`);
      store.bytes -= existing.bytes;
    }
    return;
  }

  if (event.type === 'agent_start' && !event.subagentId) {
    deleteReplayEntries(store, candidate => isParentTransientReplayEvent(candidate)
      || (!candidate.subagentId && (candidate.type === 'assistant_end' || candidate.type === 'assistant_cancel')));
    pruneSettledSubagentReplay(store);
  }

  const parentTerminal = !event.subagentId
    && (event.type === 'assistant_end' || event.type === 'assistant_cancel')
    && !event.willContinue;
  if (parentTerminal) {
    deleteReplayEntries(store, isParentTransientReplayEvent);
  } else if (isParentTransientReplayEvent(event)) {
    const terminal = store.entries.get('terminal:parent');
    if (terminal) {
      store.entries.delete('terminal:parent');
      store.bytes -= terminal.bytes;
    }
  }

  const key = replayKey(event);
  if (!key) return;
  const previous = store.entries.get(key);
  const mergePrevious = event.type.startsWith('tool_execution_')
    || event.type === 'subagent_lifecycle'
    || event.type === 'subagent_progress';
  const replayEvent = previous && mergePrevious
    ? { ...previous.event, ...event, type: event.type }
    : event;
  const bytes = Buffer.byteLength(JSON.stringify(replayEvent));
  if (bytes > OMP_REPLAY_MAX_BYTES) return;
  if (previous) store.bytes -= previous.bytes;
  const updatedSequence = ++ompBridgeReplaySequence;
  store.entries.set(key, {
    event: replayEvent,
    bytes,
    sequence: previous?.sequence ?? updatedSequence,
    updatedSequence,
  });
  store.bytes += bytes;

  while (store.entries.size > OMP_REPLAY_MAX_EVENTS || store.bytes > OMP_REPLAY_MAX_BYTES) {
    let oldestKey;
    let oldestUpdatedSequence = Infinity;
    for (const [candidateKey, entry] of store.entries) {
      if (entry.updatedSequence < oldestUpdatedSequence) {
        oldestKey = candidateKey;
        oldestUpdatedSequence = entry.updatedSequence;
      }
    }
    if (!oldestKey) break;
    const oldest = store.entries.get(oldestKey);
    store.entries.delete(oldestKey);
    store.bytes -= oldest.bytes;
  }
}

function replayOmpBridgeEvents(sessionId, clients, res) {
  const store = ompBridgeReplay.get(sessionId);
  if (!store) return;
  store.touchedAt = Date.now();
  const entries = [...store.entries.values()].sort((left, right) => left.sequence - right.sequence);
  for (const { event } of entries) {
    const chunk = `event: omp_event\ndata: ${JSON.stringify(event)}\n\n`;
    if (!writeSse(sessionId, clients, res, chunk)) break;
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

const pendingOmpBridgeMigrations = new Map();

function ompBridgeIsLive(sessionId, now = Date.now()) {
  const live = ompBridgeLastSeen.get(sessionId);
  return Number.isFinite(live?.seenAt) && live.version >= OMP_BRIDGE_VERSION && now - live.seenAt < 30_000;
}

function cancelOmpBridgeMigration(sessionId) {
  const timer = pendingOmpBridgeMigrations.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingOmpBridgeMigrations.delete(sessionId);
}

function observeOmpTurnBoundary(sessionId, line) {
  const boundary = ompTurnBoundaryFromLine(line);
  if (!boundary) return;
  if (boundary === 'active') {
    cancelOmpBridgeMigration(sessionId);
    return;
  }
  if (getAgentForSession(sessionId) !== 'omp') return;
  if (ompBridgeIsLive(sessionId) || !tmuxIsActive(sessionId) || pendingOmpBridgeMigrations.has(sessionId)) return;
  const timer = setTimeout(() => {
    pendingOmpBridgeMigrations.delete(sessionId);
    if (ompBridgeIsLive(sessionId) || !tmuxIsActive(sessionId) || getAgentForSession(sessionId) !== 'omp') return;
    try {
      launchOmpSession(sessionId, getOmpSessionCwd(sessionId), { resume: true });
      console.log(`[omp bridge] migrated completed session ${sessionId}`);
    } catch (error) {
      console.warn(`[omp bridge] migration failed for ${sessionId}:`, error.message);
    }
  }, 1500);
  timer.unref();
  pendingOmpBridgeMigrations.set(sessionId, timer);
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
      observeOmpTurnBoundary(sessionId, line);
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
  const meta = readMeta();
  for (const { uuid, fpath } of recent) {
    try {
      const sessionId = resolveCodexWatchId(uuid, meta);
      fileOffsets.set(sessionId, fs.statSync(fpath).size);
      watchCodexFile(fpath, sessionId);
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

const UPLOADS_DIR = STATE_PATHS.instance.uploadsDir;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const app = express();

// This is deliberately an allowlist rather than a method-only check. It keeps
// future GET handlers with side effects closed until they are explicitly
// classified, while leaving static assets and existing non-API read surfaces
// available for production-shaped canary inspection.
const READ_ONLY_API_ROUTES = [
  /^\/api\/health$/,
  /^\/api\/boxes$/,
  /^\/api\/sessions$/,
  SESSION_READ_ROUTE,
  SESSION_ROOM_ROUTE,
  /^\/api\/sidecar$/,
  /^\/api\/sidecar\/[^/]+$/,
  /^\/api\/sidecar\/[^/]+\/stream$/,
  /^\/api\/share\/sessions$/,
  /^\/api\/share\/sessions\/[^/]+\/(messages|stream|export)$/,
  /^\/api\/sharing\/peers$/,
  /^\/api\/projects$/,
  /^\/api\/quick-links$/,
  /^\/api\/starred$/,
  /^\/api\/file$/,
  /^\/api\/files$/,
  /^\/api\/agents$/,
  /^\/api\/rooms$/,
  /^\/api\/rooms\/[^/]+\/(updates|friction|wiki|wiki\/page|residents)$/,
];

function readOnlyRequestAllowed(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!req.path.startsWith('/api')) return true;
  return READ_ONLY_API_ROUTES.some(pattern => pattern.test(req.path));
}

app.use((req, res, next) => {
  if (!READ_ONLY_MODE || readOnlyRequestAllowed(req)) return next();
  res.setHeader('Cache-Control', 'no-store');
  return res.status(403).json(READ_ONLY_ERROR);
});

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
app.use(express.json({ limit: '512kb' }));
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

function bridgeTokenValid(sessionId, value) {
  if (typeof value !== 'string') return false;
  let expected = ompBridgeTokens.get(sessionId);
  if (!expected) {
    try {
      expected = fs.readFileSync(ompBridgeTokenPath(sessionId), 'utf8').trim();
      if (expected) ompBridgeTokens.set(sessionId, expected);
    } catch {
      return false;
    }
  }
  if (!expected) return false;
  const givenHash = createHash('sha256').update(value).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(givenHash, expectedHash);
}

function bridgeString(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function bridgeNumber(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

const INVALID_BRIDGE_JSON = Symbol('invalid-bridge-json');

function revalidateBridgeJson(value) {
  const state = { nodes: 0, bytes: 0 };

  function visit(candidate, depth) {
    if (state.nodes >= OMP_BRIDGE_JSON_LIMITS.maxNodes) return INVALID_BRIDGE_JSON;
    state.nodes += 1;
    state.bytes += 8;
    if (state.bytes > OMP_BRIDGE_JSON_LIMITS.maxTotalBytes) return INVALID_BRIDGE_JSON;

    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : INVALID_BRIDGE_JSON;
    if (typeof candidate === 'string') {
      const bytes = Buffer.byteLength(candidate);
      if (bytes > OMP_BRIDGE_JSON_LIMITS.maxStringBytes || state.bytes + bytes > OMP_BRIDGE_JSON_LIMITS.maxTotalBytes) {
        return INVALID_BRIDGE_JSON;
      }
      state.bytes += bytes;
      return candidate;
    }
    if (!candidate || typeof candidate !== 'object' || depth >= OMP_BRIDGE_JSON_LIMITS.maxDepth) {
      return INVALID_BRIDGE_JSON;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > OMP_BRIDGE_JSON_LIMITS.maxArrayItems) return INVALID_BRIDGE_JSON;
      const clean = [];
      for (const item of candidate) {
        const value = visit(item, depth + 1);
        if (value === INVALID_BRIDGE_JSON) return INVALID_BRIDGE_JSON;
        clean.push(value);
      }
      return clean;
    }

    const entries = Object.entries(candidate);
    if (entries.length > OMP_BRIDGE_JSON_LIMITS.maxObjectKeys) return INVALID_BRIDGE_JSON;
    const clean = Object.create(null);
    for (const [key, item] of entries) {
      const keyBytes = Buffer.byteLength(key);
      if (!key || keyBytes > OMP_BRIDGE_JSON_LIMITS.maxKeyBytes || state.bytes + keyBytes > OMP_BRIDGE_JSON_LIMITS.maxTotalBytes) {
        return INVALID_BRIDGE_JSON;
      }
      state.bytes += keyBytes;
      const value = visit(item, depth + 1);
      if (value === INVALID_BRIDGE_JSON) return INVALID_BRIDGE_JSON;
      clean[key] = value;
    }
    return clean;
  }

  const clean = visit(value, 0);
  return clean === INVALID_BRIDGE_JSON ? null : { value: clean };
}

function bridgeSubagentId(event) {
  if (event.subagentId === undefined) return {};
  const subagentId = bridgeString(event.subagentId, 128);
  return subagentId ? { subagentId } : null;
}

function normalizeTodoEvent(event) {
  const owner = bridgeSubagentId(event);
  if (owner === null) return null;
  if (!Array.isArray(event.phases) || event.phases.length > 30) return null;
  const allowedStatuses = new Set(['pending', 'in_progress', 'completed', 'abandoned', 'blocked']);
  const phases = [];
  for (const phase of event.phases) {
    const name = bridgeString(phase?.name, 120);
    if (!name || !Array.isArray(phase.tasks) || phase.tasks.length > 200) return null;
    const tasks = [];
    for (const task of phase.tasks) {
      const content = bridgeString(task?.content, 500);
      if (!content || !allowedStatuses.has(task.status)) return null;
      tasks.push({
        content,
        status: task.status,
        ...(bridgeString(task.blocker, 300) !== undefined ? { blocker: task.blocker } : {}),
      });
    }
    phases.push({ name, tasks });
  }
  return {
    type: 'todo',
    phases,
    ...(bridgeString(event.op, 20) !== undefined ? { op: event.op } : {}),
    isError: !!event.isError,
    ...owner,
  };
}

function normalizeAsyncJob(job) {
  const id = bridgeString(job?.id, 120);
  const type = bridgeString(job?.type, 20);
  const status = bridgeString(job?.status, 20);
  const startTime = bridgeNumber(job?.startTime, 0);
  if (!id || !type || !status || startTime === undefined) return null;
  return {
    id,
    type,
    status,
    startTime,
    ...(type === 'task' && bridgeString(job.label, 160) !== undefined ? { label: job.label } : {}),
  };
}

function normalizeOmpBridgeEvent(event) {
  if (!event || typeof event !== 'object' || !OMP_BRIDGE_EVENT_TYPES[event.type]) return null;
  const type = event.type;
  const owner = bridgeSubagentId(event);
  if (owner === null) return null;
  if (type === 'assistant_snapshot') {
    const messageId = bridgeString(event.messageId, 128);
    const text = bridgeString(event.text, 100_000);
    return messageId && text !== undefined ? { type, messageId, text, ...owner } : null;
  }
  if (type === 'work_snapshot') {
    const messageId = bridgeString(event.messageId, 128);
    if (!messageId || !Array.isArray(event.blocks) || event.blocks.length > 40) return null;
    let thinkingChars = 0;
    const blocks = [];
    for (const block of event.blocks) {
      if (block?.type === 'thinking') {
        const thinking = bridgeString(block.thinking, OMP_WORK_THINKING_CHARS);
        if (thinking === undefined || thinkingChars + thinking.length > OMP_WORK_THINKING_CHARS) return null;
        thinkingChars += thinking.length;
        blocks.push({ type: 'thinking', thinking });
      } else if (block?.type === 'tool_use') {
        const name = bridgeString(block.name, 80);
        if (!name) return null;
        blocks.push({
          type: 'tool_use',
          ...(bridgeString(block.id, 128) !== undefined ? { id: block.id } : {}),
          name,
          ...(bridgeString(block.intent, 300) !== undefined ? { intent: block.intent } : {}),
        });
      } else {
        return null;
      }
    }
    return { type, messageId, blocks, ...owner };
  }
  if (type === 'assistant_end' || type === 'assistant_cancel') {
    const messageId = bridgeString(event.messageId, 128);
    return messageId ? { type, messageId, ...(event.willContinue === true ? { willContinue: true } : {}), ...owner } : null;
  }
  if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
    const toolCallId = bridgeString(event.toolCallId, 128);
    const toolName = bridgeString(event.toolName, 80);
    if (!toolCallId || !toolName) return null;
    const hasArgs = type !== 'tool_execution_end' && event.args !== undefined;
    const hasPartialResult = type === 'tool_execution_update' && event.partialResult !== undefined;
    const hasResult = type === 'tool_execution_end' && event.result !== undefined;
    const args = hasArgs ? revalidateBridgeJson(event.args) : {};
    const partialResult = hasPartialResult ? revalidateBridgeJson(event.partialResult) : {};
    const result = hasResult ? revalidateBridgeJson(event.result) : {};
    if (args === null || partialResult === null || result === null) return null;
    return {
      type,
      toolCallId,
      toolName,
      ...(hasArgs ? { args: args.value } : {}),
      ...(bridgeString(event.intent, 300) !== undefined ? { intent: event.intent } : {}),
      ...(hasPartialResult ? { partialResult: partialResult.value } : {}),
      ...(hasResult ? { result: result.value } : {}),
      ...(type === 'tool_execution_end' && typeof event.isError === 'boolean' ? { isError: event.isError } : {}),
      ...owner,
    };
  }
  if (type === 'agent_start') return { type };
  if (type === 'agent_end') {
    return { type, ...(typeof event.willContinue === 'boolean' ? { willContinue: event.willContinue } : {}) };
  }
  if (type === 'auto_retry_start') {
    if (!Number.isSafeInteger(event.attempt) || !Number.isSafeInteger(event.maxAttempts) || !Number.isSafeInteger(event.delayMs)) return null;
    return {
      type,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      ...(bridgeString(event.errorMessage, 500) !== undefined ? { errorMessage: event.errorMessage } : {}),
    };
  }
  if (type === 'auto_retry_end') {
    if (typeof event.success !== 'boolean' || !Number.isSafeInteger(event.attempt)) return null;
    return {
      type,
      success: event.success,
      attempt: event.attempt,
      ...(bridgeString(event.finalError, 500) !== undefined ? { finalError: event.finalError } : {}),
    };
  }
  if (type === 'auto_compaction_start') {
    const reason = bridgeString(event.reason, 32);
    const action = bridgeString(event.action, 32);
    return reason && action ? { type, reason, action } : null;
  }
  if (type === 'auto_compaction_end') {
    const action = bridgeString(event.action, 32);
    if (!action || typeof event.aborted !== 'boolean' || typeof event.willRetry !== 'boolean') return null;
    return {
      type,
      action,
      aborted: event.aborted,
      willRetry: event.willRetry,
      ...(typeof event.skipped === 'boolean' ? { skipped: event.skipped } : {}),
      ...(bridgeString(event.errorMessage, 500) !== undefined ? { errorMessage: event.errorMessage } : {}),
    };
  }
  if (type === 'credential_disabled') {
    const provider = bridgeString(event.provider, 80);
    return provider ? { type, provider } : null;
  }
  if (type === 'todo') return normalizeTodoEvent(event);
  if (type === 'tool_approval_requested') {
    const toolCallId = bridgeString(event.toolCallId, 128);
    const toolName = bridgeString(event.toolName, 80);
    const approvalMode = bridgeString(event.approvalMode, 40);
    if (!toolCallId || !toolName || !approvalMode) return null;
    return {
      type,
      toolCallId,
      toolName,
      approvalMode,
      ...(bridgeString(event.reason, 500) !== undefined ? { reason: event.reason } : {}),
    };
  }
  if (type === 'tool_approval_resolved') {
    const toolCallId = bridgeString(event.toolCallId, 128);
    const toolName = bridgeString(event.toolName, 80);
    if (!toolCallId || !toolName || typeof event.approved !== 'boolean') return null;
    return {
      type,
      toolCallId,
      toolName,
      approved: event.approved,
      ...(bridgeString(event.reason, 500) !== undefined ? { reason: event.reason } : {}),
    };
  }
  if (type === 'subagent_lifecycle' || type === 'subagent_progress') {
    const id = bridgeString(event.id, 128);
    const agent = bridgeString(event.agent, 80);
    const status = bridgeString(event.status, 20);
    const index = bridgeNumber(event.index, 0, 1000);
    if (!id || !agent || !status || index === undefined) return null;
    return {
      type,
      id,
      agent,
      status,
      index,
      detached: !!event.detached,
      ...(bridgeString(event.agentSource, 20) !== undefined ? { agentSource: event.agentSource } : {}),
      ...(bridgeString(event.task, 2_000) !== undefined ? { task: event.task } : {}),
      ...(bridgeString(event.assignment, 1_000) !== undefined ? { assignment: event.assignment } : {}),
      ...(bridgeString(event.sessionFile, 1_000) !== undefined ? { sessionFile: event.sessionFile } : {}),
      ...(bridgeString(event.parentToolCallId, 128) !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
      ...(bridgeString(event.description, 300) !== undefined ? { description: event.description } : {}),
      ...(bridgeString(event.intent, 300) !== undefined ? { intent: event.intent } : {}),
      ...(bridgeString(event.resolvedModel, 160) !== undefined ? { resolvedModel: event.resolvedModel } : {}),
      ...(bridgeNumber(event.toolCount) !== undefined ? { toolCount: event.toolCount } : {}),
      ...(bridgeNumber(event.requests) !== undefined ? { requests: event.requests } : {}),
      ...(bridgeNumber(event.tokens) !== undefined ? { tokens: event.tokens } : {}),
      ...(bridgeNumber(event.durationMs) !== undefined ? { durationMs: event.durationMs } : {}),
      ...(bridgeNumber(event.contextTokens) !== undefined ? { contextTokens: event.contextTokens } : {}),
      ...(bridgeNumber(event.contextWindow) !== undefined ? { contextWindow: event.contextWindow } : {}),
    };
  }
  if (type === 'async_jobs') {
    if (!Array.isArray(event.running) || !Array.isArray(event.recent) || event.running.length > 30 || event.recent.length > 20) return null;
    const running = event.running.map(normalizeAsyncJob);
    const recent = event.recent.map(normalizeAsyncJob);
    if (running.some(job => job === null) || recent.some(job => job === null)) return null;
    return {
      type,
      running,
      recent,
      delivery: {
        queued: bridgeNumber(event.delivery?.queued, 0, 1000) || 0,
        delivering: !!event.delivery?.delivering,
      },
    };
  }
  if (type === 'session_state') {
    const serviceTiers = {};
    if (event.serviceTiers && typeof event.serviceTiers === 'object' && !Array.isArray(event.serviceTiers)) {
      for (const [family, tier] of Object.entries(event.serviceTiers).slice(0, 20)) {
        if (bridgeString(family, 40) && (tier === null || bridgeString(tier, 40) !== undefined)) serviceTiers[family] = tier;
      }
    }
    return {
      type,
      ...(bridgeString(event.modelProvider, 80) !== undefined ? { modelProvider: event.modelProvider } : {}),
      ...(bridgeString(event.modelId, 160) !== undefined ? { modelId: event.modelId } : {}),
      ...(bridgeString(event.modelApi, 80) !== undefined ? { modelApi: event.modelApi } : {}),
      ...(bridgeString(event.thinkingLevel, 40) !== undefined ? { thinkingLevel: event.thinkingLevel } : {}),
      serviceTiers,
      ...(bridgeNumber(event.contextTokens) !== undefined ? { contextTokens: event.contextTokens } : {}),
      ...(bridgeNumber(event.contextWindow) !== undefined ? { contextWindow: event.contextWindow } : {}),
      ...(bridgeNumber(event.contextPercent, 0, 100) !== undefined ? { contextPercent: event.contextPercent } : {}),
    };
  }
  return null;
}

app.post('/api/internal/sessions/:id/events', async (req, res) => {
  const { id } = req.params;
  if (!bridgeTokenValid(id, req.get('X-Feather-Bridge-Token'))) {
    return res.status(403).json({ error: 'invalid bridge token' });
  }
  const events = req.body?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > 50) {
    return res.status(400).json({ error: 'events must be a non-empty array (max 50)' });
  }
  const normalized = events.map(normalizeOmpBridgeEvent);
  if (normalized.some(event => event === null || Buffer.byteLength(JSON.stringify(event)) > OMP_BRIDGE_MAX_EVENT_BYTES)) {
    return res.status(400).json({ error: 'invalid bridge event' });
  }
  const terminalOwners = new Set();
  for (const event of events) {
    const isParentTerminal = !event?.subagentId && (
      ((event?.type === 'assistant_end' || event?.type === 'assistant_cancel') && !event.willContinue) ||
      (event?.type === 'agent_end' && !event.willContinue)
    );
    if (isParentTerminal && typeof event.ownerExecutionId === 'string') terminalOwners.add(event.ownerExecutionId);
  }
  const bridgeVersion = Number.isSafeInteger(req.body?.version) ? req.body.version : 0;
  ompBridgeLastSeen.set(id, { seenAt: Date.now(), version: bridgeVersion });
  for (const event of normalized) {
    rememberOmpBridgeEvent(id, event);
    broadcastNamedEvent(id, 'omp_event', event);
  }
  try {
    for (const ownerExecutionId of terminalOwners) {
      await bindUnclaimedProtocolOwner(id, ownerExecutionId);
      await protocolRuns.ownerTerminated(id, ownerExecutionId);
    }
    res.status(204).end();
  } catch (error) {
    res.status(protocolErrorStatus(error)).json({ error: error.message, code: error.code });
  }
});

function protocolErrorStatus(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
}

function protocolBridgeRequestAllowed(req, allowedKeys) {
  if (!bridgeTokenValid(req.params.id, req.get('X-Feather-Bridge-Token'))) return { status: 403, error: 'invalid bridge token' };
  if (req.get('X-Feather-Subagent-ID') || req.body?.subagentId) return { status: 403, error: 'protocol tools are parent-only' };
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return { status: 400, error: 'request body must be an object' };
  if (Buffer.byteLength(JSON.stringify(req.body)) > 128_000) return { status: 413, error: 'protocol request body exceeds 128000 bytes' };
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(req.body).find(key => !allowed.has(key));
  if (unknown) return { status: 400, error: `request body contains unknown field ${unknown}` };
  return null;
}

app.post('/api/internal/sessions/:id/protocol-runs/claim', async (req, res) => {
  const denied = protocolBridgeRequestAllowed(req, ['ownerExecutionId', 'invocationMessageId', 'mode', 'input']);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  try {
    const envelope = await protocolRuns.claim(req.params.id, req.body);
    res.json({ envelope });
  } catch (error) {
    res.status(protocolErrorStatus(error)).json({ error: error.message, code: error.code });
  }
});

app.post('/api/internal/sessions/:id/protocol-runs/:runId/events', async (req, res) => {
  const denied = protocolBridgeRequestAllowed(req, ['ownerExecutionId', 'event']);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  if (req.body?.event?.runId !== req.params.runId) return res.status(409).json({ error: 'event runId does not match route runId' });
  try {
    const result = await protocolRuns.appendEvent(req.params.id, req.body.ownerExecutionId, req.body.event);
    res.json({ ok: true, seq: result.seq, duplicate: result.duplicate });
  } catch (error) {
    res.status(protocolErrorStatus(error)).json({ error: error.message, code: error.code });
  }
});

// ── Box proxy middleware for session routes ──────────────────────────────────

app.use('/api/sessions', (req, res, next) => {
  const box = req.query.box;
  if (box && box !== 'local') return proxyToBox(box, req, res);
  next();
});

app.get('/api/sessions', (req, res) => {
  try { res.json({ sessions: discoverSessions(parseInt(req.query.limit) || 50, (req.query.q || '').trim() || null) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/sessions/:id/protocol-runs', (req, res) => {
  try {
    const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    res.json({ runs: protocolRuns.list(req.params.id, requestedLimit) });
  } catch (error) {
    res.status(protocolErrorStatus(error)).json({ error: error.message, code: error.code });
  }
});


app.get('/api/sessions/:id/messages', (req, res) => {
  const { messages, hasMore } = getMessages(req.params.id, parseInt(req.query.limit) || 100, parseInt(req.query.before) || 0);
  res.json({ messages, hasMore });
});

function sessionStreamHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const sid = req.params.id;
  if (!sseClients.has(sid)) sseClients.set(sid, new Set());
  const clients = sseClients.get(sid);
  clients.add(res);
  if (req.peer?.id) ssePeerAuth.set(res, { peerId: req.peer.id, revision: sharingRevision });
  writeSse(sid, clients, res, 'event: connected\ndata: {}\n\n');

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

  replayOmpBridgeEvents(sid, clients, res);
  replayProtocolRuns(sid, clients, res);
  const hb = setInterval(() => {
    if (!writeSse(sid, sseClients.get(sid) || new Set(), res, 'event: heartbeat\ndata: {}\n\n', true)) clearInterval(hb);
  }, 15000);
  // fs.watch can coalesce a burst and leave the final append unread until the
  // next write. Reconcile active streams cheaply so live work never stalls.
  const streamPath = findJsonlPath(sid);
  const reconcile = streamPath ? setInterval(() => processFileChange(streamPath, sid), 1000) : null;
  res.on('close', () => {
    clearInterval(hb);
    clearInterval(reconcile);
    sseClients.get(sid)?.delete(res);
    ssePeerAuth.delete(res);
  });
}

app.get('/api/sessions/:id/stream', sessionStreamHandler);

app.post('/api/sessions', (req, res) => {
  const agent = req.body.agent || 'claude';
  const roomRole = req.body.roomRole || null;
  const roomName = String(req.body.roomName || '').trim();
  let assignmentsBefore = null;
  let leadersBefore = null;
  try {
    const id = validateFreshSessionId(req.body.id);
    if (roomRole && roomRole !== 'leader') throw httpError(400, 'unsupported Room role');
    if (roomRole === 'leader') {
      if (agent !== 'omp') throw httpError(409, 'new Room Leaders currently require OMP');
      if (!listRoomDirs().includes(roomName)) throw httpError(404, 'no such room');
      if (path.resolve(String(req.body.cwd || '')) !== path.join(ROOMS_HOME_DIR, roomName)) {
        throw httpError(409, `leader cwd must be #${roomName}`);
      }
      assignmentsBefore = readRoomAssignments();
      leadersBefore = ROOM_LEADERS_STATE.read();
      const existingLeaderId = leadersBefore[roomName] || null;
      if (existingLeaderId && validRoomLeaderDesignation(roomName, existingLeaderId)) {
        syncRoomSidecar(roomName);
        return res.json({ id: existingLeaderId, status: 'existing', agent: getAgentForSession(existingLeaderId), roomRole });
      }
      const staleLeaderId = existingLeaderId && !validRoomLeaderDesignation(roomName, existingLeaderId)
        ? existingLeaderId
        : null;
      appointRoomLeader(roomName, id, { assign: true, replaceStale: staleLeaderId });
    }
    spawnSession(id, req.body.cwd, agent, { ompModel: req.body.model || '' });
    if (roomRole === 'leader') {
      syncRoomSidecar(roomName);
      roomSnapshotCache.invalidate();
    }
    res.json({ id, status: 'starting', agent, roomRole });
  } catch (e) {
    if (assignmentsBefore && leadersBefore) {
      ROOM_ASSIGN_STATE.update(() => assignmentsBefore);
      ROOM_LEADERS_STATE.update(() => leadersBefore);
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/sessions/:id/send', async (req, res) => {
  try {
    const messageId = req.get('X-Feather-Message-ID');
    if (messageId !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(messageId)) {
      return res.status(400).json({ error: 'invalid message id' });
    }
    if (!messageId) {
      await sendInput(req.params.id, req.body.text);
      return res.json({ ok: true, sentAt: new Date().toISOString() });
    }
    return res.json(await sendInputIdempotent(req.params.id, req.body.text, messageId));
  } catch (e) { res.status(protocolErrorStatus(e)).json({ error: e.message }); }
});
const TERMINAL_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Space', 'Tab']);

function validatedTerminalKeys(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(key => TERMINAL_KEYS.has(key))
    ? value
    : null;
}

function sendTerminalKeys(sessionId, keys) {
  execFileSync('tmux', ['send-keys', '-t', tmuxName(sessionId), ...keys], { stdio: 'ignore' });
}

app.post('/api/sessions/:id/keys', (req, res) => {
  const keys = validatedTerminalKeys(req.body?.keys);
  if (!keys) return res.status(400).json({ error: 'invalid terminal keys' });
  try {
    sendTerminalKeys(req.params.id, keys);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/sessions/:id/resume', (req, res) => {
  try { resumeSession(req.params.id, req.body?.cwd); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/interrupt', (req, res) => {
  try { execFileSync('tmux', ['send-keys', '-t', tmuxName(req.params.id), 'C-c'], { stdio: 'ignore' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/delete', async (req, res) => {
  try {
    const id = req.params.id;
    const agent = getAgentForSession(id);
    await protocolRuns.deleteSession(id);
    try { execFileSync('tmux', ['kill-session', '-t', tmuxName(id)], { stdio: 'ignore' }); } catch {}
    if (agent === 'omp') {
      const dir = path.join(OMP_SESSIONS, id);
      ompBridgeTokens.delete(id);
      try { fs.unlinkSync(ompBridgeTokenPath(id)); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    } else {
      const fpath = findJsonlPath(id, agent);
      if (fpath) fs.unlinkSync(fpath);
    }
    updateMeta((meta) => {
      const next = { ...meta };
      delete next[id];
      return next;
    });
    MESSAGE_RECEIPTS_STATE.update((receipts) => {
      if (!(id in receipts)) return receipts;
      const next = { ...receipts };
      delete next[id];
      return next;
    });
    resetOmpBridgeSessionState(id);
    fileOffsets.delete(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/rename', (req, res) => {
  try {
    updateMeta((meta) => ({
      ...meta,
      [req.params.id]: { ...(meta[req.params.id] || {}), title: req.body.title },
    }));
    roomSnapshotCache.invalidate();
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
      if (!ompId) throw new Error(`Cannot fork OMP session ${req.params.id}: exact OMP session id not found`);
      launchInTmux(forkName, `bash --rcfile ~/.bashrc -ic 'omp ${ompModelFlags(ompSessionModel(req.params.id), OMP_THINKING)}--resume ${ompId} --session-dir ${sessionDir} --allow-home'`, req.body?.cwd);
    } else {
      ensureClaudeTrust(req.body?.cwd);
      launchInTmux(forkName, `bash --rcfile ~/.bashrc -ic 'claude --resume ${req.params.id} --fork-session --dangerously-skip-permissions --disallowed-tools AskUserQuestion'`, req.body?.cwd);
    }
    res.json({ ok: true, tmux: forkName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sidecar API: paired agent threads with a chat channel ──────────────────
const SIDECAR_MESSAGE_MAX_CHARS = 16_000;

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

// Core broker: record the message, broadcast to the GUI, inject into the recipient.
// Garbage-collect a group whose driver (the non-spawned member) tmux is gone:
// tear it down and kill its orphaned spawned peers. Returns true if it GC'd.
function sidecarGcIfDriverGone(group) {
  if (READ_ONLY_MODE) return false;
  const driver = group.members.find(m => !m.spawned);
  if (!driver || tmuxIsActive(driver.sessionId)) return false;
  if (group.kind === 'room') return false;
  for (const m of group.members) {
    if (m.spawned) { try { execFileSync('tmux', ['kill-session', '-t', tmuxName(m.sessionId)], { stdio: 'ignore' }); } catch {} }
  }
  sidecar.teardownGroup(group.id);
  sidecarClients.delete(group.id);
  console.log(`[sidecar] GC'd group ${group.id} — driver gone`);
  return true;
}

function sidecarDeliver(group, fromRole, to, text) {
  const { targets, missing } = sidecar.resolveRecipients(group, to, fromRole);
  if (missing.length) return { error: `unknown recipient role(s): ${missing.join(', ')}` };
  if (!targets.length) return { error: `no recipients for "${to}"` };
  const msg = sidecar.appendMessage(group.id, { from: fromRole, to, text });
  sidecarBroadcast(group.id, msg);
  // Push into each recipient's tmux (locked sendInput); fire-and-forget so the
  // HTTP caller isn't blocked on the ~6s resume-if-dormant path. The per-session
  // lock serializes concurrent fan-in into any one session.
  for (const t of targets) {
    sendInput(t.sessionId, sidecar.formatInbound(group.id, msg))
      .catch(e => console.warn('[sidecar] route failed:', e.message));
  }
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

// Create a sidecar: spawn N peer sessions, register the group, prime each.
// Back-compat: with no `peers`, spawns a single `peer` (v1 shape).
app.post('/api/sidecar', (req, res) => {
  const b = req.body || {};
  const { driverSessionId, driverRole = 'driver', agent = 'claude', cwd, task = '' } = b;
  if (!driverSessionId) return res.status(400).json({ error: 'driverSessionId required' });
  const peerSpecs = (Array.isArray(b.peers) && b.peers.length)
    ? b.peers
    : [{ role: b.peerRole || 'peer', task, agent }];
  const peers = peerSpecs.map(p => ({ id: randomUUID(), role: p.role || 'peer', task: p.task || task || '', agent: p.agent || agent }));
  const members = [
    { sessionId: driverSessionId, role: driverRole, spawned: false },
    ...peers.map(p => ({ sessionId: p.id, role: p.role, spawned: true })),
  ];
  let group;
  try {
    group = sidecar.createGroup({ id: randomUUID(), members, agent, task });
  } catch (e) {
    return res.status(400).json({ error: e.message }); // role validation (duplicate/invalid)
  }
  const roster = members.map(m => m.role);
  // tmux is active immediately but the agent needs a few seconds to boot, so
  // delay each prime (sendInput's resume-wait only fires when inactive).
  for (const p of peers) {
    try { spawnSession(p.id, cwd, p.agent); } catch (e) { console.warn('[sidecar] spawn failed:', e.message); }
    const prime = sidecar.priming({ selfRole: p.role, roster, task: p.task });
    setTimeout(() => { sendInput(p.id, prime).catch(e => console.warn('[sidecar] prime failed:', e.message)); }, 7000);
  }
  res.json({ group, peers: peers.map(p => ({ role: p.role, sessionId: p.id })) });
});

// Post a message. Sender identified by tmux prefix (CLI) or explicit group+from (GUI).
app.post('/api/sidecar/post', (req, res) => {
  try {
    const { group: groupId, fromPrefix, from, to, text } = req.body || {};
    if (typeof to !== 'string' || !to || typeof text !== 'string' || !text) return res.status(400).json({ error: 'string to and text required' });
    if (text.length > SIDECAR_MESSAGE_MAX_CHARS) return res.status(413).json({ error: 'sidecar message exceeds 16000 characters' });
    const residentSessionId = String(req.get('X-Feather-Session-ID') || '');
    const lookupPrefix = residentSessionId ? residentSessionId.slice(0, 8) : fromPrefix;
    const group = groupId ? sidecar.getGroup(groupId)
      : (lookupPrefix ? sidecar.groupForSenderAndRole(lookupPrefix, to) : null);
    if (!group || group.status !== 'active') {
      return res.status(404).json({ error: 'no active sidecar group for sender (you may be in several — pass --group)' });
    }
    if (sidecarGcIfDriverGone(group)) return res.status(410).json({ error: 'driver gone; group torn down' });
    const inferredRole = lookupPrefix ? sidecar.roleForPrefix(group, lookupPrefix) : null;
    let authenticatedRoomRole = null;
    if (group.kind === 'room') {
      const member = group.members.find((candidate) => candidate.sessionId === residentSessionId);
      if (!member || !bridgeTokenValid(residentSessionId, req.get('X-Feather-Bridge-Token'))) {
        return res.status(403).json({ error: 'invalid Room resident capability' });
      }
      authenticatedRoomRole = member.role;
    }
    const fromRole = group.kind === 'room' ? authenticatedRoomRole : (from || inferredRole || 'unknown');
    const out = sidecarDeliver(group, fromRole, to, text);
    if (out.error) return res.status(400).json(out);
    res.json({ ok: true, group: group.id, seq: out.message.seq });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post addressed by explicit group id (used by the GUI).
app.post('/api/sidecar/:id/post', (req, res) => {
  try {
    const { from, to, text } = req.body || {};
    if (typeof to !== 'string' || !to || typeof text !== 'string' || !text) return res.status(400).json({ error: 'string to and text required' });
    if (text.length > SIDECAR_MESSAGE_MAX_CHARS) return res.status(413).json({ error: 'sidecar message exceeds 16000 characters' });
    const group = sidecar.getGroup(req.params.id);
    if (!group || group.status !== 'active') return res.status(404).json({ error: 'no active sidecar group' });
    if (group.kind === 'room') return res.status(403).json({ error: 'Human Room messages go through the Leader chat' });
    if (sidecarGcIfDriverGone(group)) return res.status(410).json({ error: 'driver gone; group torn down' });
    const out = sidecarDeliver(group, from || 'driver', to, text);
    if (out.error) return res.status(400).json(out);
    res.json({ ok: true, group: group.id, seq: out.message.seq });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a peer to an existing group (spawn + roster-aware prime).
app.post('/api/sidecar/:id/peers', (req, res) => {
  try {
    const g = sidecar.getGroup(req.params.id);
    if (!g || g.status !== 'active') return res.status(404).json({ error: 'no active group' });
    if (g.kind === 'room') return res.status(409).json({ error: 'Room group membership is managed by the resident registry' });
    const { role = 'peer', agent = g.agent || 'claude', cwd, task = '' } = req.body || {};
    const pid = randomUUID();
    sidecar.addMember(g.id, { sessionId: pid, role, spawned: true });
    spawnSession(pid, cwd, agent);
    const roster = sidecar.getGroup(g.id).members.map(m => m.role);
    setTimeout(() => { sendInput(pid, sidecar.priming({ selfRole: role, roster, task })).catch(e => console.warn('[sidecar] prime failed:', e.message)); }, 7000);
    res.json({ ok: true, role, sessionId: pid });
  } catch (e) { res.status(/role/.test(e.message) ? 400 : 500).json({ error: e.message }); }
});

// Remove one peer (kill its session) without tearing down the whole group.
app.post('/api/sidecar/:id/peers/:role/delete', (req, res) => {
  try {
    const g = sidecar.getGroup(req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (g.kind === 'room') return res.status(409).json({ error: 'Room group membership is managed by the resident registry' });
    const m = g.members.find(x => x.role === req.params.role);
    if (!m) return res.status(404).json({ error: `no member with role ${req.params.role}` });
    if (!m.spawned) return res.status(400).json({ error: 'not a removable peer (the driver is not spawned)' });
    try { execFileSync('tmux', ['kill-session', '-t', tmuxName(m.sessionId)], { stdio: 'ignore' }); } catch {}
    sidecar.removeMember(g.id, req.params.role);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sidecar/:id/delete', (req, res) => {
  try {
    const g = sidecar.getGroup(req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (g.kind === 'room') return res.status(409).json({ error: 'Room groups are durable' });
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
  if (!READ_ONLY_MODE) shareLog({ peer: peer.id, method: req.method, path: req.path, ...(typeof req.body?.text === 'string' ? { text: req.body.text } : {}) });
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
  try {
    const messageId = req.get('X-Feather-Message-ID');
    if (messageId !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(messageId)) {
      return res.status(400).json({ error: 'invalid message id' });
    }
    const prefixedText = `[${req.peer.id}] ${text}`;
    if (!messageId) {
      await sendInput(req.params.id, prefixedText);
      return res.json({ ok: true, sentAt: new Date().toISOString() });
    }
    return res.json(await sendInputIdempotent(req.params.id, prefixedText, messageId));
  } catch (e) { res.status(protocolErrorStatus(e)).json({ error: e.message }); }
});
app.post('/api/share/sessions/:id/keys', requireShareAccess, (req, res) => {
  if (!req.peer.control) return res.status(403).json({ error: 'view-only access' });
  const keys = validatedTerminalKeys(req.body?.keys);
  if (!keys) return res.status(400).json({ error: 'invalid terminal keys' });
  try {
    sendTerminalKeys(req.params.id, keys);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    updateMeta((meta) => ({
      ...meta,
      [req.params.id]: { ...(meta[req.params.id] || {}), share: peers },
    }));
    sharingRevision++;
    res.json({ ok: true, share: peers });
    evictRevokedSseClients(req.params.id);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function readBoundedBody(req, maxBytes, limitMessage) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, limitMessage);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

app.post('/api/upload', async (req, res) => {
  try {
    const filename = decodeURIComponent(req.headers['x-filename'] || 'file');
    const safe = filename.replace(/[^a-zA-Z0-9._\- ]/g, '').slice(0, 100);
    const requestedId = String(req.headers['x-upload-id'] || '');
    if (requestedId && !/^[a-zA-Z0-9_-]{8,80}$/.test(requestedId)) {
      return res.status(400).json({ error: 'invalid upload id' });
    }
    const uploadId = requestedId || randomUUID();
    const dest = `${uploadId}-${safe || 'upload'}`;
    const fpath = path.join(UPLOADS_DIR, dest);
    const declaredSize = Number(req.headers['content-length'] || 0);
    if (declaredSize > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'upload exceeds 50 MB limit' });
    const body = await readBoundedBody(req, MAX_UPLOAD_BYTES, 'upload exceeds 50 MB limit');
    const existingBody = () => {
      try {
        return fs.readFileSync(fpath);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    };
    const existing = existingBody();
    if (existing) {
      if (!existing.equals(body)) return res.status(409).json({ error: 'upload id already exists with different content' });
      return res.json({ path: fpath, reused: true });
    }
    const tmp = path.join(UPLOADS_DIR, `.${uploadId}-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 });
      fs.linkSync(tmp, fpath);
    } catch (e) {
      const racedBody = e.code === 'EEXIST' ? existingBody() : null;
      if (e.code !== 'EEXIST' || !racedBody?.equals(body)) {
        if (e.code === 'EEXIST') return res.status(409).json({ error: 'upload id already exists with different content' });
        throw e;
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    res.json({ path: fpath });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Project labels ──────────────────────────────────────────────────────────

const PROJECT_LABELS_FILE = STATE_PATHS.instance.projectLabelsFile;
const PROJECT_LABELS_STATE = createJsonState({
  file: PROJECT_LABELS_FILE, root: STATE_PATHS.instance.root, document: 'project labels',
  defaultValue: {}, validate: isJsonRecord,
});

function readProjectLabels() {
  return PROJECT_LABELS_STATE.read();
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
  PROJECT_LABELS_STATE.update((labels) => ({
    ...labels,
    [id]: req.body.label != null ? String(req.body.label) : null,
  }));
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  PROJECT_LABELS_STATE.update((labels) => {
    const next = { ...labels };
    delete next[req.params.id];
    return next;
  });
  res.json({ ok: true });
});

// ── Quick Links ─────────────────────────────────────────────────────────────

const LINKS_FILE = STATE_PATHS.instance.quickLinksFile;
const LINKS_STATE = createJsonState({
  file: LINKS_FILE, root: STATE_PATHS.instance.root, document: 'quick links',
  defaultValue: [], validate: Array.isArray,
});

function readLinks() {
  return LINKS_STATE.read();
}

app.get('/api/quick-links', (_req, res) => res.json(readLinks()));

app.post('/api/quick-links', (req, res) => {
  const links = req.body;
  if (!Array.isArray(links)) return res.status(400).json({ error: 'expected array' });
  LINKS_STATE.write(links);
  res.json({ ok: true });
});

// ── Starred messages ───────────────────────────────────────────────────────

const STARRED_FILE = STATE_PATHS.instance.starredFile;
const STARRED_STATE = createJsonState({
  file: STARRED_FILE, root: STATE_PATHS.instance.root, document: 'starred messages',
  defaultValue: {}, validate: isJsonRecord,
});

function readStarred() {
  return STARRED_STATE.read();
}

app.get('/api/starred', (_req, res) => res.json(readStarred()));

app.post('/api/starred', (req, res) => {
  try {
    STARRED_STATE.write(req.body);
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

// Accept ~ and ~/... paths (linkified messages often use the tilde form)
const expandTilde = (p) => p === '~' ? HOME : (p && p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);

app.get('/api/file', (req, res) => {
  const raw = typeof req.query.path === 'string' ? expandTilde(req.query.path) : null;
  if (!raw || !raw.startsWith('/') || raw.includes('\0')) return res.status(400).json({ error: 'invalid path' });
  // Normalize so ../ segments collapse before any fs access or sendFile.
  const fpath = path.resolve(raw);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'not found' });
  try {
    const stat = fs.statSync(fpath);
    if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });
    if (stat.size > 100 * 1024 * 1024) return res.status(413).json({ error: 'file too large' });
    res.sendFile(fpath, { dotfiles: 'allow' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files', (req, res) => {
  const dir = expandTilde(req.query.path) || HOME;
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
  const fpath = expandTilde(req.query.path);
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
    const fpath = expandTilde(req.body?.path);
    if (!fpath || !fpath.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
    execFileSync('code-server', [fpath], { stdio: 'ignore', timeout: 3000 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Idle session reaper (kill after 1 hour of inactivity) ──────────────────

// Idleness is measured from the last real user/assistant message, NOT the file
// mtime. Agents append bookkeeping while idle (heartbeats, status lines) which
// keeps mtime fresh forever, so an mtime-based reaper never fired and left
// tmux panes alive for days.
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
        const fpath = path.join(dirPath, file);
        // A newly resumed old transcript must get a full idle window. Without
        // considering the tmux creation time, the next five-minute sweep kills
        // it immediately because its last real message may be hours old.
        const activity = latestSessionActivityMs(
          lastActivityMs(fpath, 'claude', fs.statSync(fpath).mtimeMs),
          active.get(id.slice(0, 8)) || 0,
        );
        if (now - activity > IDLE_MS) {
          const name = tmuxName(id);
          try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
          console.log(`[reaper] killed idle session ${name} (inactive ${Math.round((now - activity) / 60000)}m)`);
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
      const fpath = path.join(dirPath, files[0]);
      const activity = latestSessionActivityMs(
        lastActivityMs(fpath, 'omp', fs.statSync(fpath).mtimeMs),
        active.get(dir.slice(0, 8)) || 0,
      );
      if (now - activity > IDLE_MS) {
        const name = tmuxName(dir);
        try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
        console.log(`[reaper] killed idle omp session ${name} (inactive ${Math.round((now - activity) / 60000)}m)`);
      }
    }
  } catch {}

  // Reap codex sessions
  try {
    for (const { uuid, fpath, mtime } of listCodexJsonlFiles()) {
      if (!active.has(uuid.slice(0, 8))) continue;
      const activity = latestSessionActivityMs(
        lastActivityMs(fpath, 'codex', mtime.getTime()),
        active.get(uuid.slice(0, 8)) || 0,
      );
      if (now - activity > IDLE_MS) {
        const name = tmuxName(uuid);
        try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
        console.log(`[reaper] killed idle codex session ${name} (inactive ${Math.round((now - activity) / 60000)}m)`);
      }
    }
  } catch {}
}

if (!READ_ONLY_MODE) setInterval(reapIdleSessions, 5 * 60 * 1000); // check every 5 minutes

app.get('/api/health', (_req, res) => res.json({
  status: 'ok', version: VERSION, uptime: process.uptime(),
  capabilities: {
    readOnly: READ_ONLY_MODE,
    mutations: !READ_ONLY_MODE,
    terminal: !READ_ONLY_MODE,
    shell: !READ_ONLY_MODE,
    backgroundControllers: !READ_ONLY_MODE,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxAudioBytes: MAX_AUDIO_BYTES,
  },
}));


// ── Agent discovery ─────────────────────────────────────────────────────────

function executableAvailable(command) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, command);
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

function discoverAgents() {
  const agents = [{ id: 'claude', label: 'Claude Code', available: true }];
  if (READ_ONLY_MODE) {
    // Read-only means no writes anywhere, including subprocess caches/logs.
    // OMP v18 writes audit logs and Bun cache entries even for `--version`, so
    // determine availability from PATH and omit version labels in canary mode.
    agents.push({ id: 'omp', label: 'oh-my-pi', available: executableAvailable('omp') });
    agents.push({ id: 'codex', label: 'Codex', available: executableAvailable('codex') });
    return agents;
  }
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
  return agents;
}

const AGENTS_SNAPSHOT = discoverAgents();
app.get('/api/agents', (_req, res) => res.json({ agents: AGENTS_SNAPSHOT }));

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ── Rooms v2 ───────────────────────────────────────────────────────────────
// A room is a folder under ~/rooms/ (AGENTS.md + notes.md) plus the sessions
// whose cwd is that folder. No registry: this scans the filesystem. Sessions
// created elsewhere can be pulled into a room via ~/.feather/room-sessions.json
// ({ sessionId: roomName }), written by the assign endpoint below.
// See docs/plans/2026-08-20-005-feat-rooms-v2-plan.md.

const ROOMS_HOME_DIR = STATE_PATHS.workspace.roomsDir;
const ROOM_ASSIGN_FILE = STATE_PATHS.coordination.roomAssignmentsFile;
const ROOM_LEADERS_FILE = STATE_PATHS.coordination.roomLeadersFile;
const ROOM_RESIDENTS_FILE = STATE_PATHS.coordination.roomResidentsFile;
const ROOM_PULSES_FILE = STATE_PATHS.coordination.roomPulsesFile;
const ROOM_ASSIGN_STATE = createJsonState({
  file: ROOM_ASSIGN_FILE, root: path.dirname(ROOM_ASSIGN_FILE), document: 'Room assignments',
  defaultValue: {}, validate: isJsonRecord,
});
const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isRoomLeaderState(value) {
  return isJsonRecord(value) && Object.entries(value).every(([name, sessionId]) =>
    ROOM_NAME_RE.test(name) && typeof sessionId === 'string' && UUID_RE.test(sessionId));
}
const ROOM_LEADERS_STATE = createJsonState({
  file: ROOM_LEADERS_FILE, root: path.dirname(ROOM_LEADERS_FILE), document: 'Room leaders',
  defaultValue: {}, validate: isRoomLeaderState,
});
const ROOM_RESIDENT_ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
function isRoomResidentState(value) {
  if (!isJsonRecord(value)) return false;
  const sessionIds = new Set();
  for (const [roomName, residents] of Object.entries(value)) {
    if (!ROOM_NAME_RE.test(roomName) || !isJsonRecord(residents)) return false;
    for (const [role, resident] of Object.entries(residents)) {
      if (role === 'leader' || !ROOM_RESIDENT_ROLE_RE.test(role) || !isJsonRecord(resident)) return false;
      if (typeof resident.sessionId !== 'string' || !UUID_RE.test(resident.sessionId)) return false;
      if (sessionIds.has(resident.sessionId)) return false;
      sessionIds.add(resident.sessionId);
    }
  }
  return true;
}
const ROOM_RESIDENTS_STATE = createJsonState({
  file: ROOM_RESIDENTS_FILE, root: path.dirname(ROOM_RESIDENTS_FILE), document: 'Room residents',
  defaultValue: {}, validate: isRoomResidentState,
});
const ROOM_PULSE_STATUSES = new Set(['waiting', 'working', 'paused', 'error']);
function isRoomPulseState(value) {
  if (!isJsonRecord(value)) return false;
  return Object.values(value).every((pulse) => {
    if (!isJsonRecord(pulse)) return false;
    if (typeof pulse.enabled !== 'boolean') return false;
    if (!ROOM_PULSE_STATUSES.has(pulse.status)) return false;
    if (pulse.lastRunAt !== null && (typeof pulse.lastRunAt !== 'string' || !Number.isFinite(Date.parse(pulse.lastRunAt)))) return false;
    if (pulse.sessionId !== null && (typeof pulse.sessionId !== 'string' || !UUID_RE.test(pulse.sessionId))) return false;
    if (pulse.error !== null && typeof pulse.error !== 'string') return false;
    return pulse.nextRunAtMs === null || (Number.isFinite(pulse.nextRunAtMs) && pulse.nextRunAtMs >= 0 && pulse.nextRunAtMs <= 8.64e15);
  });
}
const ROOM_PULSES_STATE = createJsonState({
  file: ROOM_PULSES_FILE, root: path.dirname(ROOM_PULSES_FILE), document: 'Room keep-working state',
  defaultValue: {}, validate: isRoomPulseState,
});

function pulseRecord(current, changes = {}) {
  return {
    enabled: true,
    status: 'waiting',
    lastRunAt: null,
    nextRunAtMs: null,
    sessionId: null,
    error: null,
    ...(isJsonRecord(current) ? current : {}),
    ...changes,
  };
}

function roomPulse(name, now = Date.now(), pulseState = ROOM_PULSES_STATE.read()) {
  const saved = pulseState[name];
  const enabled = saved?.enabled !== false;
  const nextRunAtMs = Number(saved?.nextRunAtMs) || (ROOM_PULSE_STARTED_AT + ROOM_PULSE_INTERVAL_MS);
  return {
    enabled,
    status: enabled ? (saved?.status || 'waiting') : 'paused',
    lastRunAt: saved?.lastRunAt || null,
    nextRunAt: enabled ? new Date(Math.max(now, nextRunAtMs)).toISOString() : null,
    sessionId: saved?.sessionId || null,
    error: saved?.error || null,
  };
}

function readRoomAssignments() {
  return ROOM_ASSIGN_STATE.read();
}

function validRoomLeaderDesignation(name, sessionId) {
  if (!UUID_RE.test(sessionId)) return false;
  if (ROOM_PULSES_STATE.read()[name]?.sessionId === sessionId) return false;
  const assignments = readRoomAssignments();
  const meta = readMeta();
  if (assignments[sessionId] === name
    && ['omp', 'claude'].includes(meta[sessionId]?.agent)
    && (tmuxIsActive(sessionId) || fs.existsSync(path.join(OMP_SESSIONS, sessionId)))) {
    return true;
  }
  const session = discoverSessions(0, null, [sessionId]).find((candidate) => candidate.id === sessionId);
  return !!session
    && session.agent !== 'codex'
    && roomNameForSession(sessionId) === name
    && !String(session.title || '').startsWith('Keep working: #');
}

function appointRoomLeader(name, sessionId, { assign = false, replaceStale = null } = {}) {
  if (assign) {
    ROOM_ASSIGN_STATE.update((current) => ({ ...current, [sessionId]: name }));
  }
  ROOM_LEADERS_STATE.update((current) => {
    if (current[name] && current[name] !== sessionId && current[name] !== replaceStale) {
      throw httpError(409, `#${name} already has a Leader`);
    }
    if (Object.entries(current).some(([roomName, currentLeaderId]) => roomName !== name && currentLeaderId === sessionId)) {
      throw httpError(409, 'session is already Leader of another Room');
    }
    return { ...current, [name]: sessionId };
  });
}

// Only canonical, non-symlinked folders with an AGENTS.md count as Rooms.
function listRoomDirs() {
  try {
    const realRoomsRoot = fs.realpathSync(ROOMS_HOME_DIR);
    return fs.readdirSync(ROOMS_HOME_DIR).filter((name) => {
      if (!ROOM_NAME_RE.test(name)) return false;
      try {
        const roomPath = path.join(ROOMS_HOME_DIR, name);
        const roomEntry = fs.lstatSync(roomPath);
        if (roomEntry.isSymbolicLink() || !roomEntry.isDirectory()) return false;
        if (path.dirname(fs.realpathSync(roomPath)) !== realRoomsRoot) return false;
        const agentsEntry = fs.lstatSync(path.join(roomPath, 'AGENTS.md'));
        return !agentsEntry.isSymbolicLink() && agentsEntry.isFile();
      } catch { return false; }
    }).sort();
  } catch { return []; }
}

function syncRoomSidecar(name, { primeNewResidents = false } = {}) {
  const leaderId = ROOM_LEADERS_STATE.read()[name] || null;
  if (!leaderId || !validRoomLeaderDesignation(name, leaderId)) return null;
  const configured = ROOM_RESIDENTS_STATE.read()[name] || {};
  const members = [
    { sessionId: leaderId, role: 'leader' },
    ...Object.entries(configured).map(([role, resident]) => ({ sessionId: resident.sessionId, role })),
  ];
  const id = sidecar.roomGroupId(name);
  const previous = sidecar.getGroup(id);
  const primedMembers = new Set(previous?.primedMembers || []);
  const group = sidecar.syncRoomGroup({ roomName: name, members });
  if (primeNewResidents) {
    for (const member of members) {
      const memberKey = `${member.role}:${member.sessionId}`;
      if (member.role === 'leader' || primedMembers.has(memberKey)) continue;
      const groupFlag = `--group ${id}`;
      const prime = [
        `You are the permanent ${member.role} resident of Room #${name}. Other residents: ${members.filter((candidate) => candidate.role !== member.role).map((candidate) => candidate.role).join(', ')}.`,
        `Explicit Sidecar messages are visible to the human. Contribute only your distinct expertise; no status chatter.`,
        `Post: sidecar post ${groupFlag} --to <role|all> \"...\"`,
        `Read: sidecar read ${groupFlag}`,
        `Wait: sidecar wait ${groupFlag} --from <role|all> --count <N>`,
        'Wait for a message and reply through this Room Sidecar group.',
      ].join('\n');
      sendInput(member.sessionId, prime)
        .then(() => sidecar.markMembersPrimed(id, [memberKey]))
        .catch((error) => console.warn(`[room sidecar] could not prime ${member.role} in #${name}:`, error.message));
    }
  }
  return group;
}

function syncAllRoomSidecars(options) {
  for (const name of listRoomDirs()) {
    try { syncRoomSidecar(name, options); }
    catch (error) { console.warn(`[room sidecar] #${name}:`, error.message); }
  }
}

// Last real user/assistant text in a session, read from the tail (growing
// like ACTIVITY_TAILS so idle bookkeeping lines can't hide it). Rooms-home
// snippet only — not a full parse.
function lastMessageSnippet(sessionId, agent) {
  const fpath = findJsonlPath(sessionId, agent);
  if (!fpath) return null;
  let fd;
  try {
    const size = fs.statSync(fpath).size;
    fd = fs.openSync(fpath, 'r');
    for (const tail of ACTIVITY_TAILS) {
      const start = Math.max(0, size - tail);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let lines = buf.toString('utf8').split('\n').filter(Boolean);
      if (start > 0) lines = lines.slice(1); // first line may be cut mid-record
      for (let i = lines.length - 1; i >= 0; i--) {
        let m;
        try { m = parseMessageForAgent(lines[i], agent); } catch { continue; }
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        const text = (m.content || [])
          .filter((b) => b && b.type === 'text' && b.text)
          .map((b) => b.text).join(' ')
          .replace(/\s+/g, ' ').trim();
        if (!text) continue;
        return { role: m.role, text: text.slice(0, 200) };
      }
      if (start === 0) break;
    }
  } catch {} finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// ── Room updates: legacy append-only evidence ───────────────────────────────
// Curated wiki pages replaced the user-facing Updates feed. updates.jsonl
// remains readable as caretaker evidence and for backward compatibility. Each
// entry is one JSON line {id, ts, text}, appended through an O_APPEND handle so
// concurrent writers (CLI + API) never interleave a partial line.
const ROOM_UPDATE_MAX_CHARS = 4000;
function roomUpdatesFile(name) { return path.join(ROOMS_HOME_DIR, name, 'updates.jsonl'); }

function readRoomUpdates(name) {
  let raw;
  try { raw = fs.readFileSync(roomUpdatesFile(name), 'utf8'); } catch { return []; }
  const updates = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.text === 'string') {
        updates.push({
          id: typeof entry.id === 'string' ? entry.id : null,
          ts: typeof entry.ts === 'string' ? entry.ts : null,
          text: entry.text,
        });
      }
    } catch {}
  }
  return updates; // file order == chronological, since we only ever append
}

// Compatibility summary retained in the rooms snapshot for older clients and
// external readers. Count and latest entry remain monotonic because the legacy
// evidence file is append-only.
function roomUpdatesSummary(name) {
  const updates = readRoomUpdates(name);
  const newest = updates[updates.length - 1] || null;
  return {
    count: updates.length,
    latestAt: newest?.ts || null,
    latest: newest ? newest.text.replace(/\s+/g, ' ').trim().slice(0, 180) : null,
  };
}

function appendRoomUpdate(name, text) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) throw httpError(400, 'update text is required');
  if (clean.length > ROOM_UPDATE_MAX_CHARS) throw httpError(413, `update exceeds ${ROOM_UPDATE_MAX_CHARS} characters`);
  const entry = { id: randomUUID(), ts: new Date().toISOString(), text: clean };
  fs.appendFileSync(roomUpdatesFile(name), JSON.stringify(entry) + '\n');
  return entry;
}

function readFrictionComplaints() {
  const notesPath = path.join(ROOMS_HOME_DIR, 'friction', 'notes.md');
  try {
    return parseFrictionNotes(fs.readFileSync(notesPath, 'utf8'));
  } catch {
    return [];
  }
}

function roomFrictionSummary(name, complaints) {
  const matching = complaints.filter(complaint => complaint.source === name);
  const newest = matching[matching.length - 1] || null;
  return {
    count: matching.length,
    latestAt: newest?.timestamp || null,
    latest: newest?.summary || null,
  };
}

function buildRoomsSnapshot() {
  const names = listRoomDirs();
  const assignments = readRoomAssignments();
  const leaders = ROOM_LEADERS_STATE.read();
  const residentState = ROOM_RESIDENTS_STATE.read();
  const sessionMeta = readMeta();
  const pulseState = ROOM_PULSES_STATE.read();
  const pulseSessionIds = Object.values(pulseState).map((pulse) => pulse?.sessionId).filter(Boolean);
  const residentSessionIds = Object.values(residentState)
    .flatMap((residents) => Object.values(residents).map((resident) => resident.sessionId));
  const requiredSessionIds = [...new Set([...Object.keys(assignments), ...Object.values(leaders), ...residentSessionIds, ...pulseSessionIds])];
  const all = discoverSessions(300, null, requiredSessionIds);
  const byRoom = groupRoomSessions({
    roomNames: names,
    roomsRoot: ROOMS_HOME_DIR,
    sessions: all,
    assignments,
  });
  const frictionComplaints = readFrictionComplaints();
  const rooms = names.map((name) => {
    const sessions = byRoom.get(name); // activity-sorted by discoverSessions
    const pulse = roomPulse(name, Date.now(), pulseState);
    const requestedLeaderSessionId = leaders[name];
    const isEligibleLeader = (session) =>
      session.agent !== 'codex'
        && session.id !== pulse.sessionId
        && !String(session.title || '').startsWith('Keep working: #');
    const leaderSessionId = sessions.find((session) => session.id === requestedLeaderSessionId && isEligibleLeader(session))?.id
      || null;
    const leaderSession = sessions.find((session) => session.id === leaderSessionId) || null;
    const residents = [];
    if (leaderSession) {
      residents.push({
        role: 'leader',
        sessionId: leaderSession.id,
        agent: leaderSession.agent,
        title: leaderSession.title,
        status: leaderSession.isActive ? 'working' : 'waiting',
      });
    }
    for (const [role, configured] of Object.entries(residentState[name] || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const session = sessions.find((candidate) => candidate.id === configured.sessionId);
      residents.push({
        role,
        sessionId: configured.sessionId,
        agent: session?.agent || sessionMeta[configured.sessionId]?.agent || 'unknown',
        title: session?.title || role,
        status: session ? (session.isActive ? 'working' : 'waiting') : 'offline',
      });
    }
    let latest = leaderSession ? lastMessageSnippet(leaderSession.id, leaderSession.agent || 'omp') : null;
    let updatedAt = leaderSession?.updatedAt || null;
    if (!latest) {
      // Room with no visible chat yet: fall back to the last notes.md line.
      try {
        const notesPath = path.join(ROOMS_HOME_DIR, name, 'notes.md');
        const noteLines = fs.readFileSync(notesPath, 'utf8').split('\n').filter((l) => l.trim());
        if (noteLines.length > 1) latest = { role: 'notes', text: noteLines[noteLines.length - 1].slice(0, 200) };
        if (!updatedAt) updatedAt = fs.statSync(notesPath).mtime.toISOString();
      } catch {}
    }
    return {
      name,
      cwd: path.join(ROOMS_HOME_DIR, name),
      sessions,
      leaderSessionId,
      residents,
      sidecarGroupId: leaderSessionId ? sidecar.roomGroupId(name) : null,
      active: sessions.some((s) => s.isActive),
      pulse,
      latest,
      updatedAt,
      updates: roomUpdatesSummary(name),
      friction: roomFrictionSummary(name, frictionComplaints),
    };
  });
  rooms.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return rooms;
}

// Room discovery walks thousands of cross-harness transcripts. Keep the same
// 10-second freshness as RoomsHome's poll, but never make a warm request wait
// for that synchronous scan: stale readers get the last good snapshot while a
// single deferred refresh rebuilds it.
const roomSnapshotCache = createSnapshotCache(buildRoomsSnapshot, { ttlMs: 10_000 });

function roomNameForSession(id) {
  const names = listRoomDirs();
  const assignments = readRoomAssignments();
  if (names.includes(assignments[id])) return assignments[id];
  const session = discoverSessions(0, null, [id]).find((candidate) => candidate.id === id);
  if (!session) return null;
  const grouped = groupRoomSessions({
    roomNames: names,
    roomsRoot: ROOMS_HOME_DIR,
    sessions: [session],
    assignments,
  });
  return names.find((name) => grouped.get(name).some((candidate) => candidate.id === id)) || null;
}

app.get('/api/sessions/:id/room', (req, res) => {
  try { res.json({ room: roomNameForSession(req.params.id) }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/rooms', (_req, res) => {
  try { res.json({ rooms: roomSnapshotCache.get() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rooms/:name/residents', (req, res) => {
  try {
    const room = roomSnapshotCache.get().find((candidate) => candidate.name === req.params.name);
    if (!room) throw httpError(404, 'no such room');
    res.json({ residents: room.residents, sidecarGroupId: room.sidecarGroupId });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});


app.get('/api/rooms/:name/friction', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const complaints = readFrictionComplaints().filter(complaint => complaint.source === name).reverse();
    res.json({ complaints, count: complaints.length });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Scaffold a new room folder — same shape as `room new` in bin/room.
app.post('/api/rooms', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!ROOM_NAME_RE.test(name)) throw httpError(400, 'bad room name (lowercase, digits, dashes)');
    const dir = path.join(ROOMS_HOME_DIR, name);
    if (fs.existsSync(dir)) throw httpError(409, 'room exists');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), [
      `# Room: #${name}`,
      '',
      '<!-- Two lines on what this room is about. Edit me. -->',
      '',
      'Follow the shared room doctrine: read ~/rooms/_doctrine.md now.',
      'On start, read notes.md — it is the room\'s memory; this chat is not.',
      '',
    ].join('\n'));
    fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(dir, 'notes.md'),
      `# #${name} — notes\n\nWorking memory for this room. Sessions append decisions and open\nthreads as they happen (\`room note "..."\`). Newest at the bottom.\n`);
    roomSnapshotCache.refresh();
    res.json({ name, cwd: dir });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Pull an existing session (any cwd) into a room, or remove it again.
app.post('/api/rooms/:name/assign', (req, res) => {
  try {
    const { name } = req.params;
    const sid = String(req.body?.sessionId || '').trim();
    if (!sid) throw httpError(400, 'sessionId required');
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const targetRoom = req.body?.remove ? null : name;
    const leaderRoom = Object.entries(ROOM_LEADERS_STATE.read())
      .find(([, leaderSessionId]) => leaderSessionId === sid)?.[0] || null;
    if (leaderRoom && leaderRoom !== targetRoom) {
      throw httpError(409, `the Leader of #${leaderRoom} cannot be moved or detached`);
    }
    const pulseRoom = Object.entries(ROOM_PULSES_STATE.read())
      .find(([, pulse]) => pulse?.sessionId === sid)?.[0] || null;
    if (pulseRoom && pulseRoom !== targetRoom) {
      throw httpError(409, `keep-working controller of #${pulseRoom} cannot be moved or detached`);
    }
    const residentMatch = Object.entries(ROOM_RESIDENTS_STATE.read()).flatMap(([roomName, residents]) =>
      Object.entries(residents).map(([role, resident]) => ({ roomName, role, sessionId: resident.sessionId })))
      .find((resident) => resident.sessionId === sid);
    if (residentMatch && residentMatch.roomName !== targetRoom) {
      throw httpError(409, `resident ${residentMatch.role} of #${residentMatch.roomName} cannot be moved or detached`);
    }
    const assignments = ROOM_ASSIGN_STATE.update((current) => {
      const next = { ...current };
      if (req.body?.remove) {
        if (current[sid] !== name) throw httpError(409, `session is not assigned to #${name}`);
        delete next[sid];
      }
      else next[sid] = name;
      return next;
    });
    // Leader and resident membership are durable roles, never assignment side effects.
    roomSnapshotCache.refresh();
    res.json({ ok: true, assignments });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});


app.post('/api/rooms/:name/pulse', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    if (typeof req.body?.enabled !== 'boolean') throw httpError(400, 'enabled must be true or false');
    const now = Date.now();
    ROOM_PULSES_STATE.update((current) => ({
      ...current,
      [name]: pulseRecord(current[name], {
        enabled: req.body.enabled,
        status: req.body.enabled ? 'waiting' : 'paused',
        nextRunAtMs: req.body.enabled ? now + ROOM_PULSE_INTERVAL_MS : null,
        error: null,
      }),
    }));
    const pulse = roomPulse(name, now);
    roomSnapshotCache.update((rooms) => rooms.map((room) => room.name === name ? { ...room, pulse } : room));
    res.json({ ok: true, pulse });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Legacy evidence API. GET is allowed in read-only canary mode (see
// READ_ONLY_API_ROUTES); POST is a mutation and is blocked there.
app.get('/api/rooms/:name/updates', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    res.json({ updates: readRoomUpdates(name) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/rooms/:name/updates', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const entry = appendRoomUpdate(name, req.body?.text);
    // Reflect the new count in the cached snapshot immediately so the unread
    // badge does not wait for the next 10s rebuild.
    roomSnapshotCache.update((rooms) => rooms.map((room) =>
      room.name === name ? { ...room, updates: roomUpdatesSummary(name) } : room));
    res.json({ ok: true, update: entry });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Room wiki: curated Markdown under <room>/wiki/. Read-only surface — agents
// (and the caretaker) write via the filesystem, Feather only serves it, so
// both routes are allowlisted in read-only canary mode.
app.get('/api/rooms/:name/wiki', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const root = verifiedWikiRoot(ROOMS_HOME_DIR, name);
    res.json({ pages: root ? listWikiPages(root) : [] });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/rooms/:name/wiki/page', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const root = verifiedWikiRoot(ROOMS_HOME_DIR, name);
    const page = root ? readWikiPage(root, String(req.query.name || '')) : null;
    if (!page) throw httpError(404, 'no such wiki page');
    res.json(page);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

const ROOM_PULSE_PROMPT = `Keep working on this room. Read AGENTS.md, notes.md, and the recent chats in this room. Then do the next useful thing fully autonomously. Do not ask the user to choose routine steps. Use tools and agents if useful. Append what you did, the evidence, and any open thread to notes.md. Do not post an Updates feed and do not copy raw source material into the wiki; the Room caretaker will synthesize raw notes and sessions into curated knowledge. If you hit a recurring annoyance, run: room complain "describe it plainly". If this room genuinely has no useful next action, run: room pause. Then stop.`;
function launchRoomPulse(name) {
  try {
    const now = Date.now();
    const saved = ROOM_PULSES_STATE.read()[name] || {};
    const id = saved.sessionId || randomUUID();
    const cwd = path.join(ROOMS_HOME_DIR, name);
    const sessionDir = path.join(OMP_SESSIONS, id);
    const promptFile = path.join(sessionDir, 'pulse.md');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(promptFile, ROOM_PULSE_PROMPT, { mode: 0o600 });
    ROOM_PULSES_STATE.update((current) => ({
      ...current,
      [name]: pulseRecord(current[name], {
        enabled: true, status: 'working', sessionId: id,
        lastRunAt: new Date(now).toISOString(), nextRunAtMs: now + ROOM_PULSE_INTERVAL_MS, error: null,
      }),
    }));
    updateMeta((meta) => ({ ...meta, [id]: { ...(meta[id] || {}), agent: 'omp', title: `Keep working: #${name}` } }));
    ROOM_ASSIGN_STATE.update((current) => ({ ...current, [id]: name }));
    const continuing = !!findOmpJsonlPath(id);
    launchOmpSession(id, cwd, { resume: continuing, promptFile, autoApprove: true });
  } catch (error) {
    ROOM_PULSES_STATE.update((current) => ({
      ...current,
      [name]: pulseRecord(current[name], { enabled: true, status: 'error', error: error.message, nextRunAtMs: Date.now() + ROOM_PULSE_INTERVAL_MS }),
    }));
    console.warn(`[room pulse] #${name}:`, error.message);
  }
}

function hasBlockingRoomActivity(room) {
  return room.sessions.some((session) =>
    session.isActive
      && !room.residents.some((resident) =>
        resident.role !== 'leader' && resident.sessionId === session.id));
}

function checkRoomPulses() {
  if (!ROOM_PULSES_ENABLED) return;
  const now = Date.now();
  const pulseState = ROOM_PULSES_STATE.read();
  const due = [];
  let inFlight = 0;
  for (const name of listRoomDirs()) {
    let saved = isJsonRecord(pulseState[name]) ? pulseState[name] : {};
    if (saved.status === 'working' && saved.sessionId && !tmuxIsActive(saved.sessionId)) {
      ROOM_PULSES_STATE.update((current) => ({
        ...current,
        [name]: pulseRecord(current[name], { status: 'waiting' }),
      }));
      saved = { ...saved, status: 'waiting' };
    }
    // A run whose tmux is still alive holds a concurrency slot; never relaunch it.
    if (saved.status === 'working') { inFlight++; continue; }
    if (saved.enabled === false || now < (Number(saved.nextRunAtMs) || ROOM_PULSE_STARTED_AT + ROOM_PULSE_INTERVAL_MS)) continue;
    due.push({ name, nextRunAtMs: Number(saved.nextRunAtMs) || 0 });
  }
  if (due.length === 0) return;
  // Oldest-due first (then name) so a synchronized batch drains fairly instead
  // of starving whichever rooms sort late.
  due.sort((a, b) => (a.nextRunAtMs - b.nextRunAtMs) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const rooms = new Map(roomSnapshotCache.refresh().map((room) => [room.name, room]));
  for (const { name } of due) {
    const room = rooms.get(name);
    if (!room || hasBlockingRoomActivity(room)) {
      ROOM_PULSES_STATE.update((current) => ({ ...current, [name]: pulseRecord(current[name], { enabled: true, status: 'waiting', nextRunAtMs: now + ROOM_PULSE_INTERVAL_MS }) }));
      continue;
    }
    // Cap simultaneous autonomous runs: many rooms coming due together must not
    // spawn one agent each at once. Deferred rooms stay due and launch on later
    // ticks, which also desynchronizes their schedules over time.
    if (inFlight >= ROOM_PULSE_MAX_CONCURRENT) continue;
    launchRoomPulse(name);
    inFlight++;
  }
  const latestPulseState = ROOM_PULSES_STATE.read();
  roomSnapshotCache.update((snapshot) => snapshot.map((room) => ({
    ...room,
    pulse: roomPulse(room.name, Date.now(), latestPulseState),
  })));
  roomSnapshotCache.invalidate();
}

// Validate every durable JSON document before accepting traffic. Only truly
// missing files receive their documented defaults; corruption fails startup.
for (const state of [
  BOXES_STATE,
  SHARING_STATE,
  META_STATE,
  PROJECT_LABELS_STATE,
  LINKS_STATE,
  STARRED_STATE,
  ROOM_ASSIGN_STATE,
  ROOM_LEADERS_STATE,
  ROOM_PULSES_STATE,
  ROOM_RESIDENTS_STATE,
  MESSAGE_RECEIPTS_STATE,
]) state.read();
if (!READ_ONLY_MODE) syncAllRoomSidecars();
if (!READ_ONLY_MODE) await reconcileProtocolRunOwners();

const server = http.createServer(app);

// ── Terminal WebSocket ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
  if (READ_ONLY_MODE) {
    const body = JSON.stringify(READ_ONLY_ERROR);
    socket.end([
      'HTTP/1.1 403 Forbidden',
      'Content-Type: application/json',
      'Cache-Control: no-store',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '', body,
    ].join('\r\n'));
    return;
  }
  if (pathname === '/api/terminal' || pathname === '/api/shell') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── Deepgram batch transcription ────────────────────────────────────────────

app.post('/api/transcribe', async (req, res) => {
  try {
    const declaredSize = Number(req.headers['content-length'] || 0);
    if (declaredSize > MAX_AUDIO_BYTES) throw httpError(413, 'audio exceeds 25 MB limit');
    const audio = await readBoundedBody(req, MAX_AUDIO_BYTES, 'audio exceeds 25 MB limit');
    if (!DEEPGRAM_API_KEY) throw httpError(500, 'No Deepgram API key configured');
    const contentType = req.headers['content-type'] || 'audio/webm';
    const dgRes = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&smart_format=true', {
      method: 'POST',
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': contentType },
      body: audio,
      signal: AbortSignal.timeout(120_000),
    });
    if (!dgRes.ok) {
      const errText = await dgRes.text();
      return res.status(dgRes.status).json({ error: errText });
    }
    const data = await dgRes.json();
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript });
  } catch (e) { res.status(e.status || (e.name === 'TimeoutError' ? 504 : 500)).json({ error: e.message }); }
});

// Register fallbacks after every API route. API misses stay JSON instead of
// being mistaken for successful SPA navigation.
app.all(['/api', '/api/{*path}'], (_req, res) => res.status(404).json({ error: 'not found' }));

// Missing hashed assets must 404, not fall through to index.html — a stale
// client fetching a pre-deploy bundle would get HTML as JS and white-screen.
app.use('/assets', (req, res, next) => {
  const assetPath = path.join(STATIC_DIR, 'assets', path.normalize(req.path));
  if (!assetPath.startsWith(path.join(STATIC_DIR, 'assets')) || !fs.existsSync(assetPath)) {
    return res.status(404).type('text/plain').send('asset not found');
  }
  next();
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Feather v2 on http://0.0.0.0:${PORT}`);
  // Warm the expensive Rooms snapshot before the first interactive request.
  setTimeout(() => { try { roomSnapshotCache.get(); } catch {} }, 0);
  if (!READ_ONLY_MODE) setTimeout(() => syncAllRoomSidecars({ primeNewResidents: true }), 1000);
  // Durable Room Sidecars are synchronized before listen; no startup 404 window.
  if (ROOM_PULSES_ENABLED) {
    setTimeout(checkRoomPulses, Math.min(ROOM_PULSE_CHECK_MS, ROOM_PULSE_INTERVAL_MS));
    setInterval(checkRoomPulses, ROOM_PULSE_CHECK_MS);
  }
});

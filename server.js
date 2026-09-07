import express from 'express';
import compression from 'compression';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, execSync, spawn } from 'child_process';
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
import {
  OMP_GATEWAY_COMMAND,
  ompGatewayModelsConfig,
  ompModelFlags,
  resolveOmpModel,
  resolveOmpThinking,
  sanitizeOmpModel,
} from './lib/omp.js';
import { ompSessionCwdFromHead, ompSessionIdFromHead, ompTurnBoundaryFromLine } from './lib/omp-session.js';
import { createJsonState, isJsonRecord } from './lib/json-state.js';
import {
  validateRules, normalizeRule, planTick, findIncidents, expiredRuns, markStarted, markFinished,
  runtimeOf, describeRule, SCHEDULER_TICK_MS, BOOT_GRACE_MS, DEFAULT_TIMEOUT_MS,
} from './lib/scheduler.js';
import { encodeProjectPath, groupRoomSessions } from './lib/rooms.js';
import { listWikiPages, readWikiPage, verifiedWikiRoot } from './lib/room-wiki.js';
import { ROOM_LEADER_PROMPT_VERSION, roomLeaderPrompt } from './lib/room-leader.js';
import { parseFrictionNotes, openFrictionComplaints } from './lib/friction.js';
import { createUsageLedger, summarizeUsage } from './lib/usage-ledger.js';
import { createProviderLimits } from './lib/provider-limits.js';
import { buildSuperFeed, mergeSuperFeed, superFeedCursor } from './lib/super-feed.js';
import { appendRoomPublication, readRoomPublications, verifiedPublicationVisual } from './lib/room-publications.js';
import {
  ROOM_STANDARD_RESIDENTS,
  ROOM_TEMPLATE_DIRS,
  frontierTemplate,
  judgeWakePrompt,
  leaderFallbackPrompt,
  leaderKickoffPrompt,
  leaderSteerPrompt,
  leaderWakePrompt,
  normalizeRoomMission,
  parseRoomMission,
  residentWakePrompt,
  scaffoldRoom,
  roomTemplateFiles,
} from './lib/room-template.js';
import { appendSteering, normalizeSteerText } from './lib/room-frontier.js';
import { FEED_COMMENTS_MAX, FEED_COMMENT_ID_RE, commentDelivered, feedCommentPrompt, feedReplyNudgePrompt, isFeedCommentState, normalizeFeedCommentText, normalizeFeedReplyText, publicFeedComment } from './lib/feed-comments.js';

import { createProtocolRunStore } from './lib/protocol-runs.js';
import {
  RALPH_CALLBACK_DELAY_MS,
  RALPH_CALLBACK_MAX_ATTEMPTS,
  RALPH_MODE,
  RALPH_PROMPT_VERSION,
  publicRalphState,
  ralphBoundaryFromLine,
  ralphContinuationPrompt,
  ralphSystemPrompt,
} from './lib/ralph.js';

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
const OMP_AGENT_DIRS = STATE_PATHS.harness.ompAgentDirsDir;
let OMP_AUTH_GATEWAY_URL = String(process.env.FEATHER_OMP_AUTH_GATEWAY_URL || '').trim();
if (OMP_AUTH_GATEWAY_URL) {
  const parsed = new URL(OMP_AUTH_GATEWAY_URL);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('FEATHER_OMP_AUTH_GATEWAY_URL must be an HTTP(S) base URL without credentials, query, or fragment');
  }
  OMP_AUTH_GATEWAY_URL = OMP_AUTH_GATEWAY_URL.replace(/\/+$/, '');
}
const OMP_AUTH_GATEWAY_TOKEN_FILE = path.resolve(
  process.env.FEATHER_OMP_AUTH_GATEWAY_TOKEN_FILE || path.join(HOME, '.omp/auth-gateway.token'),
);
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
const OMP_SHARED_AGENT_DIR = path.join(HOME, '.omp/agent');
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

function isFeedPreferencesState(value) {
  if (!isJsonRecord(value)) return false;
  if (value.rooms === null) return true;
  return Array.isArray(value.rooms)
    && value.rooms.every(room => typeof room === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(room))
    && new Set(value.rooms).size === value.rooms.length;
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
const FEED_PREFERENCES_STATE = createJsonState({
  file: STATE_PATHS.instance.feedPreferencesFile,
  root: STATE_PATHS.instance.root,
  document: 'Super Feed preferences',
  defaultValue: { rooms: null },
  validate: isFeedPreferencesState,
  mode: 0o600,
});
const FEED_COMMENTS_STATE = createJsonState({
  file: STATE_PATHS.instance.feedCommentsFile,
  root: STATE_PATHS.instance.root,
  document: 'Super Feed comments',
  defaultValue: { comments: [] },
  validate: isFeedCommentState,
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

function lastCompleteLineOffset(fd, size) {
  if (size === 0) return 0;
  const lastByte = Buffer.allocUnsafe(1);
  fs.readSync(fd, lastByte, 0, 1, size - 1);
  if (lastByte[0] === 10) return size;
  let position = size;
  while (position > 0) {
    const length = Math.min(MESSAGE_TAIL_CHUNK_BYTES, position);
    const start = position - length;
    const chunk = Buffer.allocUnsafe(length);
    fs.readSync(fd, chunk, 0, length, start);
    const newline = chunk.lastIndexOf(10);
    if (newline >= 0) return start + newline + 1;
    position = start;
  }
  return 0;
}

function completeFileOffset(fpath) {
  const fd = fs.openSync(fpath, 'r');
  try {
    return lastCompleteLineOffset(fd, fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
}

function readLatestMessages(fpath, agent, count) {
  const wanted = Math.max(1, count);
  const reverse = [];
  const fd = fs.openSync(fpath, 'r');
  const cursor = lastCompleteLineOffset(fd, fs.fstatSync(fd).size);
  let position = cursor;
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
    cursor,
  };
}

function getMessages(sessionId, limit = 100, before = 0) {
  const agent = getAgentForSession(sessionId);
  const fpath = findJsonlPath(sessionId, agent);
  if (!fpath || !fs.existsSync(fpath)) return { messages: [], hasMore: false, cursor: 0, nextBefore: 0 };
  const pageSize = Math.max(1, limit);
  const offset = Math.max(0, before);
  const tail = readLatestMessages(fpath, agent, pageSize + offset);
  const end = Math.max(0, tail.messages.length - offset);
  const start = Math.max(0, end - pageSize);
  return {
    messages: tail.messages.slice(start, end),
    hasMore: tail.hasEarlier || start > 0,
    cursor: tail.cursor,
    nextBefore: offset + (end - start),
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
      const ralph = publicRalphState(meta[id]);
      sessions.push({
        id, title: effectiveTitle,
        updatedAt: new Date(facts.activityMs).toISOString(),
        isActive: sessionIsActive(active, id, facts.activityMs, now),
        agent,
        projectId: facts.projectId || null,
        projectLabel: isAllowlisted ? (labels[facts.projectId] || cleanProjectLabel(facts.projectId)) : null,
        share: Array.isArray(meta[id]?.share) && meta[id].share.length ? meta[id].share : undefined,
        ...(meta[id]?.mode === RALPH_MODE ? { mode: RALPH_MODE, ralph } : {}),
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

// Run a tmux command and surface stderr in the thrown error instead of
// swallowing it (the old stdio: 'ignore' hid every paste failure).
function tmuxRun(args) {
  try { return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    const detail = String(error.stderr || error.message || '').trim().split('\n')[0];
    throw new Error(`tmux ${args[0]} failed: ${detail}`);
  }
}

// Visible pane text, or null when there is nothing to observe (blank pane,
// fake tmux in tests, pane gone). Callers treat null as "unknown" and fall back to a fixed delay.
function tmuxCapture(target) {
  try {
    const screen = execFileSync('tmux', ['capture-pane', '-p', '-t', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return screen.trim() ? screen : null;
  } catch { return null; }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for the pane to draw something different from `before`. Returns true on
// an observed change, false on timeout, null when the screen is unobservable.
async function waitForPaneChange(target, before, timeoutMs, pollMs = 100) {
  if (before === null) { await pause(Math.min(timeoutMs, 400)); return null; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pause(pollMs);
    const now = tmuxCapture(target);
    if (now === null) return null;
    if (now !== before) return true;
  }
  return false;
}

// After a (re)launch, wait until the pane has drawn a screen that stays put
// for two polls in a row: the harness is at its composer, not still booting.
// Replaces a blind 6s sleep. Falls back to that sleep when unobservable.
const TMUX_READY_TIMEOUT_MS = Number(process.env.FEATHER_TMUX_READY_TIMEOUT_MS || 15_000);
async function waitForPaneSettled(target, { timeoutMs = TMUX_READY_TIMEOUT_MS, minMs = 1500, pollMs = 300 } = {}) {
  const start = Date.now();
  let previous;
  while (Date.now() - start < timeoutMs) {
    await pause(pollMs);
    const now = tmuxCapture(target);
    if (now === null) { await pause(Math.max(0, 6000 - (Date.now() - start))); return null; }
    if (now === previous && Date.now() - start >= minMs) return true;
    previous = now;
  }
  return false;
}

// One paste path for every harness (claude, codex, omp): a per-session named
// buffer (the default buffer stack is global, so two sessions pasting at once
// could swap texts) and -p so tmux wraps the text in bracketed-paste codes
// exactly when the app asked for them. -d drops the buffer after the paste.
function tmuxPaste(target, text, bufferName) {
  const tmp = path.join(os.tmpdir(), `feather-send-${randomUUID()}.txt`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    tmuxRun(['load-buffer', '-b', bufferName, tmp]);
    tmuxRun(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', target]);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
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

function ensureOmpBridgeDiscovery(agentDir = OMP_SHARED_AGENT_DIR) {
  return ensureManagedOmpSymlink(
    path.join(agentDir, 'extensions/feather-bridge.js'),
    OMP_BRIDGE_EXTENSION,
    path.join('omp-extensions', 'feather-bridge.js'),
    'bridge',
  );
}

function ensureOmpCouncilDiscovery(agentDir = OMP_SHARED_AGENT_DIR) {
  ensureManagedOmpSymlink(
    path.join(agentDir, 'extensions/feather-protocol-tools.js'),
    OMP_PROTOCOL_EXTENSION,
    path.join('omp-tools', 'feather-protocol-tools.js'),
    'protocols',
  );
  ensureManagedOmpSymlink(
    path.join(agentDir, 'skills/council'),
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

function isRalphSession(id) {
  return readMeta()[id]?.mode === RALPH_MODE;
}

function writeSessionSystemPrompt(id) {
  const parts = [];
  const roomName = roomLeaderNameForSession(id);
  if (roomName) parts.push(roomLeaderPrompt(roomName));
  if (isRalphSession(id)) parts.push(ralphSystemPrompt());
  if (parts.length === 0) return null;
  const promptDir = path.join(HOME, '.feather', 'session-system-prompts');
  fs.mkdirSync(promptDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(promptDir, 0o700);
  const version = `leader-${roomName ? ROOM_LEADER_PROMPT_VERSION : 0}-ralph-${isRalphSession(id) ? RALPH_PROMPT_VERSION : 0}`;
  const promptPath = path.join(promptDir, `${id}-${version}.md`);
  fs.writeFileSync(promptPath, parts.join('\n\n'), { mode: 0o600 });
  fs.chmodSync(promptPath, 0o600);
  return promptPath;
}
function writeForkRolePrompt(id, roomName, title) {
  const promptDir = path.join(HOME, '.feather', 'fork-prompts');
  fs.mkdirSync(promptDir, { recursive: true, mode: 0o700 });
  const promptPath = path.join(promptDir, `${id}.md`);
  fs.writeFileSync(promptPath, [
    `You are the ordinary forked work chat "${title}"${roomName ? ` inside #${roomName}` : ''}.`,
    'You inherited conversation context, not organizational authority.',
    'You are not the Room Leader, a durable resident, a status controller, or the canonical writer for shared knowledge.',
    'Work directly with the user on this branch. Do not impersonate the source role. Wait for the user’s next message.',
  ].join('\n'), { mode: 0o600 });
  return promptPath;
}

function launchOmpSession(id, cwd, { resume = false, forkFrom = null, promptFile = null, appendSystemPromptFile = null, autoApprove = false } = {}) {
  if (resume && forkFrom) throw new Error('OMP launch cannot resume and fork simultaneously');
  if (!resume) resetOmpBridgeSessionState(id);
  const sessionDir = path.join(OMP_SESSIONS, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const model = ompSessionModel(id);
  const agentDir = OMP_AUTH_GATEWAY_URL ? path.join(OMP_AGENT_DIRS, id) : OMP_SHARED_AGENT_DIR;
  if (OMP_AUTH_GATEWAY_URL) {
    let tokenStat;
    try { tokenStat = fs.statSync(OMP_AUTH_GATEWAY_TOKEN_FILE); } catch {}
    if (!tokenStat?.isFile()) {
      throw new Error(`OMP auth gateway token file is missing: ${OMP_AUTH_GATEWAY_TOKEN_FILE}`);
    }
    if ((tokenStat.mode & 0o077) !== 0) {
      throw new Error(`OMP auth gateway token file must be owner-only: ${OMP_AUTH_GATEWAY_TOKEN_FILE}`);
    }
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(agentDir, 0o700);
    const modelsPath = path.join(agentDir, 'models.yml');
    fs.writeFileSync(modelsPath, ompGatewayModelsConfig({
      model,
      baseUrl: OMP_AUTH_GATEWAY_URL,
      tokenCommand: `!cat ${shellQuote(OMP_AUTH_GATEWAY_TOKEN_FILE)}`,
    }), { mode: 0o600 });
    fs.chmodSync(modelsPath, 0o600);
  }
  const systemPromptFile = writeSessionSystemPrompt(id);
  watchOmpSessionDir(sessionDir, id);
  const sourceOmpId = resume ? getOmpSessionId(id) : forkFrom ? getOmpSessionId(forkFrom) : null;
  if ((resume || forkFrom) && !sourceOmpId) throw new Error(`Cannot ${resume ? 'resume' : 'fork'} OMP session ${forkFrom || id}: exact OMP session id not found`);
  const bridgeToken = randomUUID();
  const bridgeUrl = `http://127.0.0.1:${PORT}/api/internal/sessions/${id}/events`;
  ompBridgeTokens.set(id, bridgeToken);
  ompBridgeLastSeen.delete(id);
  const bridgeDiscovered = ensureOmpBridgeDiscovery(agentDir);
  ensureOmpCouncilDiscovery(agentDir);
  fs.mkdirSync(OMP_BRIDGE_TOKENS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(OMP_BRIDGE_TOKENS_DIR, 0o700);
  fs.writeFileSync(ompBridgeTokenPath(id), bridgeToken, { mode: 0o600 });
  fs.chmodSync(ompBridgeTokenPath(id), 0o600);
  fs.writeFileSync(path.join(sessionDir, '.feather-bridge.json'), JSON.stringify({
    url: bridgeUrl, token: bridgeToken, sessionId: id,
  }), { mode: 0o600 });
  fs.chmodSync(path.join(sessionDir, '.feather-bridge.json'), 0o600);
  const args = [
    OMP_AUTH_GATEWAY_URL ? OMP_GATEWAY_COMMAND : 'omp',
    ompModelFlags(model, OMP_THINKING).trim(),
    resume ? `--resume ${shellQuote(sourceOmpId)}` : forkFrom ? `--fork ${shellQuote(sourceOmpId)}` : '',
    (appendSystemPromptFile || systemPromptFile) ? `--append-system-prompt ${shellQuote(appendSystemPromptFile || systemPromptFile)}` : '',
    promptFile ? `-p ${autoApprove ? '--auto-approve ' : ''}${shellQuote(`@${promptFile}`)}` : '',
    OMP_AUTH_GATEWAY_URL ? '--no-extensions' : '',
    OMP_AUTH_GATEWAY_URL || !bridgeDiscovered ? `--extension ${shellQuote(OMP_BRIDGE_EXTENSION)}` : '',
    OMP_AUTH_GATEWAY_URL ? `--extension ${shellQuote(OMP_PROTOCOL_EXTENSION)}` : '',
    `--config ${shellQuote(OMP_FEATHER_CONFIG)}`,
    `--session-dir ${shellQuote(sessionDir)}`,
    '--allow-home',
  ].filter(Boolean).join(' ');
  const env = [
    `FEATHER_BRIDGE_URL=${shellQuote(bridgeUrl)}`,
    `FEATHER_BRIDGE_TOKEN=${shellQuote(bridgeToken)}`,
    `FEATHER_SESSION_ID=${shellQuote(id)}`,
    OMP_AUTH_GATEWAY_URL ? `PI_CODING_AGENT_DIR=${shellQuote(agentDir)}` : '',
    OMP_AUTH_GATEWAY_URL && model ? `PI_SMOL_MODEL=${shellQuote(model)}` : '',
    OMP_AUTH_GATEWAY_URL && model ? `PI_SLOW_MODEL=${shellQuote(model)}` : '',
    OMP_AUTH_GATEWAY_URL && model ? `PI_PLAN_MODEL=${shellQuote(model)}` : '',
  ].filter(Boolean).join(' ');
  const command = `bash --rcfile ~/.bashrc -ic ${shellQuote(`${env} ${args}`)}`;
  launchInTmux(tmuxName(id), command, cwd);
}

function spawnSession(id, cwd, agent = 'claude', { ompModel = '', mode = null } = {}) {
  const name = tmuxName(id);
  const model = agent === 'omp' ? sanitizeOmpModel(ompModel) : '';
  updateMeta((meta) => ({
    ...meta,
    [id]: {
      ...(meta[id] || {}),
      agent,
      ...(model ? { ompModel: model } : {}),
      ...(mode === RALPH_MODE ? {
        mode: RALPH_MODE,
        ralph: {
          enabled: true,
          status: 'waiting',
          iteration: 0,
          lastBoundaryKey: null,
          lastCallbackAt: null,
          blockedReason: null,
          completionReason: null,
          error: null,
        },
      } : {}),
    },
  }));

  if (agent === 'omp') {
    launchOmpSession(id, cwd);
  } else if (agent === 'codex') {
    ensureCodexTrust(cwd);
    const before = new Set(listCodexJsonlFiles().map(f => f.uuid));
    const ralphFlag = isRalphSession(id)
      ? `-c ${shellQuote(`developer_instructions=${JSON.stringify(ralphSystemPrompt())}`)}`
      : '';
    const args = [
      'codex',
      '-c check_for_update_on_startup=false',
      ralphFlag,
      '--dangerously-bypass-approvals-and-sandbox',
    ].filter(Boolean).join(' ');
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic ${shellQuote(args)}`, cwd);
    adoptNewCodexUuid(id, before, cwd);
  } else {
    ensureClaudeTrust(cwd);
    const systemPromptFile = writeSessionSystemPrompt(id);
    const args = [
      'claude',
      `--session-id ${shellQuote(id)}`,
      systemPromptFile ? `--append-system-prompt-file ${shellQuote(systemPromptFile)}` : '',
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
  const schedule = (delay) => {
    const timer = setTimeout(tick, delay);
    timer.unref?.();
  };
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
    if (n < attempts) schedule(n < 20 ? 500 : 2000);
    else console.warn(`[codex] failed to adopt UUID for ${featherId} after ${attempts} attempts`);
  };
  schedule(500);
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
    if (fpath) { fileOffsets.set(id, completeFileOffset(fpath)); watchCodexFile(fpath, id); }
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
    const ralphFlag = isRalphSession(id)
      ? `-c ${shellQuote(`developer_instructions=${JSON.stringify(ralphSystemPrompt())}`)}`
      : '';
    const args = [
      'codex',
      '-c check_for_update_on_startup=false',
      ralphFlag,
      resumeArg,
      `--cd ${shellQuote(sessionCwd)}`,
      '--dangerously-bypass-approvals-and-sandbox',
    ].filter(Boolean).join(' ');
    launchInTmux(name, `bash --rcfile ~/.bashrc -ic ${shellQuote(args)}`, cwd || sessionCwd);
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
    const systemPromptFile = writeSessionSystemPrompt(id);
    const args = [
      'claude',
      `--resume ${shellQuote(id)}`,
      systemPromptFile ? `--append-system-prompt-file ${shellQuote(systemPromptFile)}` : '',
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
    prepareRalphForHumanInput(id);

    const { observed } = await sendInputUnlocked(id, text);
    const response = { ok: true, sentAt: new Date().toISOString(), observed };
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
  const target = tmuxName(id);
  if (!tmuxIsActive(id)) {
    resumeSession(id);
    const settled = await waitForPaneSettled(target);
    if (settled === false) console.warn(`[send] ${target}: pane still changing ${TMUX_READY_TIMEOUT_MS}ms after resume; sending anyway`);
  }
  const buffer = `feather-${id.slice(0, 8)}`;

  // Paste, then confirm the text reached the screen before submitting. A paste
  // that lands in a dying or half-drawn pane shows no change; retry it once.
  let before = tmuxCapture(target);
  tmuxPaste(target, text, buffer);
  let pasted = await waitForPaneChange(target, before, 1500);
  if (pasted === false) {
    console.warn(`[send] ${target}: paste not visible after 1.5s; pasting again`);
    before = tmuxCapture(target);
    tmuxPaste(target, text, buffer);
    pasted = await waitForPaneChange(target, before, 1500);
  }
  if (pasted === null) await pause(300);

  // Submit, then confirm the screen moved (composer cleared, turn started or
  // queued). Enter on an already-submitted composer is a no-op, so a second
  // Enter is safe; a second paste is not, so we never re-paste here.
  let mid = tmuxCapture(target);
  tmuxRun(['send-keys', '-t', target, 'Enter']);
  let submitted = await waitForPaneChange(target, mid, 2000);
  if (submitted === false) {
    console.warn(`[send] ${target}: no screen change after Enter; sending Enter again`);
    mid = tmuxCapture(target);
    tmuxRun(['send-keys', '-t', target, 'Enter']);
    submitted = await waitForPaneChange(target, mid, 2000);
  }
  if (submitted === false) console.warn(`[send] ${target}: submission unconfirmed for ${text.length}-char message`);
  return { observed: submitted === true };
}

const ralphCallbackTimers = new Map();

function patchRalphState(id, patch) {
  let changed = false;
  updateMeta((meta) => {
    if (meta[id]?.mode !== RALPH_MODE) return meta;
    changed = true;
    return {
      ...meta,
      [id]: {
        ...meta[id],
        ralph: {
          ...(meta[id].ralph || {}),
          ...patch,
        },
      },
    };
  });
  return changed;
}

function cancelRalphCallback(id) {
  const pending = ralphCallbackTimers.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  ralphCallbackTimers.delete(id);
}

function stopRalphSession(id, status = 'stopped') {
  cancelRalphCallback(id);
  patchRalphState(id, {
    enabled: false,
    status,
    blockedReason: null,
    completionReason: null,
    error: null,
    callbackAttempt: 0,
  });
}

function prepareRalphForHumanInput(id) {
  if (!isRalphSession(id)) return;
  cancelRalphCallback(id);
  patchRalphState(id, {
    enabled: true,
    status: 'working',
    blockedReason: null,
    completionReason: null,
    error: null,
    callbackAttempt: 0,
  });
}

function armRalphCallback(id, boundaryKey, attempt = 0, delayMs = RALPH_CALLBACK_DELAY_MS) {
  cancelRalphCallback(id);
  const token = randomUUID();
  const timer = setTimeout(async () => {
    const pending = ralphCallbackTimers.get(id);
    if (!pending || pending.token !== token) return;
    ralphCallbackTimers.delete(id);
    const state = readMeta()[id]?.ralph;
    if (!state?.enabled || state.lastBoundaryKey !== boundaryKey) return;
    const iteration = (Number.isSafeInteger(state.iteration) ? state.iteration : 0) + 1;
    try {
      await sendInput(id, ralphContinuationPrompt(iteration));
      const latest = readMeta()[id]?.ralph;
      if (!latest?.enabled || latest.lastBoundaryKey !== boundaryKey) return;
      patchRalphState(id, {
        status: 'working',
        iteration,
        lastCallbackAt: new Date().toISOString(),
        error: null,
        callbackAttempt: 0,
      });
    } catch (error) {
      const nextAttempt = attempt + 1;
      const message = error instanceof Error ? error.message : String(error);
      if (nextAttempt < RALPH_CALLBACK_MAX_ATTEMPTS && readMeta()[id]?.ralph?.enabled) {
        patchRalphState(id, {
          status: 'scheduled',
          error: `Callback delivery failed (${nextAttempt}/${RALPH_CALLBACK_MAX_ATTEMPTS}): ${message}`,
          callbackAttempt: nextAttempt,
        });
        armRalphCallback(id, boundaryKey, nextAttempt, RALPH_CALLBACK_DELAY_MS * (2 ** nextAttempt));
      } else {
        patchRalphState(id, {
          enabled: false,
          status: 'error',
          error: `Callback delivery failed after ${RALPH_CALLBACK_MAX_ATTEMPTS} attempts: ${message}`,
          callbackAttempt: nextAttempt,
        });
      }
    }
  }, delayMs);
  ralphCallbackTimers.set(id, { timer, token, boundaryKey });
}

function scheduleRalphCallback(id, boundary) {
  const meta = readMeta()[id];
  if (meta?.mode !== RALPH_MODE || !meta.ralph?.enabled) return;
  if (boundary.complete) {
    cancelRalphCallback(id);
    patchRalphState(id, {
      enabled: false,
      status: 'complete',
      lastBoundaryKey: boundary.key,
      blockedReason: null,
      completionReason: boundary.complete,
      error: null,
      callbackAttempt: 0,
    });
    return;
  }
  if (boundary.blocked) {
    cancelRalphCallback(id);
    patchRalphState(id, {
      enabled: false,
      status: 'blocked',
      lastBoundaryKey: boundary.key,
      blockedReason: boundary.blocked,
      completionReason: null,
      error: null,
      callbackAttempt: 0,
    });
    return;
  }
  if (meta.ralph.lastBoundaryKey === boundary.key) return;
  patchRalphState(id, {
    status: 'scheduled',
    lastBoundaryKey: boundary.key,
    blockedReason: null,
    completionReason: null,
    error: null,
    callbackAttempt: 0,
  });
  armRalphCallback(id, boundary.key);
}

function observeRalphBoundary(id, line) {
  if (!isRalphSession(id)) return;
  const boundary = ralphBoundaryFromLine(line, getAgentForSession(id));
  if (!boundary) return;
  if (boundary.type === 'active') {
    cancelRalphCallback(id);
    const state = readMeta()[id]?.ralph;
    if (state?.enabled && state.status !== 'working') {
      patchRalphState(id, {
        status: 'working',
        blockedReason: null,
        completionReason: null,
        error: null,
        callbackAttempt: 0,
      });
    }
    return;
  }
  scheduleRalphCallback(id, boundary);
}

function resumeRalphSession(id) {
  if (!isRalphSession(id)) throw httpError(409, 'session is not a Ralph agent');
  prepareRalphForHumanInput(id);
  const key = `manual-${Date.now()}`;
  patchRalphState(id, { status: 'scheduled', lastBoundaryKey: key });
  armRalphCallback(id, key);
}

function recoverRalphCallbacks() {
  for (const [id, entry] of Object.entries(readMeta())) {
    if (entry?.mode !== RALPH_MODE || !entry.ralph?.enabled || entry.ralph.status !== 'scheduled') continue;
    const key = entry.ralph.lastBoundaryKey;
    if (typeof key === 'string' && key) {
      armRalphCallback(id, key, Number.isSafeInteger(entry.ralph.callbackAttempt) ? entry.ralph.callbackAttempt : 0);
    }
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

function settleReplayToolsForOwner(store, owner) {
  for (const entry of store.entries.values()) {
    if (replayOwner(entry.event) !== owner || !entry.event.type.startsWith('tool_execution_')) continue;
    const settled = { ...entry.event, type: 'tool_execution_end', isError: !!entry.event.isError };
    const bytes = Buffer.byteLength(JSON.stringify(settled));
    store.bytes += bytes - entry.bytes;
    entry.event = settled;
    entry.bytes = bytes;
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
    settleReplayToolsForOwner(store, owner);
    deleteReplayEntries(store, candidate => replayOwner(candidate) === owner
      && (candidate.type === 'assistant_snapshot' || candidate.type === 'work_snapshot'));
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
      || (!candidate.subagentId && (candidate.type === 'todo' || candidate.type === 'assistant_end' || candidate.type === 'assistant_cancel')));
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
      if (candidateKey === 'run:parent') continue;
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

// Latest bridge session_state for a session: model and context usage, the
// two numbers succession decisions are made on.
function leaderTelemetry(sessionId) {
  const event = ompBridgeReplay.get(sessionId)?.entries.get('singleton:session_state')?.event;
  if (!event) return {};
  return {
    ...(typeof event.modelId === 'string' ? { model: event.modelId } : {}),
    ...(Number.isFinite(event.contextPercent) ? { contextPercent: event.contextPercent } : {}),
  };
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
        try { fileOffsets.set(f.replace('.jsonl', ''), completeFileOffset(path.join(dp, f))); } catch {}
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
    const lastNewline = buf.lastIndexOf(10);
    if (lastNewline < 0) return;
    const complete = buf.subarray(0, lastNewline + 1);
    let start = 0;
    while (start < complete.length) {
      const newline = complete.indexOf(10, start);
      const line = complete.subarray(start, newline).toString('utf8');
      const offset = currentOffset + newline + 1;
      if (line) {
        broadcast(sessionId, line, offset);
        observeOmpTurnBoundary(sessionId, line);
        observeRalphBoundary(sessionId, line);
      }
      start = newline + 1;
    }
    fileOffsets.set(sessionId, currentOffset + complete.length);
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
      fileOffsets.set(sessionId, completeFileOffset(fpath));
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
          try { fileOffsets.set(dir, completeFileOffset(fpath)); } catch {}
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
  /^\/api\/feed$/,
  /^\/api\/usage$/,
  /^\/api\/scheduler(?:\/runs)?$/,
  /^\/api\/rooms\/[^/]+\/(updates|friction|wiki|wiki\/page|residents)$/,
  /^\/api\/rooms\/[^/]+\/publications\/[^/]+(?:\/visual)?$/,
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
    const delivered = event.type === 'agent_start' && !event.subagentId
      ? { ...event, invocationId: randomUUID() }
      : event;
    rememberOmpBridgeEvent(id, delivered);
    broadcastNamedEvent(id, 'omp_event', delivered);
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
  const { messages, hasMore, cursor, nextBefore } = getMessages(req.params.id, parseInt(req.query.limit) || 100, parseInt(req.query.before) || 0);
  res.json({ messages, hasMore, cursor, nextBefore });
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
          const replayEnd = lastCompleteLineOffset(fd, stat.size);
          if (replayEnd > lastId) {
            const buf = Buffer.alloc(replayEnd - lastId);
            fs.readSync(fd, buf, 0, buf.length, lastId);
            let start = 0;
            while (start < buf.length) {
              const newline = buf.indexOf(10, start);
              const line = buf.subarray(start, newline).toString('utf8');
              const offset = lastId + newline + 1;
              const parsed = line ? parseMessageForAgent(line, agent) : null;
              if (parsed) res.write(`id: ${offset}\nevent: message\ndata: ${JSON.stringify(parsed)}\n\n`);
              start = newline + 1;
            }
          }
          fs.closeSync(fd);
        }
      } catch {}
    }
  }

  replayOmpBridgeEvents(sid, clients, res);
  replayProtocolRuns(sid, clients, res);
  const hb = setInterval(() => {
    if (!writeSse(sid, sseClients.get(sid) || new Set(), res, 'event: heartbeat\ndata: {}\n\n', true)) clearInterval(hb);
  }, 15000);
  res.on('close', () => { clearInterval(hb); sseClients.get(sid)?.delete(res); ssePeerAuth.delete(res); });
}

app.get('/api/sessions/:id/stream', sessionStreamHandler);

// /btw: a side question answered from the session's own context without
// touching the session. OMP's builtin /btw lives only in its TUI, so Feather
// runs `omp -p` on a copy of the transcript (same model and auth as the chat,
// no tools, no extensions) and keeps the exchange in memory, off the record.
const BTW_DIR = path.join(HOME, '.feather', 'btw');
const BTW_TIMEOUT_MS = Math.max(10_000, Number(process.env.FEATHER_BTW_TIMEOUT_MS) || 120_000);
const BTW_HISTORY_MAX = 20;
const BTW_QUESTION_MAX = 4000;
const btwHistory = new Map();
const btwInFlight = new Set();

function btwPrompt(question) {
  return [
    '<btw>',
    'The user is asking a quick side question while your main task is paused.',
    'Answer it directly and briefly from the conversation so far. Do not continue or restart the main task,',
    'do not call tools, and do not treat the question as a new instruction.',
    `Question: ${question}`,
    '</btw>',
  ].join('\n');
}

function runBtw(id, question) {
  const source = findOmpJsonlPath(id);
  const ompId = getOmpSessionId(id);
  if (!source || !ompId) throw httpError(409, 'session has no transcript yet');
  fs.mkdirSync(BTW_DIR, { recursive: true, mode: 0o700 });
  const workDir = fs.mkdtempSync(path.join(BTW_DIR, `${id.slice(0, 8)}-`));
  fs.copyFileSync(source, path.join(workDir, path.basename(source)));
  const model = ompSessionModel(id);
  const agentDir = OMP_AUTH_GATEWAY_URL ? path.join(OMP_AGENT_DIRS, id) : OMP_SHARED_AGENT_DIR;
  const systemPromptFile = writeSessionSystemPrompt(id);
  const args = [
    OMP_AUTH_GATEWAY_URL ? OMP_GATEWAY_COMMAND : 'omp',
    ompModelFlags(model, '').trim(),
    '-p --no-tools --no-extensions --no-skills --no-rules --no-title',
    systemPromptFile ? `--append-system-prompt ${shellQuote(systemPromptFile)}` : '',
    `--config ${shellQuote(OMP_FEATHER_CONFIG)}`,
    `--session-dir ${shellQuote(workDir)}`,
    `--resume ${shellQuote(ompId)}`,
    shellQuote(btwPrompt(question)),
  ].filter(Boolean).join(' ');
  const env = [
    OMP_AUTH_GATEWAY_URL ? `PI_CODING_AGENT_DIR=${shellQuote(agentDir)}` : '',
    OMP_AUTH_GATEWAY_URL && model ? `PI_SMOL_MODEL=${shellQuote(model)}` : '',
    OMP_AUTH_GATEWAY_URL && model ? `PI_SLOW_MODEL=${shellQuote(model)}` : '',
    OMP_AUTH_GATEWAY_URL && model ? `PI_PLAN_MODEL=${shellQuote(model)}` : '',
  ].filter(Boolean).join(' ');
  // The interactive shell (needed for the user's PATH, like the tmux launch)
  // may print rc noise on stdout, so omp's answer goes to a file instead.
  const answerPath = path.join(workDir, 'answer.txt');
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn('bash', ['--rcfile', path.join(HOME, '.bashrc'), '-ic', `${env} ${args} > ${shellQuote(answerPath)}`.trim()], {
      cwd: getOmpSessionCwd(id) || HOME,
      env: { ...process.env, FEATHER_BTW: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: BTW_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(httpError(500, `btw failed to start: ${error.message}`)));
    child.on('close', (code, signal) => {
      let answer = '';
      try { answer = fs.readFileSync(answerPath, 'utf8').trim(); } catch {}
      fs.rmSync(workDir, { recursive: true, force: true });
      if (signal) return reject(httpError(504, 'btw timed out'));
      if (code !== 0 && !answer) return reject(httpError(502, `btw failed: ${stderr.trim().split('\n').pop() || `exit ${code}`}`));
      if (!answer) return reject(httpError(502, 'btw returned no answer'));
      resolve({ answer, model, ms: Date.now() - startedAt, at: new Date(startedAt).toISOString() });
    });
  });
}

app.get('/api/sessions/:id/btw', (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'bad session id' });
  res.json({ items: btwHistory.get(id) || [], pending: btwInFlight.has(id) });
});

app.post('/api/sessions/:id/btw', async (req, res) => {
  const { id } = req.params;
  try {
    if (!UUID_RE.test(id)) throw httpError(400, 'bad session id');
    if (getAgentForSession(id) !== 'omp') throw httpError(409, '/btw needs an OMP session');
    const question = String(req.body?.question || '').trim();
    if (!question) throw httpError(400, 'question required');
    if (question.length > BTW_QUESTION_MAX) throw httpError(400, 'question too long');
    if (btwInFlight.has(id)) throw httpError(409, 'a /btw is already running for this session');
    btwInFlight.add(id);
    let result;
    try { result = await runBtw(id, question); }
    finally { btwInFlight.delete(id); }
    const item = { id: randomUUID(), question, ...result };
    const items = [...(btwHistory.get(id) || []), item].slice(-BTW_HISTORY_MAX);
    btwHistory.set(id, items);
    res.json(item);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Create a session, optionally as a Room Leader or resident. Shared by
// POST /api/sessions and Room staffing so both paths keep the same rules.
// Returns the JSON body the API answers with; throws httpError on refusal.
function createSessionForRequest(body) {
  const agent = body.agent || 'claude';
  const roomRole = body.roomRole || null;
  const roomName = String(body.roomName || '').trim();
  const mode = body.mode || null;
  let assignmentsBefore = null;
  let leadersBefore = null;
  let residentsBefore = null;
  try {
    const id = validateFreshSessionId(body.id);
    const residentRole = roomRole && roomRole !== 'leader' ? String(roomRole) : null;
    if (residentRole && !ROOM_RESIDENT_ROLE_RE.test(residentRole)) throw httpError(400, 'invalid Room resident role');
    if (mode && mode !== RALPH_MODE) throw httpError(400, 'unsupported session mode');
    if (roomRole === 'leader' && mode) throw httpError(409, 'Room Leaders cannot use a session mode');
    if (residentRole && (agent !== 'omp' || mode !== RALPH_MODE)) {
      throw httpError(409, 'Room residents require an OMP Ralph session');
    }
    if (roomRole) {
      if (!listRoomDirs().includes(roomName)) throw httpError(404, 'no such room');
      if (path.resolve(String(body.cwd || '')) !== path.join(ROOMS_HOME_DIR, roomName)) {
        throw httpError(409, `${roomRole} cwd must be #${roomName}`);
      }
      assignmentsBefore = readRoomAssignments();
    }
    if (roomRole === 'leader') {
      if (agent !== 'omp') throw httpError(409, 'new Room Leaders currently require OMP');
      leadersBefore = ROOM_LEADERS_STATE.read();
      const existingLeaderId = leadersBefore[roomName] || null;
      if (existingLeaderId && validRoomLeaderDesignation(roomName, existingLeaderId)) {
        syncRoomSidecar(roomName);
        return { id: existingLeaderId, status: 'existing', agent: getAgentForSession(existingLeaderId), roomRole };
      }
      const staleLeaderId = existingLeaderId && !validRoomLeaderDesignation(roomName, existingLeaderId)
        ? existingLeaderId
        : null;
      appointRoomLeader(roomName, id, { assign: true, replaceStale: staleLeaderId });
    } else if (residentRole) {
      residentsBefore = ROOM_RESIDENTS_STATE.read();
      const existing = residentsBefore[roomName]?.[residentRole] || null;
      if (existing && assignmentsBefore[existing.sessionId] === roomName
        && (tmuxIsActive(existing.sessionId) || fs.existsSync(path.join(OMP_SESSIONS, existing.sessionId)))) {
        syncRoomSidecar(roomName);
        return { id: existing.sessionId, status: 'existing', agent: getAgentForSession(existing.sessionId), roomRole, mode: RALPH_MODE };
      }
      ROOM_ASSIGN_STATE.update((current) => {
        const next = { ...current, [id]: roomName };
        if (existing) delete next[existing.sessionId];
        return next;
      });
      const wakeIntervalMs = Number.isFinite(body.wakeIntervalMs) && body.wakeIntervalMs >= 60_000 ? Math.floor(body.wakeIntervalMs) : null;
      ROOM_RESIDENTS_STATE.update((current) => ({
        ...current,
        [roomName]: {
          ...(current[roomName] || {}),
          [residentRole]: {
            sessionId: id,
            wakeIntervalMs,
            nextWakeAtMs: wakeIntervalMs ? Date.now() + wakeIntervalMs : null,
            lastWakeAt: null,
          },
        },
      }));
    }
    spawnSession(id, body.cwd, agent, { ompModel: body.model || (roomRole === 'leader' ? ROOM_LEADER_DEFAULT_MODEL : ''), mode });
    if (roomRole) {
      syncRoomSidecar(roomName, { primeNewResidents: true });
      roomSnapshotCache.refresh();
    }
    return { id, status: 'starting', agent, roomRole, ...(mode ? { mode } : {}) };
  } catch (e) {
    if (assignmentsBefore) ROOM_ASSIGN_STATE.update(() => assignmentsBefore);
    if (leadersBefore) ROOM_LEADERS_STATE.update(() => leadersBefore);
    if (residentsBefore) ROOM_RESIDENTS_STATE.update(() => residentsBefore);
    throw e;
  }
}

app.post('/api/sessions', (req, res) => {
  try { res.json(createSessionForRequest(req.body || {})); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});


app.post('/api/sessions/:id/send', async (req, res) => {
  try {
    const messageId = req.get('X-Feather-Message-ID');
    if (messageId !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(messageId)) {
      return res.status(400).json({ error: 'invalid message id' });
    }
    if (!messageId) prepareRalphForHumanInput(req.params.id);
    if (!messageId) {
      await sendInput(req.params.id, req.body.text);
      return res.json({ ok: true, sentAt: new Date().toISOString() });
    }
    return res.json(await sendInputIdempotent(req.params.id, req.body.text, messageId));
  } catch (e) { res.status(protocolErrorStatus(e)).json({ error: e.message }); }
});
const TERMINAL_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Space', 'Tab', 'AgentHub']);
const TMUX_TERMINAL_KEYS = { AgentHub: 'M-a' };

function validatedTerminalKeys(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(key => TERMINAL_KEYS.has(key))
    ? value
    : null;
}

function sendTerminalKeys(sessionId, keys) {
  execFileSync('tmux', ['send-keys', '-t', tmuxName(sessionId), ...keys.map(key => TMUX_TERMINAL_KEYS[key] || key)], { stdio: 'ignore' });
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
  try {
    if (isRalphSession(req.params.id)) resumeRalphSession(req.params.id);
    else resumeSession(req.params.id, req.body?.cwd);
    res.json({ ok: true });
  } catch (e) { res.status(protocolErrorStatus(e)).json({ error: e.message }); }
});

app.post('/api/sessions/:id/ralph', (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') throw httpError(400, 'enabled must be a boolean');
    if (req.body.enabled) resumeRalphSession(req.params.id);
    else stopRalphSession(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(protocolErrorStatus(e)).json({ error: e.message }); }
});

app.post('/api/sessions/:id/interrupt', (req, res) => {
  const isRalph = isRalphSession(req.params.id);
  if (isRalph) stopRalphSession(req.params.id);
  try {
    execFileSync('tmux', ['send-keys', '-t', tmuxName(req.params.id), 'C-c'], { stdio: 'ignore' });
    res.json({ ok: true });
  } catch (e) {
    if (isRalph) res.json({ ok: true });
    else res.status(500).json({ error: e.message });
  }
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
      try { fs.rmSync(path.join(OMP_AGENT_DIRS, id), { recursive: true, force: true }); } catch {}
    } else {
      const fpath = findJsonlPath(id, agent);
      if (fpath) fs.unlinkSync(fpath);
    }
    cancelRalphCallback(id);
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
function sessionCwdForFork(id, agent) {
  if (agent === 'omp') return getOmpSessionCwd(id) || HOME;
  const fpath = findJsonlPath(id, agent);
  if (!fpath) return HOME;
  try {
    const head = fs.readFileSync(fpath).subarray(0, 256 * 1024);
    return extractSessionCwd(head, agent) || HOME;
  } catch {
    return HOME;
  }
}

function createForkWorkspace(sourceCwd, id, requestedMode) {
  if (requestedMode !== 'isolated') return { cwd: sourceCwd, mode: 'shared', path: null, branch: null, repo: null };
  let repo;
  try {
    repo = execFileSync('git', ['-C', sourceCwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return { cwd: sourceCwd, mode: 'shared', path: null, branch: null, repo: null, notice: 'Source is not a Git workspace; using the shared workspace.' };
  }
  const root = path.join(HOME, '.feather', 'fork-worktrees');
  const worktree = path.join(root, id);
  const branch = `feather/fork-${id.slice(0, 8)}`;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', branch, worktree, 'HEAD'], { stdio: 'ignore' });
  return { cwd: worktree, mode: 'isolated', path: worktree, branch, repo };
}

function removeFailedForkWorkspace(workspace) {
  if (workspace?.mode !== 'isolated' || !workspace.repo || !workspace.path) return;
  try { execFileSync('git', ['-C', workspace.repo, 'worktree', 'remove', '--force', workspace.path], { stdio: 'ignore' }); } catch {}
  try { execFileSync('git', ['-C', workspace.repo, 'branch', '-D', workspace.branch], { stdio: 'ignore' }); } catch {}
}

app.post('/api/sessions/:id/fork', (req, res) => {
  const sourceId = req.params.id;
  const newId = randomUUID();
  let workspace = null;
  let sourceRoom = null;
  try {
    const agent = getAgentForSession(sourceId);
    if (!['claude', 'codex', 'omp'].includes(agent)) throw httpError(400, `unsupported fork agent: ${agent}`);
    if (!findJsonlPath(sourceId, agent) && agent !== 'omp') throw httpError(404, 'source session not found');
    if (agent === 'omp' && !findOmpJsonlPath(sourceId)) throw httpError(404, 'source session not found');
    const title = String(req.body?.title || '').trim();
    if (!title || title.length > 120) throw httpError(400, 'fork title must be 1-120 characters');
    const requestedMode = req.body?.workspaceMode === 'shared' ? 'shared' : 'isolated';
    const sourceCwd = sessionCwdForFork(sourceId, agent);
    workspace = createForkWorkspace(sourceCwd, newId, requestedMode);
    sourceRoom = roomNameForSession(sourceId);
    const sourceMeta = readMeta()[sourceId] || {};
    const sourceSession = discoverSessions(0, null, [sourceId]).find(candidate => candidate.id === sourceId);
    const metadata = {
      agent,
      title,
      forkOf: sourceId,
      forkedAt: new Date().toISOString(),
      forkSourceTitle: sourceSession?.title || sourceMeta.title || sourceId.slice(0, 8),
      forkWorkspaceMode: workspace.mode,
      ...(workspace.path ? { forkWorkspace: workspace.path, forkBranch: workspace.branch } : {}),
      ...(sourceMeta.ompModel ? { ompModel: sourceMeta.ompModel } : {}),
    };
    validateFreshSessionId(newId);
    updateMeta(meta => ({ ...meta, [newId]: metadata }));
    if (sourceRoom) ROOM_ASSIGN_STATE.update(current => ({ ...current, [newId]: sourceRoom }));
    const forkPromptFile = writeForkRolePrompt(newId, sourceRoom, title);

    if (agent === 'omp') {
      launchOmpSession(newId, workspace.cwd, { forkFrom: sourceId, appendSystemPromptFile: forkPromptFile });
    } else if (agent === 'codex') {
      const sourceCodexId = sourceMeta.codexUuid || sourceId;
      const before = new Set(listCodexJsonlFiles().map(file => file.uuid));
      ensureCodexTrust(workspace.cwd);
      const command = [
        'codex fork',
        shellQuote(sourceCodexId),
        '-C', shellQuote(workspace.cwd),
        '-c check_for_update_on_startup=false',
        '--dangerously-bypass-approvals-and-sandbox',
        shellQuote(`This is the ordinary forked work chat "${title}"${sourceRoom ? ` inside #${sourceRoom}` : ''}. You inherited context, not Leader/resident/controller authority. Wait for the user’s next message.`),
      ].join(' ');
      launchInTmux(tmuxName(newId), `bash --rcfile ~/.bashrc -ic ${shellQuote(command)}`, workspace.cwd);
      adoptNewCodexUuid(newId, before, workspace.cwd);
    } else {
      ensureClaudeTrust(workspace.cwd);
      const args = [
        'claude',
        `--resume ${shellQuote(sourceId)}`,
        '--fork-session',
        `--session-id ${shellQuote(newId)}`,
        `--append-system-prompt-file ${shellQuote(forkPromptFile)}`,
        '--dangerously-skip-permissions',
        '--disallowed-tools AskUserQuestion',
      ].join(' ');
      launchInTmux(tmuxName(newId), `bash --rcfile ~/.bashrc -ic ${shellQuote(args)}`, workspace.cwd);
    }
    roomSnapshotCache.invalidate();
    res.json({ id: newId, status: 'starting', room: sourceRoom, workspaceMode: workspace.mode, workspacePath: workspace.path, notice: workspace.notice || null });
  } catch (error) {
    updateMeta(meta => {
      if (!(newId in meta)) return meta;
      const next = { ...meta };
      delete next[newId];
      return next;
    });
    if (sourceRoom) ROOM_ASSIGN_STATE.update(current => {
      const next = { ...current };
      delete next[newId];
      return next;
    });
    removeFailedForkWorkspace(workspace);
    res.status(error.status || 500).json({ error: error.message });
  }
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
    prepareRalphForHumanInput(t.sessionId);
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
  const { messages, hasMore, cursor, nextBefore } = getMessages(req.params.id, parseInt(req.query.limit) || 100, parseInt(req.query.before) || 0);
  res.json({ messages, hasMore, cursor, nextBefore });
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
const ROOM_LEADER_WAKES_FILE = STATE_PATHS.coordination.roomLeaderWakesFile;
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
      // Optional wake schedule: how often Feather pings the resident with
      // "if there is something to do, do it". Absent or null means only
      // Sidecar or the user wakes it.
      const wakeMs = resident.wakeIntervalMs;
      if (wakeMs !== undefined && wakeMs !== null && !(Number.isFinite(wakeMs) && wakeMs >= 60_000 && wakeMs <= 8.64e15)) return false;
      const nextMs = resident.nextWakeAtMs;
      if (nextMs !== undefined && nextMs !== null && !(Number.isFinite(nextMs) && nextMs >= 0 && nextMs <= 8.64e15)) return false;
      const lastAt = resident.lastWakeAt;
      if (lastAt !== undefined && lastAt !== null && (typeof lastAt !== 'string' || !Number.isFinite(Date.parse(lastAt)))) return false;
      // Paused residents keep their session but get no scheduled wakes until
      // the user resumes the Room.
      if (resident.paused !== undefined && typeof resident.paused !== 'boolean') return false;
    }
  }
  return true;
}
const ROOM_RESIDENTS_STATE = createJsonState({
  file: ROOM_RESIDENTS_FILE, root: path.dirname(ROOM_RESIDENTS_FILE), document: 'Room residents',
  defaultValue: {}, validate: isRoomResidentState,
});
// Leader wakes (Room autonomy): per Room, how often Feather wakes the Leader
// to work its FRONTIER.md, plus the usage-limit fallback it is running on.
function isRoomLeaderWakeState(value) {
  if (!isJsonRecord(value)) return false;
  return Object.values(value).every((entry) => {
    if (!isJsonRecord(entry)) return false;
    if (entry.wakeIntervalMs !== null && !(Number.isFinite(entry.wakeIntervalMs) && entry.wakeIntervalMs > 0)) return false;
    if (entry.nextWakeAtMs !== null && !(Number.isFinite(entry.nextWakeAtMs) && entry.nextWakeAtMs >= 0)) return false;
    if (entry.lastWakeAt !== null && (typeof entry.lastWakeAt !== 'string' || !Number.isFinite(Date.parse(entry.lastWakeAt)))) return false;
    if (typeof entry.paused !== 'boolean') return false;
    if (entry.fallbackAttempts !== undefined && !(Number.isFinite(entry.fallbackAttempts) && entry.fallbackAttempts >= 0)) return false;
    if (entry.judgeDue !== undefined && typeof entry.judgeDue !== 'boolean') return false;
    if (entry.lastJudgeAt !== undefined && entry.lastJudgeAt !== null
      && (typeof entry.lastJudgeAt !== 'string' || !Number.isFinite(Date.parse(entry.lastJudgeAt)))) return false;
    if (entry.fallback === null || entry.fallback === undefined) return true;
    const fallback = entry.fallback;
    return isJsonRecord(fallback)
      && typeof fallback.model === 'string' && typeof fallback.primaryModel === 'string'
      && typeof fallback.since === 'string' && Number.isFinite(Date.parse(fallback.since))
      && Number.isFinite(fallback.retryAtMs)
      && (fallback.reason === null || typeof fallback.reason === 'string')
      && Number.isFinite(fallback.attempts);
  });
}
const ROOM_LEADER_WAKES_STATE = createJsonState({
  file: ROOM_LEADER_WAKES_FILE, root: path.dirname(ROOM_LEADER_WAKES_FILE), document: 'Room Leader wakes',
  defaultValue: {}, validate: isRoomLeaderWakeState,
});
function leaderWakeRecord(current = {}, changes = {}) {
  return {
    wakeIntervalMs: current.wakeIntervalMs ?? null,
    nextWakeAtMs: current.nextWakeAtMs ?? null,
    lastWakeAt: current.lastWakeAt ?? null,
    paused: current.paused === true,
    fallback: current.fallback ?? null,
    fallbackAttempts: current.fallbackAttempts ?? 0,
    judgeDue: current.judgeDue === true,
    lastJudgeAt: current.lastJudgeAt ?? null,
    ...changes,
  };
}
function ensureRoomFrontier(name) {
  const file = path.join(ROOMS_HOME_DIR, name, 'FRONTIER.md');
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, frontierTemplate(name));
  return true;
}
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
  file: ROOM_PULSES_FILE, root: path.dirname(ROOM_PULSES_FILE), document: 'Room status state',
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
    && !/^(Keep working|Status): #/.test(String(session.title || ''));
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
        `Wait (only when you have just asked someone a question): sidecar wait ${groupFlag} --from <role> --count 1 --timeout 120`,
        'Sidecar messages addressed to you are delivered into this chat automatically, so never sit in an open-ended `sidecar wait`.',
        'Your charter (see the ROLE.md file named in AGENTS.md) says what a wake is; wake prompts arrive on schedule. Finish every turn, and end it with RALPH_COMPLETE when there is nothing left to do.',
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
        return {
          role: m.role,
          text: text.slice(0, 200),
          id: typeof m.uuid === 'string' ? m.uuid : null,
          timestamp: typeof m.timestamp === 'string' ? m.timestamp : null,
        };
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

let frictionComplaintsCache = { signature: null, complaints: [] };
function readFrictionComplaints() {
  const notesPath = path.join(ROOMS_HOME_DIR, 'friction', 'notes.md');
  try {
    const stat = fs.statSync(notesPath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (frictionComplaintsCache.signature === signature) return frictionComplaintsCache.complaints;
    const complaints = parseFrictionNotes(fs.readFileSync(notesPath, 'utf8'));
    frictionComplaintsCache = { signature, complaints };
    return complaints;
  } catch {
    return frictionComplaintsCache.complaints;
  }
}

// `count` is the open complaints; resolved ones stay in the list so the feed
// can show what closed, but they no longer count against the Room.
function roomFrictionSummary(name, complaints) {
  const matching = complaints.filter(complaint => complaint.source === name);
  const open = openFrictionComplaints(matching);
  const newest = open[open.length - 1] || null;
  return {
    count: open.length,
    resolvedCount: matching.length - open.length,
    latestAt: newest?.timestamp || null,
    latest: newest?.summary || null,
  };
}

// The mission sentence lives in AGENTS.md. Cached per room by file signature
// so a snapshot rebuild costs one stat per room, not a read.
const roomMissionCache = new Map();
function readRoomMission(name) {
  const agentsPath = path.join(ROOMS_HOME_DIR, name, 'AGENTS.md');
  try {
    const stat = fs.statSync(agentsPath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const cached = roomMissionCache.get(name);
    if (cached && cached.signature === signature) return cached.mission;
    const mission = parseRoomMission(fs.readFileSync(agentsPath, 'utf8'));
    roomMissionCache.set(name, { signature, mission });
    return mission;
  } catch {
    return null;
  }
}

function leaderWakeFields(entry) {
  const record = leaderWakeRecord(entry);
  return {
    wakeIntervalMs: record.wakeIntervalMs,
    nextWakeAtMs: record.paused ? null : record.nextWakeAtMs,
    lastWakeAt: record.lastWakeAt,
    paused: record.paused,
  };
}
function leaderWakeSummary(entry) {
  const record = leaderWakeRecord(entry);
  return {
    ...leaderWakeFields(record),
    enabled: Boolean(record.wakeIntervalMs) && !record.paused,
    judgeDue: record.judgeDue,
    lastJudgeAt: record.lastJudgeAt,
    fallback: record.fallback ? {
      model: record.fallback.model,
      primaryModel: record.fallback.primaryModel,
      since: record.fallback.since,
      reason: record.fallback.reason,
      retryAt: new Date(record.fallback.retryAtMs).toISOString(),
    } : null,
  };
}

function buildRoomsSnapshot() {
  const names = listRoomDirs();
  const assignments = readRoomAssignments();
  const leaders = ROOM_LEADERS_STATE.read();
  const residentState = ROOM_RESIDENTS_STATE.read();
  const leaderWakeState = ROOM_LEADER_WAKES_STATE.read();
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
        && !/^(Keep working|Status): #/.test(String(session.title || ''));
    const discoveredLeaderId = sessions.find((session) => session.id === requestedLeaderSessionId && isEligibleLeader(session))?.id
      || null;
    // A freshly appointed Leader has no transcript until its first turn, so
    // discovery cannot see it. Keep reporting it (status 'starting') while its
    // designation is valid, so a Room never looks leaderless right after
    // succession.
    const startingLeaderId = !discoveredLeaderId && requestedLeaderSessionId
      && requestedLeaderSessionId !== pulse.sessionId
      && assignments[requestedLeaderSessionId] === name
      && ['omp', 'claude'].includes(sessionMeta[requestedLeaderSessionId]?.agent)
      && (tmuxIsActive(requestedLeaderSessionId) || fs.existsSync(path.join(OMP_SESSIONS, requestedLeaderSessionId)))
      ? requestedLeaderSessionId
      : null;
    const leaderSessionId = discoveredLeaderId || startingLeaderId;
    const leaderSession = sessions.find((session) => session.id === leaderSessionId) || null;
    const residents = [];
    if (leaderSession) {
      residents.push({
        role: 'leader',
        sessionId: leaderSession.id,
        agent: leaderSession.agent,
        title: leaderSession.title,
        status: leaderSession.isActive ? 'working' : 'waiting',
        model: ompSessionModel(leaderSession.id),
        ...leaderTelemetry(leaderSession.id),
        ...leaderWakeFields(leaderWakeState[name]),
      });
    } else if (startingLeaderId) {
      residents.push({
        role: 'leader',
        sessionId: startingLeaderId,
        agent: sessionMeta[startingLeaderId]?.agent || 'omp',
        title: sessionMeta[startingLeaderId]?.title || `#${name}`,
        status: 'starting',
        model: ompSessionModel(startingLeaderId),
        ...leaderTelemetry(startingLeaderId),
        ...leaderWakeFields(leaderWakeState[name]),
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
        wakeIntervalMs: configured.wakeIntervalMs ?? null,
        nextWakeAtMs: configured.paused ? null : (configured.nextWakeAtMs ?? null),
        lastWakeAt: configured.lastWakeAt ?? null,
        paused: configured.paused === true,
      });
    }
    const configuredResidents = Object.values(residentState[name] || {});
    const residentsPaused = configuredResidents.length > 0 && configuredResidents.every((resident) => resident.paused === true);
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
      mission: readRoomMission(name),
      sessions,
      leaderSessionId,
      residents,
      residentsPaused,
      leaderWake: leaderWakeSummary(leaderWakeState[name]),
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

function roomSessionContext(id) {
  const meta = readMeta()[id] || {};
  const lineage = {
    forkOf: meta.forkOf || null,
    forkSourceTitle: meta.forkSourceTitle || null,
    workspaceMode: meta.forkWorkspaceMode || null,
    forkBranch: meta.forkBranch || null,
  };
  const room = roomNameForSession(id);
  if (!room) {
    const session = discoverSessions(0, null, [id]).find(candidate => candidate.id === id);
    return { room: null, kind: session || meta.title ? 'chat' : null, role: null, label: meta.title || session?.title || null, ...lineage };
  }
  const leaderId = ROOM_LEADERS_STATE.read()[room] || null;
  if (leaderId === id) return { room, kind: 'main', role: 'leader', label: 'Main', ...lineage };
  const resident = Object.entries(ROOM_RESIDENTS_STATE.read()[room] || {})
    .find(([, configured]) => configured.sessionId === id);
  if (resident) return { room, kind: 'resident', role: resident[0], label: resident[0], ...lineage };
  const pulseId = ROOM_PULSES_STATE.read()[room]?.sessionId || null;
  if (pulseId === id) return { room, kind: 'status', role: 'status', label: 'Status', ...lineage };
  if (meta.title) return { room, kind: 'chat', role: null, label: meta.title, ...lineage };
  const session = discoverSessions(0, null, [id]).find(candidate => candidate.id === id);
  return { room, kind: 'chat', role: null, label: session?.title || 'Chat', ...lineage };
}

app.get('/api/sessions/:id/room', (req, res) => {
  try { res.json(roomSessionContext(req.params.id)); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/rooms/:name/send', async (req, res) => {
  try {
    const targetRoom = req.params.name;
    const sourceRoom = String(req.body?.fromRoom || '').trim().replace(/^#/, '');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!listRoomDirs().includes(targetRoom)) throw httpError(404, 'no such target room');
    if (!ROOM_NAME_RE.test(sourceRoom) || !listRoomDirs().includes(sourceRoom)) throw httpError(400, 'invalid source room');
    if (sourceRoom === targetRoom) throw httpError(400, 'source and target rooms must differ');
    if (!text) throw httpError(400, 'message text is required');
    if (text.length > SIDECAR_MESSAGE_MAX_CHARS) throw httpError(413, `message exceeds ${SIDECAR_MESSAGE_MAX_CHARS} characters`);
    const leaderId = ROOM_LEADERS_STATE.read()[targetRoom] || null;
    if (!leaderId || !validRoomLeaderDesignation(targetRoom, leaderId)) throw httpError(409, `#${targetRoom} has no available Leader`);
    if (!tmuxIsActive(leaderId)) {
      resumeSession(leaderId, path.join(ROOMS_HOME_DIR, targetRoom));
      for (let attempt = 0; attempt < 30 && !tmuxIsActive(leaderId); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!tmuxIsActive(leaderId)) throw httpError(503, `#${targetRoom} Leader did not become ready`);
    const requestedId = req.get('X-Feather-Message-ID');
    const messageId = requestedId || randomUUID().replaceAll('-', '');
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(messageId)) throw httpError(400, 'invalid message id');
    const tagged = [
      `[Cross-Room · #${sourceRoom} → #${targetRoom}]`,
      '',
      text,
      '',
      `_Reply with: room send ${sourceRoom} --stdin_`,
    ].join('\n');
    const receipt = await sendInputIdempotent(leaderId, tagged, messageId);
    res.json({ ok: true, fromRoom: sourceRoom, room: targetRoom, leaderSessionId: leaderId, sentAt: receipt.sentAt });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/rooms', (_req, res) => {
  try { res.json({ rooms: roomSnapshotCache.get() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

function followedFeedRooms(rooms) {
  const available = rooms.map(room => room.name);
  const configured = FEED_PREFERENCES_STATE.read().rooms;
  return Array.isArray(configured)
    ? configured.filter(room => available.includes(room))
    : available;
}

function roomFeedPublications(rooms) {
  return rooms.flatMap((room) => {
    const roomRoot = path.join(ROOMS_HOME_DIR, room.name);
    try {
      return readRoomPublications(roomRoot, room.name).map((publication) => {
        if (!publication.visual) return publication;
        try {
          verifiedPublicationVisual(roomRoot, publication.visual);
          return {
            ...publication,
            visualHref: `/api/rooms/${encodeURIComponent(room.name)}/publications/${encodeURIComponent(publication.id)}/visual`,
          };
        } catch {
          return { ...publication, visual: null, visualAlt: null };
        }
      });
    } catch (error) {
      console.warn(`[super-feed] could not read #${room.name} publications:`, error.message);
      return [];
    }
  });
}



let feedHistory = [];
function buildFeedProjection() {
  const rooms = roomSnapshotCache.get();
  const current = buildSuperFeed({
    rooms,
    complaints: readFrictionComplaints(),
    publications: roomFeedPublications(rooms),
  });

  feedHistory = mergeSuperFeed(feedHistory, current, rooms);
  const items = attachFeedComments(feedHistory);
  return {
    items,
    cursor: superFeedCursor(items),
    generatedAt: new Date().toISOString(),
  };
}

function attachFeedComments(items) {
  const byEvidence = new Map();
  for (const comment of FEED_COMMENTS_STATE.read().comments) {
    const list = byEvidence.get(comment.evidenceId) || [];
    list.push(publicFeedComment(comment));
    byEvidence.set(comment.evidenceId, list);
  }
  return items.map(item => ({ ...item, comments: byEvidence.get(item.evidenceId) || [] }));
}

async function readyRoomLeader(roomName) {
  const leaderId = ROOM_LEADERS_STATE.read()[roomName] || null;
  if (!leaderId || !validRoomLeaderDesignation(roomName, leaderId)) throw httpError(409, `#${roomName} has no available Leader`);
  if (!tmuxIsActive(leaderId)) {
    resumeSession(leaderId, path.join(ROOMS_HOME_DIR, roomName));
    for (let attempt = 0; attempt < 30 && !tmuxIsActive(leaderId); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!tmuxIsActive(leaderId)) throw httpError(503, `#${roomName} Leader did not become ready`);
  return leaderId;
}
const feedSnapshotCache = createSnapshotCache(buildFeedProjection, { ttlMs: 10_000 });


// Costs: local token ledger from every harness transcript on this box plus
// each provider's own view of the account limits.
const usageLedger = createUsageLedger({
  claudeProjectsDir: CLAUDE_PROJECTS,
  ompSessionsDir: OMP_SESSIONS,
  codexSessionsDir: CODEX_SESSIONS_ROOT,
  roomsDir: ROOMS_HOME_DIR,
  readAssignments: readRoomAssignments,
});
const providerLimits = createProviderLimits({
  ompAuthFile: path.join(HOME, '.omp/agent/auth.json'),
  claudeCredentialsFile: path.join(HOME, '.claude/.credentials.json'),
  keyvaultFile: process.env.FEATHER_KEYVAULT || path.join(HOME, 'keyvault.txt'),
  cacheFile: STATE_PATHS.instance.providerLimitsFile,
  brokerUrl: process.env.OMP_AUTH_BROKER_URL || 'http://127.0.0.1:8765',
  brokerTokenFile: path.join(HOME, '.omp/auth-broker.token'),
});
const USAGE_SNAPSHOT_TTL_MS = 60_000;
let usageSnapshot = null;
let usageSnapshotPending = null;
async function buildUsageSnapshot() {
  const startedAt = Date.now();
  const scan = usageLedger.scan();
  const providers = await providerLimits.snapshot({ codexRateLimits: scan.codexRateLimits });
  return {
    generatedAt: new Date(startedAt).toISOString(),
    scanMs: Date.now() - startedAt,
    files: scan.files,
    windows: summarizeUsage(scan.events, { now: startedAt }),
    providers,
  };
}
app.get('/api/usage', async (req, res) => {
  try {
    const fresh = usageSnapshot && Date.now() - Date.parse(usageSnapshot.generatedAt) < USAGE_SNAPSHOT_TTL_MS && req.query.refresh !== '1';
    if (!fresh) {
      if (!usageSnapshotPending) usageSnapshotPending = buildUsageSnapshot().finally(() => { usageSnapshotPending = null; });
      usageSnapshot = await usageSnapshotPending;
    }
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(usageSnapshot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/feed', (req, res) => {
  try {
    const rooms = roomSnapshotCache.get();
    const projection = feedSnapshotCache.get();
    const following = followedFeedRooms(rooms);
    const preferenceCursor = createHash('sha256').update(JSON.stringify(following)).digest('hex').slice(0, 12);
    const etag = `\"${projection.cursor}-${preferenceCursor}\"`;
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.json({ ...projection, following });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/feed/following', (req, res) => {
  try {
    const rooms = roomSnapshotCache.get();
    const room = String(req.body?.room || '').trim().replace(/^#/, '');
    if (!rooms.some(candidate => candidate.name === room)) throw httpError(404, 'no such room');
    if (typeof req.body?.following !== 'boolean') throw httpError(400, 'following must be boolean');
    const current = new Set(followedFeedRooms(rooms));
    if (req.body.following) current.add(room);
    else current.delete(room);
    const following = rooms.map(candidate => candidate.name).filter(name => current.has(name));
    const state = FEED_PREFERENCES_STATE.read();
    FEED_PREFERENCES_STATE.write({ ...state, rooms: following });
    res.json({ ok: true, following });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// A comment on a feed card goes to the Room's replyguy resident as chat (the
// Leader when the Room has none); the reply comes back through the feed
// projection (see attachFeedComments).
function feedCommentResponder(roomName) {
  const replyguy = ROOM_RESIDENTS_STATE.read()[roomName]?.replyguy;
  if (replyguy?.sessionId && readMeta()[replyguy.sessionId]?.mode === RALPH_MODE) {
    return { sessionId: replyguy.sessionId, role: 'replyguy' };
  }
  return null;
}
app.post('/api/feed/comments', async (req, res) => {
  try {
    const evidenceId = String(req.body?.evidenceId || '').trim();
    if (!evidenceId || evidenceId.length > 500) throw httpError(400, 'evidenceId is required');
    let text;
    try { text = normalizeFeedCommentText(req.body?.text); }
    catch (error) { throw httpError(400, error.message); }
    if (!text) throw httpError(400, 'comment text is required');
    const item = feedSnapshotCache.get().items.find(candidate => candidate.evidenceId === evidenceId);
    if (!item) throw httpError(404, 'no such feed item');
    const roomName = item.room;
    if (!listRoomDirs().includes(roomName)) throw httpError(404, 'no such room');
    const leaderId = await readyRoomLeader(roomName);
    const responder = feedCommentResponder(roomName);
    const responderId = responder?.sessionId || leaderId;
    const commentId = randomUUID().replaceAll('-', '');
    const prompt = feedCommentPrompt({ commentId, roomName, item, text });
    if (responder) {
      prepareRalphForHumanInput(responderId);
      await ensureResidentRunning(responderId, roomName);
    }
    const receipt = await sendInputIdempotent(responderId, prompt, commentId);
    const comment = {
      id: commentId, evidenceId, room: roomName, text, createdAt: receipt.sentAt || new Date().toISOString(),
      leaderSessionId: leaderId, responderSessionId: responderId, responderRole: responder?.role || 'leader',
    };
    FEED_COMMENTS_STATE.update((current) => ({ comments: [...current.comments, comment].slice(-FEED_COMMENTS_MAX) }));
    feedSnapshotCache.refresh();
    scheduleFeedCommentDeliveryCheck({ leaderId: responderId, commentId, prompt });
    scheduleFeedReplyNudge({ leaderId: responderId, commentId, roomName, text });
    res.status(201).json({ ok: true, comment: publicFeedComment(comment) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// A pasted prompt can vanish when the Leader's agent is busy or restarting
// (seen 2026-09-06: the receipt said sent, the transcript never got it). Look
// for the tagged prompt in the transcript after a delay and re-send once.
const FEED_COMMENT_DELIVERY_CHECK_MS = Number(process.env.FEATHER_FEED_COMMENT_CHECK_MS || 25_000);
function scheduleFeedCommentDeliveryCheck({ leaderId, commentId, prompt }) {
  if (!(FEED_COMMENT_DELIVERY_CHECK_MS > 0)) return;
  const timer = setTimeout(async () => {
    try {
      const { messages } = getMessages(leaderId, 60);
      if (commentDelivered(messages, commentId)) return;
      console.warn(`[feed] comment ${commentId} not seen in Leader ${leaderId.slice(0, 8)} transcript; re-sending once`);
      await sendInputIdempotent(leaderId, prompt, `${commentId}-retry`);
    } catch (error) {
      console.warn(`[feed] comment ${commentId} delivery check failed: ${error.message}`);
    }
  }, FEED_COMMENT_DELIVERY_CHECK_MS);
  timer.unref?.();
}

// A Leader that reads a comment and starts researching can take an hour to
// answer (seen 2026-09-06, #trading). Remind it once if the card is still
// unanswered after a while.
const FEED_REPLY_NUDGE_MS = Number(process.env.FEATHER_FEED_REPLY_NUDGE_MS || 10 * 60_000);
function scheduleFeedReplyNudge({ leaderId, commentId, roomName, text }) {
  if (!(FEED_REPLY_NUDGE_MS > 0)) return;
  const timer = setTimeout(async () => {
    try {
      const stored = FEED_COMMENTS_STATE.read().comments.find((comment) => comment.id === commentId);
      if (!stored || stored.reply) return;
      console.warn(`[feed] comment ${commentId} unanswered after ${FEED_REPLY_NUDGE_MS}ms; nudging Leader ${leaderId.slice(0, 8)}`);
      await sendInputIdempotent(leaderId, feedReplyNudgePrompt({ commentId, roomName, text }), `${commentId}-nudge`);
    } catch (error) {
      console.warn(`[feed] comment ${commentId} nudge failed: ${error.message}`);
    }
  }, FEED_REPLY_NUDGE_MS);
  timer.unref?.();
}

// The Room's answer to a comment. The Leader runs `room reply <id> ...`;
// the id is a capability in itself (32 random hex chars from the tagged
// prompt), so no further authentication is required. Last reply wins.
app.post('/api/feed/comments/:id/reply', (req, res) => {
  try {
    const { id } = req.params;
    if (!FEED_COMMENT_ID_RE.test(id)) throw httpError(400, 'invalid comment id');
    let text;
    try { text = normalizeFeedReplyText(req.body?.text); }
    catch (error) { throw httpError(400, error.message); }
    if (!text) throw httpError(400, 'reply text is required');
    const reply = { text, timestamp: new Date().toISOString() };
    let updated = null;
    FEED_COMMENTS_STATE.update((current) => ({
      comments: current.comments.map((comment) => {
        if (comment.id !== id) return comment;
        updated = { ...comment, reply };
        return updated;
      }),
    }));
    if (!updated) throw httpError(404, 'no such comment');
    feedSnapshotCache.refresh();
    res.json({ ok: true, comment: publicFeedComment(updated) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
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
function requireRoomUpdaterCapability(req, roomName) {
  const sessionId = String(req.get('X-Feather-Session-ID') || '');
  const updater = ROOM_RESIDENTS_STATE.read()[roomName]?.updater;
  if (!updater || updater.sessionId !== sessionId
    || !bridgeTokenValid(sessionId, req.get('X-Feather-Bridge-Token'))
    || readMeta()[sessionId]?.mode !== RALPH_MODE) {
    throw httpError(403, 'invalid Room updater capability');
  }
  return sessionId;
}

app.post('/api/internal/rooms/:name/publications', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const publisherSessionId = requireRoomUpdaterCapability(req, name);
    const result = appendRoomPublication({
      roomRoot: path.join(ROOMS_HOME_DIR, name),
      roomName: name,
      publisherSessionId,
      input: req.body,
    });
    feedSnapshotCache.refresh();
    res.status(result.reused ? 200 : 201).json({ ok: true, ...result });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/rooms/:name/publications/:id', (req, res) => {
  try {
    const { name, id } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const publication = readRoomPublications(path.join(ROOMS_HOME_DIR, name), name)
      .find(candidate => candidate.id === id);
    if (!publication) throw httpError(404, 'no such publication');
    res.json({ publication });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/rooms/:name/publications/:id/visual', (req, res) => {
  try {
    const { name, id } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const roomRoot = path.join(ROOMS_HOME_DIR, name);
    const publication = readRoomPublications(roomRoot, name).find(candidate => candidate.id === id);
    if (!publication?.visual) throw httpError(404, 'visual not found');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(verifiedPublicationVisual(roomRoot, publication.visual), { dotfiles: 'deny' });
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

// Scaffold a new Room from the template and, when a mission is given, staff
// it: one OMP Leader plus the standard Ralph residents (caretaker, updater,
// marketer). The mission sentence is stamped verbatim into AGENTS.md, the
// Wiki, notes.md, and the Leader's first message.
// New Room Leaders default to Claude Fable unless the caller names a model.
const ROOM_LEADER_DEFAULT_MODEL = sanitizeOmpModel(process.env.FEATHER_ROOM_LEADER_MODEL ?? 'anthropic/claude-fable-5-1');
const ROOM_KICKOFF_DELAY_MS = Math.max(0, Number(process.env.FEATHER_ROOM_KICKOFF_DELAY_MS) || 8_000);
// Room autonomy: the Leader wake floor, and the models a Leader falls back to
// (in order) when its provider reports a usage limit. Empty disables fallback.
const ROOM_LEADER_WAKE_MIN_MS = Math.max(1, Number(process.env.FEATHER_ROOM_LEADER_WAKE_MIN_MS) || 5 * 60_000);
const ROOM_LEADER_FALLBACK_MODELS = String(process.env.FEATHER_ROOM_LEADER_FALLBACK_MODELS ?? 'openai-codex/gpt-5.6-sol')
  .split(',').map((model) => sanitizeOmpModel(model.trim())).filter(Boolean);
const ROOM_LEADER_FALLBACK_RETRY_MS = Math.max(1, Number(process.env.FEATHER_ROOM_LEADER_FALLBACK_RETRY_MS) || 60 * 60_000);
const ROOM_LEADER_FALLBACK_RETRY_MAX_MS = Math.max(ROOM_LEADER_FALLBACK_RETRY_MS, Number(process.env.FEATHER_ROOM_LEADER_FALLBACK_RETRY_MAX_MS) || 6 * 60 * 60_000);
// The judge runs on the other harness by default so the critic never shares
// the Leader's blind spots (Council and the h5i court do the same).
const ROOM_JUDGE_MODEL = sanitizeOmpModel(process.env.FEATHER_ROOM_JUDGE_MODEL ?? 'openai-codex/gpt-5.6-sol');
function residentModelFor(role) {
  return role === 'judge' ? ROOM_JUDGE_MODEL : '';
}
// Gateway-backed sessions have private agent.db files and can start together.
// Keep the legacy delay only when the deployment has not enabled isolation.
const ROOM_STAFF_STAGGER_MS = Math.max(0, Number(
  process.env.FEATHER_ROOM_STAFF_STAGGER_MS ?? (OMP_AUTH_GATEWAY_URL ? 0 : 2_500),
));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function staffRoom(name, mission) {
  const cwd = path.join(ROOMS_HOME_DIR, name);
  const leader = createSessionForRequest({ id: randomUUID(), cwd, agent: 'omp', roomName: name, roomRole: 'leader' });
  const residents = [];
  for (const spec of ROOM_STANDARD_RESIDENTS) {
    if (ROOM_STAFF_STAGGER_MS) await sleep(ROOM_STAFF_STAGGER_MS);
    const created = createSessionForRequest({
      id: randomUUID(), cwd, agent: 'omp', mode: RALPH_MODE, model: residentModelFor(spec.role),
      roomName: name, roomRole: spec.role, wakeIntervalMs: spec.wakeIntervalMs,
    });
    updateMeta((meta) => ({ ...meta, [created.id]: { ...(meta[created.id] || {}), title: `${spec.role}: #${name}` } }));
    residents.push({ role: spec.role, sessionId: created.id, wakeIntervalMs: spec.wakeIntervalMs });
  }
  updateMeta((meta) => ({ ...meta, [leader.id]: { ...(meta[leader.id] || {}), title: `#${name}` } }));
  // The caretaker covers what the status reporter used to; keep the Room
  // pulse quiet so a fresh Room runs four sessions, not five.
  ROOM_PULSES_STATE.update((current) => ({
    ...current,
    [name]: pulseRecord(current[name], { enabled: false, status: 'paused', nextRunAtMs: null, error: null }),
  }));
  const kickoff = leaderKickoffPrompt({ roomName: name, mission });
  setTimeout(() => {
    sendInput(leader.id, kickoff)
      .catch((error) => console.warn(`[room] #${name} kickoff failed:`, error.message));
  }, ROOM_KICKOFF_DELAY_MS);
  return { leaderSessionId: leader.id, residents };
}

async function staffExistingRoom(name, specialistWakeIntervals = {}) {
  const cwd = path.join(ROOMS_HOME_DIR, name);
  if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
  const leaderSessionId = ROOM_LEADERS_STATE.read()[name] || null;
  if (!leaderSessionId || !validRoomLeaderDesignation(name, leaderSessionId)) {
    throw httpError(409, `#${name} has no available Leader`);
  }
  const configuredBefore = ROOM_RESIDENTS_STATE.read()[name] || {};
  for (const role of Object.keys(specialistWakeIntervals)) {
    if (!configuredBefore[role]) throw httpError(409, `#${name} has no existing ${role} specialist`);
  }
  for (const sub of ROOM_TEMPLATE_DIRS) fs.mkdirSync(path.join(cwd, sub), { recursive: true });
  const claudePath = path.join(cwd, 'CLAUDE.md');
  if (!fs.existsSync(claudePath)) fs.symlinkSync('AGENTS.md', claudePath);


  const files = roomTemplateFiles({ name, mission: readRoomMission(name) });
  for (const spec of ROOM_STANDARD_RESIDENTS) {
    fs.writeFileSync(path.join(cwd, spec.charter), files[spec.charter]);
  }

  const created = [];
  for (const spec of ROOM_STANDARD_RESIDENTS) {
    const before = ROOM_RESIDENTS_STATE.read()[name]?.[spec.role]?.sessionId || null;
    if (!before && ROOM_STAFF_STAGGER_MS) await sleep(ROOM_STAFF_STAGGER_MS);
    const resident = createSessionForRequest({
      id: randomUUID(), cwd, agent: 'omp', mode: RALPH_MODE, model: residentModelFor(spec.role),
      roomName: name, roomRole: spec.role, wakeIntervalMs: spec.wakeIntervalMs,
    });
    if (resident.status !== 'existing') created.push(spec.role);
  }

  const now = Date.now();
  ROOM_RESIDENTS_STATE.update((current) => {
    const residents = { ...(current[name] || {}) };
    for (const spec of ROOM_STANDARD_RESIDENTS) {
      const resident = residents[spec.role];
      if (!resident) throw httpError(500, `failed to register ${spec.role}`);
      residents[spec.role] = {
        ...resident,
        wakeIntervalMs: spec.wakeIntervalMs,
        nextWakeAtMs: spec.wakeIntervalMs ? now + spec.wakeIntervalMs : null,
        paused: false,
      };
    }
    for (const [role, wakeIntervalMs] of Object.entries(specialistWakeIntervals)) {
      residents[role] = {
        ...residents[role],
        wakeIntervalMs,
        nextWakeAtMs: now + wakeIntervalMs,
        paused: false,
      };
    }
    return { ...current, [name]: residents };
  });
  ROOM_PULSES_STATE.update((current) => ({
    ...current,
    [name]: pulseRecord(current[name], { enabled: false, status: 'paused', nextRunAtMs: null, error: null }),
  }));
  const configured = ROOM_RESIDENTS_STATE.read()[name];
  updateMeta((meta) => {
    const next = { ...meta };
    for (const [role, resident] of Object.entries(configured)) {
      next[resident.sessionId] = { ...(next[resident.sessionId] || {}), title: `${role}: #${name}` };
    }
    return next;
  });
  syncRoomSidecar(name, { primeNewResidents: true });
  const room = roomSnapshotCache.refresh().find((candidate) => candidate.name === name);
  return { leaderSessionId, residents: room?.residents || [], created };
}

app.post('/api/rooms', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!ROOM_NAME_RE.test(name)) throw httpError(400, 'bad room name (lowercase, digits, dashes)');
    let mission;
    try { mission = normalizeRoomMission(req.body?.mission); }
    catch (error) { throw httpError(400, error.message); }
    const staff = req.body?.staff === undefined ? Boolean(mission) : Boolean(req.body.staff);
    if (staff && !mission) throw httpError(400, 'a mission sentence is required to staff a room');
    const dir = path.join(ROOMS_HOME_DIR, name);
    if (fs.existsSync(dir)) throw httpError(409, 'room exists');
    fs.mkdirSync(dir, { recursive: true });
    const files = scaffoldRoom(dir, { name, mission });
    roomSnapshotCache.refresh();
    const staffing = staff ? await staffRoom(name, mission) : null;
    if (staffing) roomSnapshotCache.refresh();
    res.json({ name, cwd: dir, mission, files, ...(staffing || {}) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/rooms/:name/staff', async (req, res) => {
  try {
    const { name } = req.params;
    const specialists = req.body?.specialists ?? {};
    if (!isJsonRecord(specialists)) throw httpError(400, 'specialists must be an object');
    const specialistWakeIntervals = {};
    for (const [role, wakeIntervalMs] of Object.entries(specialists)) {
      if (!ROOM_RESIDENT_ROLE_RE.test(role) || ROOM_STANDARD_RESIDENTS.some((spec) => spec.role === role)) {
        throw httpError(400, 'specialists must name existing non-standard resident roles');
      }
      if (!Number.isFinite(wakeIntervalMs) || wakeIntervalMs < 60_000 || wakeIntervalMs > 8.64e15) {
        throw httpError(400, `invalid wake interval for ${role}`);
      }
      specialistWakeIntervals[role] = Math.floor(wakeIntervalMs);
    }
    res.json({ ok: true, ...(await staffExistingRoom(name, specialistWakeIntervals)) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
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
      throw httpError(409, `status reporter of #${pulseRoom} cannot be moved or detached`);
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


// Leader succession: distill the retiring Leader's chat into notes.md (via
// `room handoff`), retire it, and seat a fresh OMP Leader that starts from the
// handoff. The old chat stays assigned to the Room so its history is visible.
const ROOM_CLI = process.env.FEATHER_ROOM_CLI || path.join(import.meta.dirname, 'bin', 'room');
const ROOM_HANDOFF_TIMEOUT_MS = Math.max(10_000, Number(process.env.FEATHER_ROOM_HANDOFF_TIMEOUT_MS) || 10 * 60_000);
const roomSuccessions = new Set();

function runRoomHandoff(name, sessionId) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(ROOM_CLI, ['-r', name, 'handoff', sessionId], {
      cwd: path.join(ROOMS_HOME_DIR, name),
      env: { ...process.env, FEATHER_URL: `http://127.0.0.1:${PORT}`, ROOM_TIMEOUT: String(Math.floor(ROOM_HANDOFF_TIMEOUT_MS / 1000)) },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: ROOM_HANDOFF_TIMEOUT_MS,
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ ok: false, detail: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, detail: output.trim().slice(-2000) }));
  });
}

function successionPrompt(roomName, { retiredSessionId, handoff }) {
  return [
    `You are the new Leader of #${roomName}. Your predecessor (chat ${retiredSessionId || 'unknown'}) was retired and you start fresh.`,
    handoff === 'appended'
      ? 'Its handoff is the last "## Handoff" section in notes.md; read it first.'
      : 'No handoff was written; rely on notes.md and the wiki.',
    'Read AGENTS.md and notes.md, then reply with a short summary of the current state and open threads, and wait for the user.',
  ].join(' ');
}

async function succeedRoomLeader(name, { model = '', handoff = true, force = false, opening = null } = {}) {
  const cwd = path.join(ROOMS_HOME_DIR, name);
  if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
  if (roomSuccessions.has(name)) throw httpError(409, `#${name} succession already in progress`);
  const requestedModel = sanitizeOmpModel(model);
  if (model && !requestedModel) throw httpError(400, 'invalid model');
  roomSuccessions.add(name);
  try {
    const retiredSessionId = ROOM_LEADERS_STATE.read()[name] || null;
    let handoffStatus = 'skipped';
    let handoffDetail = null;
    if (retiredSessionId && handoff) {
      const result = await runRoomHandoff(name, retiredSessionId);
      handoffStatus = result.ok ? 'appended' : 'failed';
      handoffDetail = result.detail || null;
      if (!result.ok && !force) {
        throw httpError(502, `handoff failed; Leader kept (pass force to retire anyway): ${handoffDetail || 'no output'}`);
      }
    }
    if (retiredSessionId) {
      try { execFileSync('tmux', ['kill-session', '-t', tmuxName(retiredSessionId)], { stdio: 'ignore' }); } catch {}
      ROOM_LEADERS_STATE.update((current) => {
        if (current[name] !== retiredSessionId) return current;
        const next = { ...current };
        delete next[name];
        return next;
      });
    }
    const created = createSessionForRequest({
      id: randomUUID(), cwd, agent: 'omp', roomName: name, roomRole: 'leader', model: requestedModel,
    });
    updateMeta((meta) => ({ ...meta, [created.id]: { ...(meta[created.id] || {}), title: `#${name}` } }));
    roomSnapshotCache.refresh();
    const openingPrompt = typeof opening === 'function'
      ? opening({ retiredSessionId, handoff: handoffStatus })
      : successionPrompt(name, { retiredSessionId, handoff: handoffStatus });
    setTimeout(() => {
      sendInput(created.id, openingPrompt)
        .catch((error) => console.warn(`[room] #${name} succession opening failed:`, error.message));
    }, ROOM_KICKOFF_DELAY_MS);
    return {
      ok: true,
      retiredSessionId,
      leaderSessionId: created.id,
      model: ompSessionModel(created.id),
      handoff: handoffStatus,
      ...(handoffDetail ? { handoffDetail } : {}),
    };
  } finally {
    roomSuccessions.delete(name);
  }
}

app.post('/api/rooms/:name/leader/succeed', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.model !== undefined && typeof body.model !== 'string') throw httpError(400, 'model must be a string');
    res.json(await succeedRoomLeader(req.params.name, {
      model: body.model || '',
      handoff: body.handoff !== false,
      force: body.force === true,
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Pause or resume every scheduled resident of a Room. Paused residents keep
// their chats and can still be messaged; Feather just stops waking them.
app.post('/api/rooms/:name/residents/pause', (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    if (typeof req.body?.paused !== 'boolean') throw httpError(400, 'paused must be true or false');
    const paused = req.body.paused;
    const now = Date.now();
    ROOM_RESIDENTS_STATE.update((current) => {
      const residents = current[name];
      if (!residents) return current;
      const next = {};
      for (const [role, resident] of Object.entries(residents)) {
        const entry = { ...resident, paused };
        // Resuming re-arms the schedule from now so a long pause does not
        // wake every resident at once.
        if (!paused && Number.isFinite(resident.wakeIntervalMs)) entry.nextWakeAtMs = now + resident.wakeIntervalMs;
        next[role] = entry;
      }
      return { ...current, [name]: next };
    });
    const room = roomSnapshotCache.refresh().find((candidate) => candidate.name === name);
    res.json({ ok: true, paused, residents: room?.residents || [], residentsPaused: room?.residentsPaused ?? paused });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Room autonomy: how often Feather wakes the Leader to work FRONTIER.md.
// `wakeIntervalMs: null` switches it off; `now: true` sends one wake at once.
// The user steers a Room: the text lands as a dated line under Steering in
// FRONTIER.md (the one section agents never write), is noted, and the Leader
// is woken at once to re-plan around it. Works whether or not autonomy is on.
app.post('/api/rooms/:name/steer', async (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    let text;
    try { text = normalizeSteerText(req.body?.text); }
    catch (error) { throw httpError(400, error.message); }
    const now = Date.now();
    const at = new Date(now);
    ensureRoomFrontier(name);
    const frontierPath = path.join(ROOMS_HOME_DIR, name, 'FRONTIER.md');
    fs.writeFileSync(frontierPath, appendSteering(fs.readFileSync(frontierPath, 'utf8'), text, at));
    const stamp = at.toISOString().slice(0, 16).replace('T', ' ');
    fs.appendFileSync(path.join(ROOMS_HOME_DIR, name, 'notes.md'), `- ${stamp} [steer] ${text.replace(/\n/g, ' ')}\n`);
    const leaderSessionId = await wakeRoomLeader(name, now, { prompt: leaderSteerPrompt({ roomName: name, text, at }) });
    res.status(201).json({ ok: true, room: name, text, at: at.toISOString(), leaderSessionId, woke: Boolean(leaderSessionId) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/rooms/:name/leader/wake', async (req, res) => {
  try {
    const { name } = req.params;
    if (!listRoomDirs().includes(name)) throw httpError(404, 'no such room');
    const body = req.body || {};
    if (body.wakeIntervalMs !== undefined && body.wakeIntervalMs !== null
      && !(Number.isFinite(body.wakeIntervalMs) && body.wakeIntervalMs >= ROOM_LEADER_WAKE_MIN_MS)) {
      throw httpError(400, `wakeIntervalMs must be null or at least ${ROOM_LEADER_WAKE_MIN_MS}`);
    }
    if (body.paused !== undefined && typeof body.paused !== 'boolean') throw httpError(400, 'paused must be true or false');
    if (body.now !== undefined && typeof body.now !== 'boolean') throw httpError(400, 'now must be true or false');
    if (body.judge !== undefined && typeof body.judge !== 'boolean') throw httpError(400, 'judge must be true or false');
    const now = Date.now();
    ROOM_LEADER_WAKES_STATE.update((current) => {
      const entry = leaderWakeRecord(current[name]);
      if (body.wakeIntervalMs !== undefined) {
        entry.wakeIntervalMs = body.wakeIntervalMs;
        entry.nextWakeAtMs = body.wakeIntervalMs === null ? null : now + body.wakeIntervalMs;
      }
      if (body.paused !== undefined) {
        entry.paused = body.paused;
        if (!body.paused && entry.wakeIntervalMs) entry.nextWakeAtMs = now + entry.wakeIntervalMs;
      }
      return { ...current, [name]: entry };
    });
    if (ROOM_LEADER_WAKES_STATE.read()[name]?.wakeIntervalMs) ensureRoomFrontier(name);
    if (body.now === true) {
      ensureRoomFrontier(name);
      await wakeRoomLeader(name, now);
    }
    if (body.judge === true) {
      ensureRoomFrontier(name);
      if (!(await wakeRoomJudge(name, now, { force: true }))) throw httpError(409, `#${name} has no judge to wake`);
    }
    const room = roomSnapshotCache.refresh().find((candidate) => candidate.name === name);
    res.json({ ok: true, leaderWake: room?.leaderWake || null, leaderSessionId: room?.leaderSessionId || null });
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

const ROOM_PULSE_PROMPT = `You are the status reporter for this Room. Answer one question: What is everyone working on?

Read AGENTS.md, the Room Wiki, notes.md, and the recent chats assigned to this Room. Produce a concise executive rollup grouped by named chat or resident role. For each group report: current objective, last material progress, blocker or decision needed, next action, and how fresh the evidence is. Distinguish observed facts from inference and say unknown when evidence is stale or absent.

Status collection only. Do not perform project work, edit code, change live systems, launch or delegate agents, make decisions, update the Wiki, append notes, or ask the user routine questions. Your final answer is the durable status report. Then stop.`;
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
    updateMeta((meta) => ({ ...meta, [id]: { ...(meta[id] || {}), agent: 'omp', title: `Status: #${name}` } }));
    ROOM_ASSIGN_STATE.update((current) => ({ ...current, [id]: name }));
    const continuing = !!findOmpJsonlPath(id);
    launchOmpSession(id, cwd, { resume: continuing, promptFile, autoApprove: true });
    return true;
  } catch (error) {
    ROOM_PULSES_STATE.update((current) => ({
      ...current,
      [name]: pulseRecord(current[name], { enabled: true, status: 'error', error: error.message, nextRunAtMs: Date.now() + ROOM_PULSE_INTERVAL_MS }),
    }));
    console.warn(`[room pulse] #${name}:`, error.message);
    return false;
  }
}


function checkRoomPulses() {
  if (!ROOM_PULSES_ENABLED) return;
  const now = Date.now();
  const pulseState = ROOM_PULSES_STATE.read();
  const due = [];
  let inFlight = 0;
  for (const name of listRoomDirs()) {
    if (schedulerOwnsRoom(name)) continue;
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
    if (!room) {
      ROOM_PULSES_STATE.update((current) => ({ ...current, [name]: pulseRecord(current[name], { enabled: true, status: 'waiting', nextRunAtMs: now + ROOM_PULSE_INTERVAL_MS }) }));
      continue;
    }
    // Cap simultaneous status collectors. Deferred rooms stay due and launch
    // on later ticks, which also desynchronizes their schedules over time.
    if (inFlight >= ROOM_PULSE_MAX_CONCURRENT) continue;
    if (launchRoomPulse(name)) inFlight++;
  }
  const latestPulseState = ROOM_PULSES_STATE.read();
  roomSnapshotCache.update((snapshot) => snapshot.map((room) => ({
    ...room,
    pulse: roomPulse(room.name, Date.now(), latestPulseState),
  })));
  roomSnapshotCache.invalidate();
}

// Resident wakes: the "if there is something to do, do it" ping. Each Room
// resident with a wakeIntervalMs gets a wake prompt when due, unless its
// Ralph loop is still running from the previous wake. RALPH_COMPLETE only
// puts a resident to sleep; the next wake re-arms it.
function residentWakeDue(resident, sessionId, meta, now) {
  if (resident?.paused) return false;
  const interval = Number(resident?.wakeIntervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return false;
  const next = Number.isFinite(resident.nextWakeAtMs) ? resident.nextWakeAtMs : ROOM_PULSE_STARTED_AT + interval;
  if (now < next) return false;
  const ralph = meta[sessionId]?.ralph;
  // Mid-turn residents wait for their boundary, but not forever: one whole
  // interval past due, wake it anyway (OMP queues the message) so a turn
  // stuck on a blocking command cannot silence a resident for good.
  if (ralph?.enabled && (ralph.status === 'working' || ralph.status === 'scheduled') && tmuxIsActive(sessionId)
    && now < next + interval) return false;
  return true;
}

const residentWakesInFlight = new Set();
const RESIDENT_RELAUNCH_SETTLE_MS = Math.max(0, Number(process.env.FEATHER_RESIDENT_RELAUNCH_SETTLE_MS ?? 6_000));

// A resident whose OMP process died before it wrote a session file cannot be
// resumed; start it fresh in the Room and give it time to load before pasting.
async function ensureResidentRunning(sessionId, roomName) {
  if (!tmuxIsActive(sessionId) && !getOmpSessionId(sessionId)) {
    console.warn(`[room wake] #${roomName}: relaunching ${sessionId} (no OMP session to resume)`);
    launchOmpSession(sessionId, path.join(ROOMS_HOME_DIR, roomName));
    await sleep(RESIDENT_RELAUNCH_SETTLE_MS);
  }
}
async function wakeResident(sessionId, roomName, prompt) {
  await ensureResidentRunning(sessionId, roomName);
  await sendInput(sessionId, prompt);
}
function checkResidentWakes() {
  if (!ROOM_PULSES_ENABLED) return;
  const now = Date.now();
  const meta = readMeta();
  const residentState = ROOM_RESIDENTS_STATE.read();
  const roomNames = new Set(listRoomDirs());
  for (const [roomName, residents] of Object.entries(residentState)) {
    if (!roomNames.has(roomName) || schedulerOwnsRoom(roomName)) continue;
    for (const [role, resident] of Object.entries(residents)) {
      const sessionId = resident.sessionId;
      if (residentWakesInFlight.has(sessionId)) continue;
      if (!residentWakeDue(resident, sessionId, meta, now)) continue;
      if (meta[sessionId]?.mode !== RALPH_MODE) continue;
      const interval = resident.wakeIntervalMs;
      const at = new Date(now);
      ROOM_RESIDENTS_STATE.update((current) => {
        const entry = current[roomName]?.[role];
        if (!entry || entry.sessionId !== sessionId) return current;
        return {
          ...current,
          [roomName]: { ...current[roomName], [role]: { ...entry, nextWakeAtMs: now + interval, lastWakeAt: at.toISOString() } },
        };
      });
      const spec = ROOM_STANDARD_RESIDENTS.find((candidate) => candidate.role === role);
      const charter = spec?.charter || `${role.toUpperCase()}.md`;
      const prompt = residentWakePrompt({ roomName, role, charter, at });
      residentWakesInFlight.add(sessionId);
      prepareRalphForHumanInput(sessionId);
      wakeResident(sessionId, roomName, prompt)
        .catch((error) => console.warn(`[room wake] #${roomName} ${role}:`, error.message))
        .finally(() => residentWakesInFlight.delete(sessionId));
    }
  }
}

// Leader wakes (Room autonomy). The Leader is a plain OMP chat, not a Ralph
// loop: "mid-turn" means its transcript ends in a user message or a tool
// call. Like residents, one whole interval past due it is woken anyway.
const LEADER_LIMIT_RE = /rate.?limit|usage limit|limit reached|too many requests|\b429\b|quota|insufficient.?(credits|balance)|overloaded|resource.?exhausted/i;
const LEADER_TAIL_BYTES = 256 * 1024;

function ompTranscriptTail(sessionId) {
  const file = findOmpJsonlPath(sessionId);
  if (!file) return [];
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(LEADER_TAIL_BYTES, size);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      const lines = buf.toString('utf8').split('\n');
      if (length < size) lines.shift(); // partial first line
      const records = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch {}
      }
      return records;
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

function ompLastMessage(sessionId) {
  const records = ompTranscriptTail(sessionId);
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record?.type === 'message' && record.message && typeof record.message === 'object') return record.message;
  }
  return null;
}

// A Leader whose last assistant turn ended in a provider limit error.
function leaderLimitHit(sessionId) {
  const message = ompLastMessage(sessionId);
  if (!message || message.role !== 'assistant' || message.stopReason !== 'error') return null;
  const text = String(message.errorMessage || '');
  if (!LEADER_LIMIT_RE.test(text)) return null;
  return { reason: text.slice(0, 200), provider: message.provider || null, model: message.model || null };
}

function leaderMidTurn(sessionId) {
  if (!tmuxIsActive(sessionId)) return false;
  const message = ompLastMessage(sessionId);
  if (!message) return false;
  if (message.role === 'user') return true;
  return message.role === 'assistant' && message.stopReason === 'toolUse';
}

function leaderWakeDue(entry, sessionId, now) {
  if (!entry || entry.paused) return false;
  const interval = Number(entry.wakeIntervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return false;
  const next = Number.isFinite(entry.nextWakeAtMs) ? entry.nextWakeAtMs : ROOM_PULSE_STARTED_AT + interval;
  if (now < next) return false;
  if (sessionId && leaderMidTurn(sessionId) && now < next + interval) return false;
  return true;
}

const leaderWakesInFlight = new Set();

async function wakeRoomLeader(name, now = Date.now(), { prompt = null } = {}) {
  if (leaderWakesInFlight.has(name)) return null;
  leaderWakesInFlight.add(name);
  const wakePrompt = () => prompt || leaderWakePrompt({ roomName: name, at: new Date(now) });
  try {
    // Record the wake before the paste (which can take seconds), as
    // residents do, so a slow paste cannot look like a missed wake.
    ROOM_LEADER_WAKES_STATE.update((current) => {
      const entry = leaderWakeRecord(current[name]);
      return { ...current, [name]: { ...entry, lastWakeAt: new Date(now).toISOString(), nextWakeAtMs: entry.wakeIntervalMs ? now + entry.wakeIntervalMs : entry.nextWakeAtMs, judgeDue: true } };
    });
    let sessionId = ROOM_LEADERS_STATE.read()[name] || null;
    if (!sessionId || !validRoomLeaderDesignation(name, sessionId)) {
      // No Leader: seat one (no handoff to write) and let its opening be the wake.
      const model = ROOM_LEADER_WAKES_STATE.read()[name]?.fallback?.model || '';
      const seated = await succeedRoomLeader(name, { model, handoff: false, opening: wakePrompt });
      sessionId = seated.leaderSessionId;
    } else {
      await readyRoomLeader(name);
      await sendInput(sessionId, wakePrompt());
    }
    return sessionId;
  } finally {
    leaderWakesInFlight.delete(name);
  }
}

// The critic. After a Leader wake, once that turn has ended, the Room's judge
// resident is woken to grade what the Leader put up for Review. A wake whose
// turn never ends is judged anyway one whole interval later.
function ompMessageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text || '') : '')).join('\n');
}
const LEADER_TURN_ENDED = new Set(['stop', 'error', 'aborted', 'length']);
function leaderWakeTurnEnded(name, sessionId) {
  const records = ompTranscriptTail(sessionId);
  const openers = [`[Room wake · #${name} · leader`, `[Room handover · #${name}`, `[Room steer · #${name}`];
  let sawWake = false;
  let ended = false;
  for (const record of records) {
    if (record?.type !== 'message' || !record.message || typeof record.message !== 'object') continue;
    const message = record.message;
    if (message.role === 'user') {
      if (openers.some((opener) => ompMessageText(message).startsWith(opener))) sawWake = true;
      ended = false;
    } else if (message.role === 'assistant' && sawWake) {
      ended = LEADER_TURN_ENDED.has(message.stopReason);
    }
  }
  return sawWake && ended;
}
// A judge turn that has run past JUDGE_TURN_MAX_MS is treated as over, so a
// judge that hung can never block every later grading.
const JUDGE_TURN_MAX_MS = 2 * 60 * 60 * 1000;
function judgeMidTurn(sessionId, meta, lastWakeAt = null) {
  const ralph = meta[sessionId]?.ralph;
  if (!ralph?.enabled || !(ralph.status === 'working' || ralph.status === 'scheduled') || !tmuxIsActive(sessionId)) return false;
  const since = Date.parse(lastWakeAt || '');
  return !(Number.isFinite(since) && Date.now() - since > JUDGE_TURN_MAX_MS);
}
const judgeWakesInFlight = new Map();
async function wakeRoomJudge(name, now = Date.now(), { force = false } = {}) {
  if (judgeWakesInFlight.has(name)) {
    if (!force) return false;
    await judgeWakesInFlight.get(name).catch(() => {});
  }
  const judge = ROOM_RESIDENTS_STATE.read()[name]?.judge;
  if (!judge?.sessionId) return false;
  const meta = readMeta();
  if (meta[judge.sessionId]?.mode !== RALPH_MODE) return false;
  if (!force && (judge.paused || judgeMidTurn(judge.sessionId, meta, judge.lastWakeAt))) return false;
  const entry = leaderWakeRecord(ROOM_LEADER_WAKES_STATE.read()[name]);
  const leaderSessionId = ROOM_LEADERS_STATE.read()[name] || null;
  const at = new Date(now);
  const wake = (async () => {
    ROOM_LEADER_WAKES_STATE.update((current) => ({ ...current, [name]: { ...leaderWakeRecord(current[name]), judgeDue: false, lastJudgeAt: at.toISOString() } }));
    ROOM_RESIDENTS_STATE.update((current) => {
      const resident = current[name]?.judge;
      if (!resident || resident.sessionId !== judge.sessionId) return current;
      return { ...current, [name]: { ...current[name], judge: { ...resident, lastWakeAt: at.toISOString() } } };
    });
    roomSnapshotCache.refresh();
    prepareRalphForHumanInput(judge.sessionId);
    await wakeResident(judge.sessionId, name, judgeWakePrompt({ roomName: name, leaderSessionId, leaderWakeAt: entry.lastWakeAt, at }));
    return true;
  })();
  judgeWakesInFlight.set(name, wake);
  try { return await wake; } finally { judgeWakesInFlight.delete(name); }
}
// True when the judge should be woken now for a pending Leader wake.
function judgeWakeDue(name, entry, sessionId, now) {
  if (!entry.judgeDue) return false;
  if (sessionId && leaderWakeTurnEnded(name, sessionId)) return true;
  const interval = Number(entry.wakeIntervalMs);
  const since = Date.parse(entry.lastWakeAt || '') || now;
  if (!Number.isFinite(interval) || interval <= 0) return false;
  return now >= since + interval && !(sessionId && leaderMidTurn(sessionId));
}

function leaderProviderOf(model) {
  return String(model || '').split('/')[0] || null;
}

// Provider windows from the last usage snapshot (never fetched here, so a
// scheduler tick stays cheap): 'codex' is what the ledger calls openai-codex.
function providerWindowExhausted(model) {
  const key = { anthropic: 'anthropic', 'openai-codex': 'codex' }[leaderProviderOf(model)];
  const windows = key ? usageSnapshot?.providers?.[key]?.windows : null;
  if (!Array.isArray(windows)) return null;
  const hit = windows.find((window) => Number.isFinite(window?.utilization) && window.utilization >= 0.99);
  if (!hit) return null;
  return { reason: `${key} ${hit.name || 'window'} at ${Math.round(hit.utilization * 100)}%`, resetsAt: hit.resetsAt || null };
}

function nextLeaderFallbackModel(currentModel, tried = []) {
  return ROOM_LEADER_FALLBACK_MODELS.find((model) => model !== currentModel && !tried.includes(model)) || null;
}

async function switchRoomLeaderModel(name, { model, previousModel, reason, restoring }) {
  const outcome = await succeedRoomLeader(name, {
    model, handoff: true, force: true,
    opening: ({ retiredSessionId, handoff }) => leaderFallbackPrompt({ roomName: name, model, previousModel, reason, retiredSessionId, handoff, restoring }),
  });
  console.warn(`[room autonomy] #${name}: ${restoring ? 'restored' : 'fell back to'} ${model} (was ${previousModel}${reason ? `: ${reason}` : ''})`);
  return outcome;
}

// Called each scheduler tick for Rooms with autonomy on. Falls forward when
// the Leader's provider is out of credit; falls back to the primary when the
// retry time (doubling up to a cap) has passed.
async function reconcileLeaderFallback(name, entry, now) {
  const sessionId = ROOM_LEADERS_STATE.read()[name] || null;
  if (!sessionId || roomSuccessions.has(name)) return false;
  const currentModel = ompSessionModel(sessionId);
  const primaryModel = entry.fallback?.primaryModel || currentModel;
  const limit = leaderLimitHit(sessionId) || providerWindowExhausted(currentModel);
  if (limit) {
    const tried = entry.fallback ? [entry.fallback.model] : [];
    const model = nextLeaderFallbackModel(currentModel, tried);
    if (!model) return false;
    const attempts = Math.max(entry.fallbackAttempts || 0, entry.fallback?.attempts || 0) + 1;
    const retryAfter = Math.min(ROOM_LEADER_FALLBACK_RETRY_MAX_MS, ROOM_LEADER_FALLBACK_RETRY_MS * 2 ** (attempts - 1));
    const resetAt = Date.parse(limit.resetsAt || '') || 0;
    const retryAtMs = Math.max(now + retryAfter, resetAt);
    await switchRoomLeaderModel(name, { model, previousModel: currentModel, reason: limit.reason, restoring: false });
    ROOM_LEADER_WAKES_STATE.update((current) => ({
      ...current,
      [name]: { ...leaderWakeRecord(current[name]), fallbackAttempts: attempts, fallback: { model, primaryModel, since: new Date(now).toISOString(), reason: limit.reason || null, retryAtMs, attempts } },
    }));
    return true;
  }
  if (entry.fallback && now >= entry.fallback.retryAtMs && !providerWindowExhausted(entry.fallback.primaryModel)) {
    await switchRoomLeaderModel(name, { model: entry.fallback.primaryModel, previousModel: currentModel, reason: null, restoring: true });
    // fallbackAttempts stays on the record so a primary that trips again
    // backs off further; a full turn on the primary clears it.
    ROOM_LEADER_WAKES_STATE.update((current) => ({ ...current, [name]: { ...leaderWakeRecord(current[name]), fallback: null } }));
    return true;
  }
  if (!entry.fallback && entry.fallbackAttempts > 0 && ompLastMessage(sessionId)?.stopReason === 'stop') {
    ROOM_LEADER_WAKES_STATE.update((current) => ({ ...current, [name]: { ...leaderWakeRecord(current[name]), fallbackAttempts: 0 } }));
  }
  return false;
}

const leaderReconcilesInFlight = new Set();
const ROOM_LEADER_USAGE_CHECK = !/^(0|false|no|off)$/i.test(String(process.env.FEATHER_ROOM_LEADER_USAGE_CHECK || '').trim());
// Keep the provider windows fresh while any Room runs autonomously, so the
// fallback can act before a Leader burns a wake on a dead provider.
function refreshUsageSnapshotInBackground() {
  if (!ROOM_LEADER_USAGE_CHECK || usageSnapshotPending) return;
  if (usageSnapshot && Date.now() - Date.parse(usageSnapshot.generatedAt) < USAGE_SNAPSHOT_TTL_MS * 5) return;
  usageSnapshotPending = buildUsageSnapshot()
    .then((snapshot) => { usageSnapshot = snapshot; })
    .catch((error) => console.warn('[room autonomy] usage snapshot:', error.message))
    .finally(() => { usageSnapshotPending = null; });
}
function checkLeaderWakes() {
  if (!ROOM_PULSES_ENABLED) return;
  const now = Date.now();
  const state = ROOM_LEADER_WAKES_STATE.read();
  const roomNames = new Set(listRoomDirs());
  const autonomous = Object.entries(state).filter(([name, entry]) => roomNames.has(name) && entry.wakeIntervalMs && !entry.paused && !schedulerOwnsRoom(name));
  if (autonomous.length > 0) refreshUsageSnapshotInBackground();
  for (const [name, entry] of autonomous) {
    if (leaderReconcilesInFlight.has(name) || leaderWakesInFlight.has(name)) continue;
    leaderReconcilesInFlight.add(name);
    reconcileLeaderFallback(name, entry, now)
      .then((switched) => {
        if (switched) {
          ROOM_LEADER_WAKES_STATE.update((current) => {
            const record = leaderWakeRecord(current[name]);
            // The handover opening is a working turn; the judge grades it too.
            return { ...current, [name]: { ...record, nextWakeAtMs: record.wakeIntervalMs ? now + record.wakeIntervalMs : record.nextWakeAtMs, lastWakeAt: new Date(now).toISOString(), judgeDue: true } };
          });
          roomSnapshotCache.refresh();
          return null;
        }
        const sessionId = ROOM_LEADERS_STATE.read()[name] || null;
        if (judgeWakeDue(name, entry, sessionId, now)) {
          return wakeRoomJudge(name, now);
        }
        if (!leaderWakeDue(entry, sessionId, now)) return null;
        return wakeRoomLeader(name, now).then(() => roomSnapshotCache.refresh());
      })
      .catch((error) => console.warn(`[room autonomy] #${name}:`, error.message))
      .finally(() => leaderReconcilesInFlight.delete(name));
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────
// One rule table for every chat Feather wakes. The pure core lives in
// lib/scheduler.js; this block is the adapter: it resolves targets to
// sessions, launches, watches runs end, and keeps the ledger. A Room with
// any enabled rule is owned by the scheduler; the older per-Room wake
// checkers (pulses, resident wakes, Leader wakes) leave it alone.
const SCHEDULER_ENABLED = !READ_ONLY_MODE && !/^(0|false|no|off)$/i.test(String(process.env.FEATHER_SCHEDULER || '').trim());
const SCHEDULER_BOOT_AT = Date.now();
const SCHEDULER_BOOT_GRACE_MS = Math.max(0, Number(process.env.FEATHER_SCHEDULER_BOOT_GRACE_MS ?? BOOT_GRACE_MS));
const SCHEDULER_CHECK_MS = Math.max(50, Number(process.env.FEATHER_SCHEDULER_CHECK_MS) || SCHEDULER_TICK_MS);
const SCHEDULER_RUNS_FILE = STATE_PATHS.coordination.schedulerRunsFile;
const SCHEDULER_PUBLISHER = 'feather-scheduler';
const SCHEDULER_RUN_QUIET_MS = Math.max(10_000, Number(process.env.FEATHER_SCHEDULER_RUN_QUIET_MS) || 3 * 60_000);

function isSchedulerState(value) {
  if (!isJsonRecord(value)) return false;
  try { validateRules(value.rules ?? {}); } catch { return false; }
  if (value.runtime !== undefined && !isJsonRecord(value.runtime)) return false;
  if (value.active !== undefined && !Array.isArray(value.active)) return false;
  return true;
}
const SCHEDULER_STATE = createJsonState({
  file: STATE_PATHS.coordination.schedulerFile,
  defaultValue: () => ({ rules: {}, runtime: {}, active: [] }),
  validate: isSchedulerState,
});

function schedulerRules() {
  const state = SCHEDULER_STATE.read();
  return validateRules(state.rules || {});
}
function schedulerOwnsRoom(name) {
  if (!SCHEDULER_ENABLED) return false;
  const rules = SCHEDULER_STATE.read().rules || {};
  return Object.values(rules).some((rule) => rule.enabled !== false && rule.room === name);
}
function appendSchedulerRun(record) {
  try { fs.appendFileSync(SCHEDULER_RUNS_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 }); }
  catch (error) { console.warn('[scheduler] ledger:', error.message); }
}
function readSchedulerRuns({ room = null, limit = 100 } = {}) {
  let text = '';
  try { text = fs.readFileSync(SCHEDULER_RUNS_FILE, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  const filtered = room ? rows.filter((row) => row.room === room) : rows;
  return filtered.slice(-limit).reverse();
}

function schedulerTargetSessionId(rule) {
  if (rule.target.kind === 'leader') {
    const id = ROOM_LEADERS_STATE.read()[rule.room] || null;
    return id && validRoomLeaderDesignation(rule.room, id) ? id : null;
  }
  if (rule.target.kind === 'resident') return ROOM_RESIDENTS_STATE.read()[rule.room]?.[rule.target.role]?.sessionId || null;
  if (rule.target.kind === 'session') return rule.target.sessionId;
  return null;
}
// Idle means the target can take a message now. Unknown targets count as
// idle; a dead tmux counts as idle (sendInput resumes it).
function schedulerTargetIdle(rule) {
  const sessionId = schedulerTargetSessionId(rule);
  if (!sessionId || !tmuxIsActive(sessionId)) return true;
  const meta = readMeta();
  const ralph = meta[sessionId]?.ralph;
  if (ralph?.enabled && (ralph.status === 'working' || ralph.status === 'scheduled')) return false;
  if (getAgentForSession(sessionId) === 'omp') return !leaderMidTurn(sessionId);
  const file = findJsonlPath(sessionId, getAgentForSession(sessionId));
  if (!file) return true;
  return Date.now() - lastActivityMs(file, getAgentForSession(sessionId), 0) > SCHEDULER_RUN_QUIET_MS;
}
function schedulerRoomFile(rule, relative) {
  return path.join(ROOMS_HOME_DIR, rule.room, relative);
}
function schedulerContextFor(rule) {
  return {
    targetIdle: () => schedulerTargetIdle(rule),
    fileMtime: (relative) => { try { return fs.statSync(schedulerRoomFile(rule, relative)).mtimeMs; } catch { return null; } },
    fileText: (relative) => { try { return fs.readFileSync(schedulerRoomFile(rule, relative), 'utf8'); } catch { return null; } },
  };
}

function fillSchedulerPrompt(template, values) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => (values[key] ?? ''));
}
function schedulerPrompt(rule, { at, runtime }) {
  const roomName = rule.room;
  const role = rule.target.kind === 'resident' ? rule.target.role : rule.target.kind === 'leader' ? 'leader' : 'chat';
  const parent = rule.after ? runtimeOf(SCHEDULER_STATE.read(), rule.after) : null;
  const values = { room: roomName, role, at: at.toISOString(), ruleId: rule.id, after: rule.after || '', afterAt: parent?.lastRunAt || '' };
  const header = `[Room wake · #${roomName} · ${role} · ${at.toISOString()}]`;
  if (rule.prompt) {
    const body = fillSchedulerPrompt(rule.prompt, values);
    return body.startsWith('[') ? body : `${header}\n${body}`;
  }
  if (rule.target.kind === 'leader') {
    const wake = leaderWakePrompt({ roomName, at, budgetMs: rule.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (rule.mode !== 'fresh') return wake;
    return [
      wake,
      'You are a fresh Leader chat: the previous Leader chat was retired at this wake to keep context small. Everything it knew is in notes.md, FRONTIER.md, and the wiki; trust those files, not memory.',
    ].join('\n');
  }
  if (rule.target.kind === 'resident' && rule.target.role === 'judge') {
    return judgeWakePrompt({ roomName, leaderSessionId: ROOM_LEADERS_STATE.read()[roomName] || null, leaderWakeAt: parent?.lastRunAt || null, at });
  }
  if (rule.target.kind === 'resident') {
    const spec = ROOM_STANDARD_RESIDENTS.find((candidate) => candidate.role === role);
    return residentWakePrompt({ roomName, role, charter: spec?.charter || `${role.toUpperCase()}.md`, at });
  }
  return `${header}\nRe-read AGENTS.md and notes.md. If there is something to do, do it now; otherwise say so in one line and stop.`;
}

const schedulerLaunchesInFlight = new Set();
// Launch one run. The runtime already records the start, so a crash here
// cannot double-fire; a thrown error closes the run as failed.
async function schedulerLaunch(rule, run) {
  const at = new Date(run.startedAt);
  const prompt = schedulerPrompt(rule, { at, runtime: runtimeOf(SCHEDULER_STATE.read(), rule.id) });
  const cwd = path.join(ROOMS_HOME_DIR, rule.room);
  if (rule.mode === 'fresh' && rule.target.kind === 'leader') {
    const seated = await succeedRoomLeader(rule.room, { handoff: false, force: true, opening: () => prompt });
    return { sessionId: seated.leaderSessionId, marker: prompt.split('\n')[0] };
  }
  if (rule.mode === 'fresh') {
    if (!rule.prompt) throw new Error('a fresh session rule needs a prompt');
    const id = randomUUID();
    const title = rule.target.title || `Scheduled: ${rule.id}`;
    ROOM_ASSIGN_STATE.update((current) => ({ ...current, [id]: rule.room }));
    if (rule.target.engine === 'omp') {
      const sessionDir = path.join(OMP_SESSIONS, id);
      fs.mkdirSync(sessionDir, { recursive: true });
      const promptFile = path.join(sessionDir, 'scheduled-prompt.md');
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
      updateMeta((meta) => ({ ...meta, [id]: { ...(meta[id] || {}), agent: 'omp', title, ...(rule.target.model ? { ompModel: sanitizeOmpModel(rule.target.model) } : {}) } }));
      launchOmpSession(id, cwd, { promptFile, autoApprove: true });
    } else {
      spawnSession(id, cwd, rule.target.engine);
      updateMeta((meta) => ({ ...meta, [id]: { ...(meta[id] || {}), title } }));
      await sleep(ROOM_KICKOFF_DELAY_MS);
      await sendInput(id, prompt);
    }
    roomSnapshotCache.refresh();
    return { sessionId: id, marker: prompt.split('\n')[0] };
  }
  // inject
  let sessionId = schedulerTargetSessionId(rule);
  if (!sessionId && rule.target.kind === 'leader') {
    const seated = await succeedRoomLeader(rule.room, { handoff: false, force: true, opening: () => prompt });
    return { sessionId: seated.leaderSessionId, marker: prompt.split('\n')[0] };
  }
  if (!sessionId) throw new Error(`no ${rule.target.kind === 'resident' ? rule.target.role : 'target'} session in #${rule.room}`);
  prepareRalphForHumanInput(sessionId);
  if (getAgentForSession(sessionId) === 'omp') await wakeResident(sessionId, rule.room, prompt);
  else await sendInput(sessionId, prompt);
  return { sessionId, marker: prompt.split('\n')[0] };
}

// How a run ends. OMP chats: the turn after our marker stopped. Ralph
// residents: the loop went back to sleep. Fresh one-shots: tmux is gone.
// Other engines: the transcript went quiet. Anything else keeps running.
function schedulerRunStatus(run, rule) {
  const sessionId = run.sessionId;
  if (!sessionId) return 'running';
  const active = tmuxIsActive(sessionId);
  if (rule.mode === 'fresh' && rule.target.kind === 'new') return active ? 'running' : 'done';
  if (!active) return 'failed';
  const meta = readMeta();
  const ralph = meta[sessionId]?.ralph;
  if (meta[sessionId]?.mode === RALPH_MODE) {
    if (!ralph?.enabled || !(ralph.status === 'working' || ralph.status === 'scheduled')) return 'done';
    return 'running';
  }
  const agent = getAgentForSession(sessionId);
  if (agent === 'omp') return run.marker && sessionTurnEndedAfter(sessionId, run.marker) ? 'done' : 'running';
  const file = findJsonlPath(sessionId, agent);
  if (!file) return 'running';
  const last = lastActivityMs(file, agent, 0);
  return last > Date.parse(run.startedAt) && Date.now() - last > SCHEDULER_RUN_QUIET_MS ? 'done' : 'running';
}
function sessionTurnEndedAfter(sessionId, marker) {
  const records = ompTranscriptTail(sessionId);
  let sawMarker = false;
  let ended = false;
  for (const record of records) {
    if (record?.type !== 'message' || !record.message || typeof record.message !== 'object') continue;
    const message = record.message;
    if (message.role === 'user') {
      if (ompMessageText(message).startsWith(marker)) sawMarker = true;
      ended = false;
    } else if (message.role === 'assistant' && sawMarker) {
      ended = LEADER_TURN_ENDED.has(message.stopReason);
    }
  }
  return sawMarker && ended;
}

// A fresh chat that is still busy at three quarters of its timeout gets one
// wrap-up message: write the note and move the line before the kill. Without
// it a long scan ends as 'timeout' with nothing recorded and the next wake
// starts the same gap from zero.
const SCHEDULER_NUDGE_FRACTION = 0.75;
function schedulerNudgeDue(run, rule, now) {
  if (run.nudgedAt || !run.sessionId || rule.mode !== 'fresh') return false;
  const timeout = rule.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return now - Date.parse(run.startedAt) >= timeout * SCHEDULER_NUDGE_FRACTION;
}
function schedulerWrapUpPrompt(rule, run, now) {
  const timeout = rule.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const left = Math.max(1, Math.round((Date.parse(run.startedAt) + timeout - now) / 60_000));
  return [
    `[Room wake · #${rule.room} · wrap-up · ${new Date(now).toISOString()}]`,
    `About ${left} minutes remain before this chat is retired. Stop the current work now. Record what you have and where it is with \`room note\`, move the FRONTIER line with that evidence (partial is fine: say what is left and where the data sits), and end your turn.`,
  ].join('\n');
}
async function schedulerNudge(run, rule, now) {
  SCHEDULER_STATE.update((current) => ({
    ...current,
    active: (current.active || []).map((candidate) => candidate.runId === run.runId ? { ...candidate, nudgedAt: new Date(now).toISOString() } : candidate),
  }));
  try {
    const prompt = schedulerWrapUpPrompt(rule, run, now);
    if (getAgentForSession(run.sessionId) === 'omp') await wakeResident(run.sessionId, rule.room, prompt);
    else await sendInput(run.sessionId, prompt);
    appendSchedulerRun({ ...run, event: 'nudged', nudgedAt: new Date(now).toISOString() });
    console.log(`[scheduler] ${rule.id} wrap-up nudge sent to ${run.sessionId}`);
  } catch (error) {
    console.warn(`[scheduler] ${rule.id} nudge failed:`, error.message);
  }
}

function schedulerFinishRun(run, outcome, { rule, now = Date.now(), detail = null } = {}) {
  SCHEDULER_STATE.update((current) => ({
    ...current,
    runtime: { ...(current.runtime || {}), [run.ruleId]: markFinished(runtimeOf(current, run.ruleId), { outcome, at: now }) },
    active: (current.active || []).filter((candidate) => candidate.runId !== run.runId),
  }));
  appendSchedulerRun({ ...run, room: run.room || rule?.room || run.ruleId.split('/')[0], event: 'finished', outcome, finishedAt: new Date(now).toISOString(), durationMs: now - Date.parse(run.startedAt), ...(detail ? { detail } : {}) });
  if (outcome === 'timeout' && rule?.mode === 'fresh' && rule.target.kind === 'new' && run.sessionId) {
    try { execFileSync('tmux', ['kill-session', '-t', tmuxName(run.sessionId)], { stdio: 'ignore' }); } catch {}
  }
}

function schedulerStartRun(rule, decision, now) {
  // Inject targets are known up front; fresh sessions report theirs once launched.
  const run = { runId: randomUUID(), ruleId: rule.id, room: rule.room, mode: rule.mode, startedAt: new Date(now).toISOString(), reason: decision.reason, sessionId: rule.mode === 'inject' ? schedulerTargetSessionId(rule) : null, marker: null };
  const parentRunId = rule.after ? runtimeOf(SCHEDULER_STATE.read(), rule.after).lastRunId : null;
  SCHEDULER_STATE.update((current) => ({
    ...current,
    runtime: { ...(current.runtime || {}), [rule.id]: markStarted(runtimeOf(current, rule.id), { runId: run.runId, at: now, parentRunId }) },
    active: [...(current.active || []), run],
  }));
  appendSchedulerRun({ ...run, event: 'started' });
  schedulerLaunchesInFlight.add(rule.id);
  schedulerLaunch(rule, run)
    .then(({ sessionId, marker }) => {
      SCHEDULER_STATE.update((current) => ({
        ...current,
        active: (current.active || []).map((candidate) => candidate.runId === run.runId ? { ...candidate, sessionId, marker } : candidate),
      }));
      console.log(`[scheduler] ${rule.id} started (${decision.reason}) in ${sessionId}`);
    })
    .catch((error) => {
      console.warn(`[scheduler] ${rule.id} launch failed:`, error.message);
      schedulerFinishRun(run, 'failed', { rule, detail: error.message });
    })
    .finally(() => schedulerLaunchesInFlight.delete(rule.id));
}

function schedulerRaiseIncident(incident, now) {
  const { rule, kind, detail } = incident;
  SCHEDULER_STATE.update((current) => ({
    ...current,
    runtime: { ...(current.runtime || {}), [rule.id]: { ...runtimeOf(current, rule.id), incidentAt: new Date(now).toISOString() } },
  }));
  console.warn(`[scheduler] incident ${kind} ${rule.id}: ${detail}`);
  try {
    appendRoomPublication({
      roomRoot: path.join(ROOMS_HOME_DIR, rule.room),
      roomName: rule.room,
      publisherSessionId: SCHEDULER_PUBLISHER,
      input: {
        id: `scheduler-${kind}-${rule.id.replace('/', '-')}-${Math.floor(now / 60_000)}`,
        attention: 'by-the-way',
        sourceEvidenceId: `scheduler:${rule.id}:${kind}:${new Date(now).toISOString()}`,
        title: kind === 'paused' ? `Scheduler paused ${rule.id}` : `Scheduler: ${rule.id} is overdue`,
        summary: kind === 'paused'
          ? `${detail}. Feather stopped retrying. Fix the cause, then resume it from the Scheduler tab or with \`room schedule resume ${rule.id.split('/')[1]}\`.`
          : `${detail}. Nothing has started it for two intervals; check the target chat and the Scheduler tab.`,
      },
    });
    feedSnapshotCache.refresh();
  } catch (error) { console.warn('[scheduler] incident card:', error.message); }
}

let schedulerTickRunning = false;
let schedulerLastPlan = null;
function schedulerTick(now = Date.now()) {
  if (!SCHEDULER_ENABLED || schedulerTickRunning) return;
  schedulerTickRunning = true;
  try {
    const state = SCHEDULER_STATE.read();
    const rules = validateRules(state.rules || {});
    const roomNames = new Set(listRoomDirs());
    // 1. Close runs that ended, failed, or timed out.
    for (const run of state.active || []) {
      const rule = rules[run.ruleId];
      if (!rule) { schedulerFinishRun(run, 'killed', { detail: 'rule removed' }); continue; }
      if (schedulerLaunchesInFlight.has(rule.id)) continue;
      if (expiredRuns([run], rules, now).length) { schedulerFinishRun(run, 'timeout', { rule, now }); continue; }
      const status = schedulerRunStatus(run, rule);
      if (status !== 'running') { schedulerFinishRun(run, status, { rule, now }); continue; }
      if (schedulerNudgeDue(run, rule, now)) schedulerNudge(run, rule, now);
    }
    // 2. Plan and launch.
    const fresh = SCHEDULER_STATE.read();
    const liveRules = Object.fromEntries(Object.entries(rules).filter(([, rule]) => roomNames.has(rule.room)));
    const plan = planTick({
      rules: liveRules, runtime: fresh.runtime || {}, activeRuns: fresh.active || [], now,
      bootAt: SCHEDULER_BOOT_AT, bootGraceMs: SCHEDULER_BOOT_GRACE_MS, contextFor: schedulerContextFor,
    });
    schedulerLastPlan = { at: new Date(now).toISOString(), decisions: plan.decisions.map((d) => ({ ruleId: d.rule.id, fire: d.fire, reason: d.reason })) };
    for (const decision of plan.launches) schedulerStartRun(decision.rule, decision, now);
    // 3. Watchdog.
    const latest = SCHEDULER_STATE.read();
    for (const incident of findIncidents({ rules: liveRules, runtime: latest.runtime || {}, activeRuns: latest.active || [], now, bootAt: SCHEDULER_BOOT_AT })) {
      schedulerRaiseIncident(incident, now);
    }
  } catch (error) {
    console.warn('[scheduler] tick:', error.message);
  } finally {
    schedulerTickRunning = false;
  }
}

function schedulerSnapshot({ room = null } = {}) {
  const state = SCHEDULER_STATE.read();
  const rules = validateRules(state.rules || {});
  const now = Date.now();
  const activeByRule = new Map((state.active || []).map((run) => [run.ruleId, run]));
  const reasons = new Map((schedulerLastPlan?.decisions || []).map((d) => [d.ruleId, d.reason]));
  const list = Object.values(rules)
    .filter((rule) => !room || rule.room === room)
    .map((rule) => ({
      ...describeRule(rule, runtimeOf(state, rule.id), activeByRule.get(rule.id) || null, { now, bootAt: SCHEDULER_BOOT_AT }),
      targetSessionId: schedulerTargetSessionId(rule),
      lastDecision: reasons.get(rule.id) || null,
    }))
    .sort((a, b) => (a.room < b.room ? -1 : a.room > b.room ? 1 : a.id < b.id ? -1 : 1));
  return { enabled: SCHEDULER_ENABLED, bootAt: new Date(SCHEDULER_BOOT_AT).toISOString(), tickMs: SCHEDULER_CHECK_MS, lastTickAt: schedulerLastPlan?.at || null, rules: list };
}

function schedulerRuleId(req) { return `${req.params.room}/${req.params.name}`; }
function schedulerRuleOr404(req) {
  const id = schedulerRuleId(req);
  const rule = SCHEDULER_STATE.read().rules?.[id];
  if (!rule) throw httpError(404, `no such rule ${id}`);
  return { id, rule };
}
app.get('/api/scheduler', (req, res) => {
  try { res.json(schedulerSnapshot({ room: req.query.room ? String(req.query.room) : null })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/scheduler/runs', (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ runs: readSchedulerRuns({ room: req.query.room ? String(req.query.room) : null, limit }) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.put('/api/scheduler/rules/:room/:name', (req, res) => {
  try {
    const id = schedulerRuleId(req);
    if (!listRoomDirs().includes(req.params.room)) throw httpError(404, 'no such room');
    const rule = normalizeRule({ ...(req.body || {}), id });
    SCHEDULER_STATE.update((current) => {
      const rules = { ...(current.rules || {}), [id]: rule };
      validateRules(rules);
      const runtime = { ...(current.runtime || {}) };
      // A re-armed rule starts its clock now: never a burst from an old lastRunAt.
      if (!runtime[id] || rule.enabled !== (current.rules?.[id]?.enabled ?? true)) {
        runtime[id] = { ...runtimeOf(current, id), lastRunAt: runtimeOf(current, id).lastRunAt || new Date().toISOString(), paused: false, pausedReason: null, consecutiveFailures: 0, incidentAt: null };
      }
      return { ...current, rules, runtime };
    });
    if (rule.enabled) ensureRoomFrontier(req.params.room);
    res.json({ ok: true, rule: schedulerSnapshot({ room: req.params.room }).rules.find((candidate) => candidate.id === id) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/scheduler/rules/:room/:name', (req, res) => {
  try {
    const { id } = schedulerRuleOr404(req);
    SCHEDULER_STATE.update((current) => {
      const rules = { ...(current.rules || {}) };
      delete rules[id];
      validateRules(rules);
      const runtime = { ...(current.runtime || {}) };
      delete runtime[id];
      return { ...current, rules, runtime, active: (current.active || []).filter((run) => run.ruleId !== id) };
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/scheduler/rules/:room/:name/:action', (req, res) => {
  try {
    const { id } = schedulerRuleOr404(req);
    const action = req.params.action;
    const now = Date.now();
    if (action === 'pause' || action === 'resume') {
      SCHEDULER_STATE.update((current) => ({
        ...current,
        runtime: {
          ...(current.runtime || {}),
          [id]: action === 'pause'
            ? { ...runtimeOf(current, id), paused: true, pausedReason: 'paused by user' }
            : { ...runtimeOf(current, id), paused: false, pausedReason: null, consecutiveFailures: 0, incidentAt: null, lastRunAt: new Date(now).toISOString() },
        },
      }));
    } else if (action === 'fire') {
      const rules = schedulerRules();
      const rule = rules[id];
      const state = SCHEDULER_STATE.read();
      if ((state.active || []).some((run) => run.ruleId === id)) throw httpError(409, `${id} is already running`);
      if (schedulerLaunchesInFlight.has(id)) throw httpError(409, `${id} is launching`);
      schedulerStartRun(rule, { reason: 'fired by user' }, now);
    } else {
      throw httpError(404, 'unknown action');
    }
    res.json({ ok: true, rule: schedulerSnapshot({ room: req.params.room }).rules.find((candidate) => candidate.id === id) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

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
  ROOM_LEADER_WAKES_STATE,
  MESSAGE_RECEIPTS_STATE,
  SCHEDULER_STATE,
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
  // Send relative to the static root: `send` refuses any absolute path that
  // crosses a dot-directory (a release under ~/.local/share did), and that
  // turned every deep link into a 404 while `/` still worked.
  if (fs.existsSync(index)) res.sendFile('index.html', { root: STATIC_DIR });
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
  if (!READ_ONLY_MODE) setTimeout(recoverRalphCallbacks, RALPH_CALLBACK_DELAY_MS);
  // Durable Room Sidecars are synchronized before listen; no startup 404 window.
  if (ROOM_PULSES_ENABLED) {
    setTimeout(checkRoomPulses, Math.min(ROOM_PULSE_CHECK_MS, ROOM_PULSE_INTERVAL_MS));
    setInterval(checkRoomPulses, ROOM_PULSE_CHECK_MS);
    setInterval(checkResidentWakes, ROOM_PULSE_CHECK_MS);
    setInterval(checkLeaderWakes, ROOM_PULSE_CHECK_MS);
  }
  if (SCHEDULER_ENABLED) setInterval(schedulerTick, SCHEDULER_CHECK_MS);
});

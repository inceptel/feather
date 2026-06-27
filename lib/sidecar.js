// Sidecar: paired agent threads with a file-based chat channel.
// See docs/plans/2026-06-27-001-feature-sidecar-plan.md
//
// This module owns sidecar *state* only — the group registry and the per-group
// chat.jsonl record. Spawning peer sessions, injecting messages into tmux, and
// SSE broadcasting live in server.js (they need server-local functions). A
// sidecar "group" is just a grouping + chat channel layered over ordinary
// Feather sessions; a member is a normal session id.

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '/home/user';
const SIDECAR_DIR = path.join(HOME, '.feather/sidecars');
const GROUPS_FILE = path.join(SIDECAR_DIR, 'groups.json');

function ensureDir() { try { fs.mkdirSync(SIDECAR_DIR, { recursive: true }); } catch {} }
function groupDir(id) { return path.join(SIDECAR_DIR, id); }
function chatPath(id) { return path.join(groupDir(id), 'chat.jsonl'); }

export function readGroups() {
  try { return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')); }
  catch { return {}; }
}

function writeGroups(groups) {
  ensureDir();
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
}

export function listGroups() {
  return Object.values(readGroups()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function getGroup(id) {
  return readGroups()[id] || null;
}

// members: [{ sessionId, role, spawned }]. `spawned` marks peers sidecar created
// (and is responsible for tearing down); the driver is the user's own session.
export function createGroup({ id, members, agent, task }) {
  ensureDir();
  fs.mkdirSync(groupDir(id), { recursive: true });
  const groups = readGroups();
  groups[id] = {
    id,
    members,
    agent: agent || 'claude',
    task: task || '',
    status: 'active',
    createdAt: Date.now(),
  };
  writeGroups(groups);
  try { fs.closeSync(fs.openSync(chatPath(id), 'a')); } catch {} // touch
  return groups[id];
}

export function teardownGroup(id) {
  const groups = readGroups();
  if (groups[id]) { groups[id].status = 'done'; writeGroups(groups); }
}

// ── Member / role resolution ────────────────────────────────────────────────

export function resolveRecipient(group, toRole) {
  const m = group.members.find(m => m.role === toRole);
  return m ? m.sessionId : null;
}

// Match by the 8-char tmux prefix (feather-<id8>) so the CLI, which only knows
// its tmux session name, can identify itself.
export function groupForSessionPrefix(prefix) {
  return listGroups().find(g =>
    g.status === 'active' && g.members.some(m => m.sessionId.slice(0, 8) === prefix)) || null;
}

export function roleForPrefix(group, prefix) {
  const m = group.members.find(m => m.sessionId.slice(0, 8) === prefix);
  return m ? m.role : null;
}

// ── Chat thread ─────────────────────────────────────────────────────────────

export function appendMessage(id, msg) {
  ensureDir();
  fs.mkdirSync(groupDir(id), { recursive: true });
  const record = { ts: Date.now(), ...msg };
  fs.appendFileSync(chatPath(id), JSON.stringify(record) + '\n');
  return record;
}

export function readThread(id) {
  try {
    return fs.readFileSync(chatPath(id), 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Message templates ───────────────────────────────────────────────────────

export function priming({ selfRole, otherRole, task }) {
  return [
    `You are a Feather **sidecar** — a peer agent thread paired with another session (its role: "${otherRole}"). Your role: "${selfRole}".`,
    `To message the ${otherRole}, run:  sidecar post --to ${otherRole} "your message"`,
    `Read the full thread any time with:  sidecar read`,
    task
      ? `\nYour task from the ${otherRole}:\n${task}`
      : `\nWait for the ${otherRole} to message you, then collaborate back and forth.`,
  ].join('\n');
}

export function formatInbound(fromRole, text) {
  return `[sidecar message from ${fromRole}]\n${text}`;
}

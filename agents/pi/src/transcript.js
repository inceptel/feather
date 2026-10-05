// Feather transcript for a pi chat.
//
// pi-durable's SQLite entry log is the source of truth. This file is a derived,
// append-only copy in the OMP message format that Feather already parses
// (lib/parse.js parseOmpMessage). Each durable entry is written at most once,
// keyed by its entry id, so a restart re-derives missing lines and never
// duplicates one. Assistant lines also record the model and the upstream
// provider (for example "openai-codex") that answered.
import fs from 'node:fs';
import path from 'node:path';
import { upstreamOf } from './models.js';

const VISIBLE_KINDS = new Set(['pi.user', 'pi.assistant', 'pi.tool-result']);
export const TRANSCRIPT_FILE = 'transcript.jsonl';

// pi-durable entry ids are numbers. Feather's UI expects string message ids.
export function lineId(entryId) {
  return typeof entryId === 'string' && entryId.startsWith('pi-') ? entryId : `pi-${entryId}`;
}

export function transcriptLine(entry) {
  if (!VISIBLE_KINDS.has(entry?.kind)) return null;
  const message = entry.model?.[0];
  if (!message || typeof message !== 'object') return null;
  const timestamp = new Date(Number.isFinite(message.timestamp) ? message.timestamp : Date.now()).toISOString();
  const line = { type: 'message', id: lineId(entry.id), timestamp, message };
  if (message.role === 'assistant') {
    line.modelRef = message.provider === 'gateway' ? message.model : `${message.provider}/${message.model}`;
    line.upstreamProvider = upstreamOf(message.provider, message.model);
  }
  return line;
}

export function createTranscript(sessionDir) {
  const file = path.join(sessionDir, TRANSCRIPT_FILE);
  const written = new Set();
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      try { const id = JSON.parse(raw).id; if (id != null) written.add(lineId(id)); } catch { /* torn tail line */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // A crash can leave a torn last line. Start the next append on a new line.
  let needsNewline = false;
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      fs.closeSync(fd);
      needsNewline = last[0] !== 0x0a;
    }
  } catch { /* new file */ }

  function append(entries) {
    const lines = [];
    for (const entry of entries) {
      if (entry?.id == null || written.has(lineId(entry.id))) continue;
      const line = transcriptLine(entry);
      if (!line) continue;
      written.add(line.id);
      lines.push(JSON.stringify(line));
    }
    if (lines.length === 0) return 0;
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, (needsNewline ? '\n' : '') + lines.join('\n') + '\n');
      fs.fsyncSync(fd);
      needsNewline = false;
    } finally {
      fs.closeSync(fd);
    }
    return lines.length;
  }

  // Slash commands (/model, /view …) are handled outside the durable log, so
  // they never reach the model's memory. Write the command and its reply here
  // so the Chat view shows what happened instead of silence.
  let commandSeq = 0;
  function command(userText, replyText) {
    const now = Date.now();
    const id = `pi-cmd-${now}-${++commandSeq}`;
    const lines = [
      { type: 'message', id: `${id}-u`, timestamp: new Date(now).toISOString(), message: { role: 'user', content: userText, timestamp: now } },
      { type: 'message', id: `${id}-a`, timestamp: new Date(now + 1).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: replyText }], timestamp: now + 1 } },
    ];
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, (needsNewline ? '\n' : '') + lines.map(line => JSON.stringify(line)).join('\n') + '\n');
      fs.fsyncSync(fd);
      needsNewline = false;
    } finally {
      fs.closeSync(fd);
    }
  }

  return { file, append, command, has: id => written.has(lineId(id)) };
}

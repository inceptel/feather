// OptChat storage (spec §2): two append-only streams in the session dir.
//
//   main/YYYY-MM-DD.jsonl  one message per line: {i, kind, text, size, date[, src, part]}
//   tree/YYYY-MM-DD.jsonl  one node per line:    {l, i, text, size[, model]}
//
// `src` is the pi-durable entry id a message came from and `part` its place
// among that entry's messages, so a restart derives exactly the messages it
// has not logged yet. `model` names the compactor
// model that wrote a node. Each line is one write plus fsync. A torn line
// (a crash mid-write) is reported and skipped at load, and a file that does
// not end in "\n" gets one before the next write. Nothing is ever edited or
// deleted. One writer per session dir: the pi agent's session lock holds it.
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = new Set(['user', 'talk', 'tool', 'echo', 'note']);

export const bytes = text => Buffer.byteLength(text, 'utf8');

function localDay(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function readStream(dir, report) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const rows = [];
  const torn = new Set();
  for (const name of files) {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 0 && !text.endsWith('\n')) torn.add(file);
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try { rows.push(JSON.parse(raw)); } catch { report(`skipped a torn line in ${name}`); }
    }
  }
  return { rows, torn };
}

function createAppender(dir, torn) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return function append(row, date = new Date()) {
    const file = path.join(dir, `${localDay(date)}.jsonl`);
    const prefix = torn.has(file) ? '\n' : '';
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, `${prefix}${JSON.stringify(row)}\n`);
      fs.fsyncSync(fd);
      torn.delete(file);
    } finally {
      fs.closeSync(fd);
    }
  };
}

/**
 * Open the log and tree in `dir`. Messages must be dense from 0; a gap or a
 * duplicate id stops the load there (and is reported) rather than shifting ids.
 */
export function openStore(dir, { report = () => {} } = {}) {
  const mainDir = path.join(dir, 'main');
  const treeDir = path.join(dir, 'tree');
  const main = readStream(mainDir, report);
  const tree = readStream(treeDir, report);

  const messages = [];
  for (const row of main.rows.sort((a, b) => a.i - b.i)) {
    if (row.i !== messages.length || !KINDS.has(row.kind) || typeof row.text !== 'string') {
      report(`log: unexpected message ${JSON.stringify(row.i)}; stopped loading there`);
      break;
    }
    messages.push(row);
  }
  const nodes = new Map(); // "l:i" -> {l, i, text, size}
  for (const row of tree.rows) {
    if (!Number.isInteger(row.l) || !Number.isInteger(row.i) || typeof row.text !== 'string') continue;
    if ((row.i + 1) * 2 ** row.l > messages.length) continue; // covers messages that did not load
    nodes.set(`${row.l}:${row.i}`, row);
  }

  const appendMain = createAppender(mainDir, main.torn);
  const appendTree = createAppender(treeDir, tree.torn);

  return {
    dir,
    messages,
    nodes,
    /** Append one message; returns it. Written and fsynced before it returns. */
    addMessage(kind, text, { src, part, date = new Date() } = {}) {
      if (!KINDS.has(kind)) throw new Error(`unknown kind: ${kind}`);
      const row = { i: messages.length, kind, text: String(text), size: bytes(`${kind}: ${text}`), date: date.toISOString() };
      if (src !== undefined) { row.src = src; row.part = part ?? 0; }
      appendMain(row, date);
      messages.push(row);
      return row;
    },
    /** Save a built node. A node is written once; later duplicates are ignored. */
    addNode(l, i, text, extra = {}) {
      const key = `${l}:${i}`;
      if (nodes.has(key)) return nodes.get(key);
      const row = { l, i, text, size: bytes(text), ...extra };
      appendTree(row);
      nodes.set(key, row);
      return row;
    },
    node: (l, i) => nodes.get(`${l}:${i}`),
    /** Where logging from pi-durable entries stopped: {src, part}, or null. */
    lastSrc() {
      for (let k = messages.length - 1; k >= 0; k--) {
        if (Number.isFinite(messages[k].src)) return { src: messages[k].src, part: messages[k].part ?? 0 };
      }
      return null;
    },
  };
}

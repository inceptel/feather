// Per-chat links: the things a chat made that are worth opening again, and at
// most one front page (a status page the user glances at in the Links tab).
// Links live in session meta (meta[id].links) so deleting a chat drops them.
//
// Agents edit only their own chat's list, proven by the session bridge token.
// One exception: a spawned sidecar peer may set the front page of the chat that
// drives it (the /auto dashboard sidecar). The UI may remove and reorder links.

import fs from 'fs';
import path from 'path';

export const MAX_LINKS = 50;
const MAX_LABEL = 80;
const MAX_TARGET = 2048;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// An absolute file path (or ~/path) or an http(s) address; anything else is
// rejected rather than guessed, because the UI opens these without asking.
export function normalizeLinkTarget(raw, home) {
  if (typeof raw !== 'string') throw httpError(400, 'target must be a string');
  const value = raw.trim();
  if (!value || value.length > MAX_TARGET || /[\u0000-\u001f\u007f]/.test(value)) throw httpError(400, 'target is empty, too long, or has control characters');
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw httpError(400, 'target is not a valid web address'); }
    if (!url.hostname || url.username || url.password) throw httpError(400, 'target is not a valid web address');
    return { kind: 'web', target: url.href };
  }
  let file = value;
  if (file === '~' || file.startsWith('~/')) file = path.join(home, file.slice(1));
  if (!file.startsWith('/')) throw httpError(400, 'target must be an absolute file path or an http(s) web address');
  return { kind: 'file', target: path.resolve(file) };
}

function normalizeLabel(raw, link) {
  const label = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (raw !== undefined && typeof raw !== 'string') throw httpError(400, 'label must be a string');
  if (label.length > MAX_LABEL) throw httpError(400, `label is longer than ${MAX_LABEL} characters`);
  if (label) return label;
  return link.kind === 'web' ? new URL(link.target).hostname : path.basename(link.target) || link.target;
}

export function chatLinks(entry) {
  return Array.isArray(entry?.links) ? entry.links : [];
}

export function hasFrontPage(entry) {
  return chatLinks(entry).some(link => link.front);
}

export function createChatLinks({ readMeta, updateMeta, home, sidecarDriverOf = () => null, statFile = fs.statSync }) {
  function save(chatId, mutate) {
    let result;
    updateMeta(meta => {
      const entry = meta[chatId] || {};
      const links = mutate(chatLinks(entry).map(link => ({ ...link })));
      result = links;
      const next = { ...entry, links };
      if (!links.length) delete next.links;
      return { ...meta, [chatId]: next };
    });
    return result;
  }

  // File links carry mtime so the UI can refresh the front page when it changes.
  function list(chatId) {
    return chatLinks(readMeta()[chatId]).map(link => {
      if (link.kind !== 'file') return link;
      try {
        const stat = statFile(link.target);
        return { ...link, mtimeMs: stat.mtimeMs, ...(stat.isFile() ? {} : { missing: true }) };
      } catch { return { ...link, missing: true }; }
    });
  }

  function upsert(chatId, body) {
    const link = normalizeLinkTarget(body.target, home);
    const label = normalizeLabel(body.label, link);
    if (body.front !== undefined && typeof body.front !== 'boolean') throw httpError(400, 'front must be true or false');
    if (body.front && link.kind !== 'file') throw httpError(400, 'the front page must be a file');
    return save(chatId, links => {
      const at = links.findIndex(item => item.target === link.target);
      if (at < 0 && links.length >= MAX_LINKS) throw httpError(409, `a chat holds at most ${MAX_LINKS} links; remove one first`);
      const front = body.front ?? (at >= 0 ? !!links[at].front : false);
      const next = { label, target: link.target, kind: link.kind, ...(front ? { front: true } : {}) };
      if (front) for (const item of links) delete item.front;
      if (at >= 0) links[at] = next; else links.push(next);
      return links;
    });
  }

  function remove(chatId, target) {
    const { target: normalized } = normalizeLinkTarget(target, home);
    return save(chatId, links => {
      const next = links.filter(item => item.target !== normalized);
      if (next.length === links.length) throw httpError(404, 'no such link');
      return next;
    });
  }

  function clearFront(chatId) {
    return save(chatId, links => { for (const item of links) delete item.front; return links; });
  }

  // The new order must name every current link exactly once, so a stale tab
  // cannot drop a link an agent added meanwhile.
  function reorder(chatId, targets) {
    if (!Array.isArray(targets)) throw httpError(400, 'targets must be a list');
    return save(chatId, links => {
      const byTarget = new Map(links.map(item => [item.target, item]));
      if (targets.length !== links.length || new Set(targets).size !== targets.length || !targets.every(t => byTarget.has(t))) {
        throw httpError(409, 'the links changed; reload and try again');
      }
      return targets.map(t => byTarget.get(t));
    });
  }

  // callerId is authenticated by the route. `chat` names another chat only for
  // a sidecar setting its driver's front page.
  function agentAction(callerId, body = {}) {
    const { action, chat } = body;
    let chatId = callerId;
    if (chat !== undefined && chat !== callerId) {
      if (typeof chat !== 'string' || sidecarDriverOf(callerId) !== chat) throw httpError(403, 'agents may change only their own chat\'s links');
      const setsFront = action === 'add' && body.front === true;
      if (!setsFront && action !== 'read') throw httpError(403, 'a sidecar may only set the front page of the chat that drives it');
      chatId = chat;
    }
    if (action === 'read') return { links: list(chatId) };
    if (action === 'add') upsert(chatId, body);
    else if (action === 'remove') remove(chatId, body.target);
    else if (action === 'clear-front') clearFront(chatId);
    else throw httpError(400, 'action must be read, add, remove, or clear-front');
    return { chat: chatId, links: list(chatId) };
  }

  return { list, upsert, remove, clearFront, reorder, agentAction };
}

export function installChatLinkRoutes(app, { links, tokenValid, changed = () => {} }) {
  const handle = fn => (req, res) => {
    try { res.json(fn(req)); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Chat links unavailable' }); }
  };
  app.get('/api/chats/:id/links', handle(req => ({ links: links.list(req.params.id) })));
  app.post('/api/chats/:id/links/remove', handle(req => {
    links.remove(req.params.id, req.body?.target);
    changed(req.params.id);
    return { links: links.list(req.params.id) };
  }));
  app.post('/api/chats/:id/links/order', handle(req => {
    links.reorder(req.params.id, req.body?.targets);
    changed(req.params.id);
    return { links: links.list(req.params.id) };
  }));
  app.post('/api/internal/sessions/:id/links', handle(req => {
    if (!tokenValid(req.params.id, req.get('X-Feather-Bridge-Token'))) throw httpError(403, 'Invalid session capability');
    const result = links.agentAction(req.params.id, req.body || {});
    if (req.body?.action !== 'read') changed(result.chat);
    return result;
  }));
}

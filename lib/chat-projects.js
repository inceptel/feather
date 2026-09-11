import fs from 'node:fs';
import path from 'node:path';
import { chatFolderName } from './chat-pair.js';
import { createJsonState, isJsonRecord } from './json-state.js';

export function managedChatProject(root, meta, sessionId) {
  const chat = meta[sessionId];
  if (chat?.chatRole !== 'creator' || !chat.cwd) throw Object.assign(new Error('Choose a project chat'), { status: 404 });
  const realRoot = fs.realpathSync(root);
  const cwd = fs.realpathSync(chat.cwd);
  if (path.dirname(cwd) !== realRoot) throw Object.assign(new Error('Not a managed project folder'), { status: 400 });
  return { cwd, projectId: chat.chatProjectId || sessionId };
}

// A durable intent lets startup finish a rename interrupted between the
// directory move, compatibility link, and metadata update. Never move JSONL.
export function createProjectRenamer({ file, root, readMeta, saveMeta }) {
  const state = createJsonState({ file, defaultValue: () => ({ pending: null }), validate: value => isJsonRecord(value) && (value.pending === null || isJsonRecord(value.pending)) });
  function recover() {
    const pending = state.read().pending;
    if (!pending) return;
    const { from, to, ids } = pending;
    const realRoot = fs.realpathSync(root);
    if (path.dirname(from) !== realRoot || path.dirname(to) !== realRoot || !Array.isArray(ids)) throw new Error('Invalid project rename receipt');
    let source;
    try { source = fs.lstatSync(from); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (source?.isDirectory()) {
      if (fs.existsSync(to)) throw new Error('Project rename target already exists');
      fs.renameSync(from, to);
    } else if (source && (!source.isSymbolicLink() || fs.readlinkSync(from) !== to)) {
      throw new Error('Project rename source changed');
    }
    if (!fs.lstatSync(to).isDirectory()) throw new Error('Project rename target is not a folder');
    if (!source || source.isDirectory()) fs.symlinkSync(to, from, 'dir');
    saveMeta(meta => {
      const next = { ...meta };
      for (const id of ids) {
        if (!next[id]) continue;
        next[id] = { ...next[id], cwd: to, harnessCwd: next[id].harnessCwd || from };
      }
      return next;
    });
    state.update(() => ({ pending: null }));
  }
  function rename(sessionId, name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw Object.assign(new Error('Enter a project name of at most 200 characters'), { status: 400 });
    recover();
    const meta = readMeta();
    const { cwd: from, projectId } = managedChatProject(root, meta, sessionId);
    const to = path.join(fs.realpathSync(root), chatFolderName(name));
    if (from === to) return { cwd: to, projectId };
    try { fs.lstatSync(to); throw Object.assign(new Error('That folder name is already in use'), { status: 409 }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const ids = Object.keys(meta).filter(id => meta[id]?.cwd === from);
    state.update(() => ({ pending: { from, to, ids } }));
    recover();
    return { cwd: to, projectId };
  }
  return { rename, recover };
}

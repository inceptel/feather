import fs from 'node:fs';
import { listWikiPages, readWikiPage, verifiedWikiRoot } from './room-wiki.js';

// Source ids are stable and disambiguate a legacy collection named "shared".
export function wikiSources(sharedDir, roomsDir) {
  const sources = new Map([['shared', sharedDir]]);
  let entries;
  try { entries = fs.readdirSync(roomsDir, { withFileTypes: true }); } catch { return sources; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const root = verifiedWikiRoot(roomsDir, entry.name);
    if (root) sources.set(`room:${entry.name}`, root);
  }
  return sources;
}

export function listSharedWiki(sharedDir, roomsDir) {
  return [...wikiSources(sharedDir, roomsDir)].flatMap(([source, root]) =>
    listWikiPages(root).map(page => ({ source, ...page })));
}

export function readSharedWiki(sharedDir, roomsDir, source, name) {
  const root = source === 'shared' ? sharedDir : wikiSources(sharedDir, roomsDir).get(source);
  const page = root ? readWikiPage(root, name) : null;
  return page ? { source, ...page } : null;
}

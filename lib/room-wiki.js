// Room wiki: curated Markdown pages under <roomsDir>/<room>/wiki/.
//
// The wiki is canonical on disk and written by agents (the room caretaker is
// the consolidating writer); Feather only reads it. Page ids are wiki-relative
// paths without the .md extension ("Home", "Operations/Deploy"). Serving is
// strictly confined to the wiki directory: names are validated syntactically
// AND resolved paths are realpath-checked so symlinks cannot escape.

import fs from 'node:fs';
import path from 'node:path';

const WIKI_MAX_BYTES = 1024 * 1024;
const WIKI_MAX_DEPTH = 4;
// One path segment of a page id. No leading dot/underscore (hidden/assets),
// no path syntax. Spaces are allowed — page files are human-named.
const PAGE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$/;

export function validWikiPageName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 320) return false;
  const segments = name.split('/');
  if (segments.length > WIKI_MAX_DEPTH) return false;
  return segments.every((segment) => PAGE_SEGMENT_RE.test(segment) && !segment.endsWith('.'));
}

// List every .md page under wikiDir (depth-capped), Home first, then
// alphabetical. Hidden and underscore-prefixed entries (e.g. _assets) skipped.
export function listWikiPages(wikiDir) {
  const pages = [];
  const walk = (dir, prefix, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < WIKI_MAX_DEPTH) walk(path.join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const stat = fs.statSync(path.join(dir, entry.name));
          pages.push({ name: rel.slice(0, -3), size: stat.size, updatedAt: stat.mtime.toISOString() });
        } catch {}
      }
    }
  };
  walk(wikiDir, '', 1);
  pages.sort((a, b) => (a.name === 'Home' ? -1 : b.name === 'Home' ? 1 : a.name.localeCompare(b.name)));
  return pages;
}

// Read one page. Returns { name, content, updatedAt } or null (invalid name,
// missing file, symlink escaping the wiki root, or oversized file).
export function readWikiPage(wikiDir, name) {
  if (!validWikiPageName(name)) return null;
  let realRoot, real;
  try {
    realRoot = fs.realpathSync(wikiDir);
    real = fs.realpathSync(path.join(wikiDir, `${name}.md`));
  } catch { return null; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  let stat;
  try { stat = fs.statSync(real); } catch { return null; }
  if (!stat.isFile() || stat.size > WIKI_MAX_BYTES) return null;
  try {
    return { name, content: fs.readFileSync(real, 'utf8'), updatedAt: stat.mtime.toISOString() };
  } catch { return null; }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSharedWiki, readSharedWiki } from '../../lib/shared-wiki.js';

test('shared wiki aggregates existing collections without conflating equal page names', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-wiki-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, 'wiki');
  const rooms = path.join(root, 'rooms');
  fs.mkdirSync(shared);
  fs.mkdirSync(path.join(rooms, 'shared', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'Home.md'), 'Master knowledge');
  fs.writeFileSync(path.join(rooms, 'shared', 'wiki', 'Home.md'), 'Legacy knowledge');
  assert.deepEqual(listSharedWiki(shared, rooms).map(({ source, name }) => ({ source, name })), [
    { source: 'shared', name: 'Home' }, { source: 'room:shared', name: 'Home' },
  ]);
  assert.equal(readSharedWiki(shared, rooms, 'shared', 'Home').content, 'Master knowledge');
  assert.equal(readSharedWiki(shared, rooms, 'room:shared', 'Home').content, 'Legacy knowledge');
  assert.equal(readSharedWiki(shared, rooms, '../wiki', 'Home'), null);
  assert.equal(readSharedWiki(shared, rooms, 'shared', '../secret'), null);
  fs.writeFileSync(path.join(root, 'Secret.md'), 'Secret');
  fs.symlinkSync(path.join(root, 'Secret.md'), path.join(shared, 'Escape.md'));
  assert.equal(readSharedWiki(shared, rooms, 'shared', 'Escape'), null);
  fs.symlinkSync(shared, path.join(rooms, 'linked'));
  assert.equal(readSharedWiki(shared, rooms, 'room:linked', 'Home'), null);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(shared, alias);
  assert.equal(readSharedWiki(alias, rooms, 'shared', 'Home'), null);
});

test('missing wiki directories are empty and reads never create folders', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-wiki-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, 'wiki');
  const rooms = path.join(root, 'rooms');
  assert.deepEqual(listSharedWiki(shared, rooms), []);
  assert.equal(readSharedWiki(shared, rooms, 'shared', 'Home'), null);
  assert.deepEqual(fs.readdirSync(root), []);
});

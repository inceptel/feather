import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatUpdates } from '../../lib/chat-updates.js';

test('updates include explicit chat publications and shared wiki edits, not reviewer output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-chat-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wiki = path.join(root, 'wiki');
  fs.mkdirSync(wiki);
  fs.writeFileSync(path.join(wiki, 'Home.md'), '# Knowledge');
  fs.writeFileSync(path.join(root, 'updates.creator.json'), JSON.stringify([
    { id: 'result-1', title: 'Result', summary: 'Reviewed evidence.', occurredAt: '2026-09-11T12:00:00Z' },
    { id: 'invalid', summary: 'Bad date', occurredAt: 'nope' },
  ]));
  const meta = { creator: { chatRole: 'creator', title: 'Boat', cwd: root }, reviewer: { chatRole: 'reviewer', cwd: root } };
  const items = chatUpdates(meta, wiki);
  assert.equal(items.length, 2);
  assert.equal(items[0].sourceHref, '/#creator');
  assert.equal(items[0].evidenceId, 'chat:creator:result-1');
  assert.equal(items[1].sourceKind, 'wiki');
  assert.deepEqual(chatUpdates(meta, wiki), items, 'stable evidence IDs deduplicate refreshes');
  fs.writeFileSync(path.join(root, 'updates.creator.json'), '{partial');
  assert.equal(chatUpdates(meta, wiki).length, 1);
});

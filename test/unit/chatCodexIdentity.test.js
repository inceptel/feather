import test from 'node:test';
import assert from 'node:assert/strict';
import { codexHeadHasChatIdentity } from '../../lib/codex-watch.js';

test('shared-folder Codex peers adopt only their own developer identity', () => {
  const record = (role, id) => JSON.stringify({ type: 'response_item', payload: { role, content: [{ type: 'input_text', text: `[Feather chat identity: ${id}]` }] } });
  assert.equal(codexHeadHasChatIdentity(record('developer', 'creator'), 'creator'), true);
  assert.equal(codexHeadHasChatIdentity(record('developer', 'reviewer'), 'creator'), false);
  assert.equal(codexHeadHasChatIdentity(record('user', 'creator'), 'creator'), false);
  assert.equal(codexHeadHasChatIdentity(record('developer', 'creator').slice(0, -5), 'creator'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const naming = source.slice(source.indexOf('function sessionSystemPrompt('), source.indexOf('function writeSessionSystemPrompt(')).replaceAll('import.meta.dirname', '"/app"');
function prompt(chat = {}, roomName = null) {
  const context = vm.createContext({ PORT: 3300, readMeta: () => ({ chat }), roomLeaderNameForSession: () => roomName, roomLeaderPrompt: () => 'Room leader', isRalphSession: () => false });
  vm.runInContext(naming, context);
  return context.sessionSystemPrompt('chat');
}
test('ordinary chat startup asks for an early, safe, own-chat title', () => {
  const text = prompt({ title: 'New chat' });
  for (const rule of ['first meaningful user message', 'before substantive work', 'wait until it becomes clear', 'Preserve a title explicitly chosen by the user', '/api/sessions/chat/rename', 'at most 80 characters', 'do not ask permission or wait for reviewer approval', 'Do not rename a Room, project folder', 'must not block']) assert.ok(text.includes(rule), rule);
});
test('reviewer, communication helper and legacy Room leader startup do not self-title', () => {
  for (const chat of [{ chatRole: 'reviewer' }, { communicationRole: 'caretaker' }, { communicationRole: 'marketer' }, { communicationRole: 'replyguy' }]) assert.doesNotMatch(prompt(chat), /Chat naming:/);
  assert.doesNotMatch(prompt({}, 'legacy-room'), /Chat naming:/);
});

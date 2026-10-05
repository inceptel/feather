import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTranscript, transcriptLine } from '../src/transcript.js';

const user = { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'hi', timestamp: 1_700_000_000_000 }] };
const assistant = { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'yo' }], provider: 'gateway', model: 'openai-codex/gpt-5.6-sol', timestamp: 1_700_000_001_000 }] };
const system = { id: 3, kind: 'pi.system', data: {} };

test('assistant lines record the model and upstream provider', () => {
  const line = transcriptLine(assistant);
  assert.equal(line.type, 'message');
  // Feather's UI needs string ids; pi-durable entry ids are numbers.
  assert.equal(line.id, 'pi-2');
  assert.equal(line.modelRef, 'openai-codex/gpt-5.6-sol');
  assert.equal(line.upstreamProvider, 'openai-codex');
  const routed = transcriptLine({ ...assistant, model: [{ ...assistant.model[0], provider: 'openrouter', model: 'x/y' }] });
  assert.equal(routed.modelRef, 'openrouter/x/y');
  assert.equal(routed.upstreamProvider, 'openrouter');
  assert.equal(transcriptLine(system), null);
});

test('append is idempotent across restarts and repairs a torn tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-transcript-'));
  const first = createTranscript(dir);
  assert.equal(first.append([user, system]), 1);
  fs.appendFileSync(first.file, '{"torn":');
  const second = createTranscript(dir);
  assert.equal(second.append([user, assistant]), 1);
  const lines = fs.readFileSync(second.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[2]).id, 'pi-2');
  assert.equal(fs.statSync(second.file).mode & 0o777, 0o600);
});

test('a transcript with numeric ids from the first release is not duplicated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-transcript-'));
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), `${JSON.stringify({ type: 'message', id: 1, message: user.model[0] })}\n`);
  const transcript = createTranscript(dir);
  assert.equal(transcript.append([user, assistant]), 1);
  assert.ok(transcript.has(1) && transcript.has(2));
});

test('slash command and its reply land in the transcript, outside the entry ids', async () => {
  const { createTranscript } = await import('../src/transcript.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cmd-'));
  const t = createTranscript(dir);
  t.command('/model anthropix/x', 'unknown model: anthropix/x. Did you mean anthropic/x?');
  const lines = fs.readFileSync(t.file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.message.role), ['user', 'assistant']);
  assert.equal(lines[0].message.content, '/model anthropix/x');
  assert.match(lines[1].message.content[0].text, /Did you mean anthropic\/x/);
  assert.ok(lines.every(line => line.id.startsWith('pi-cmd-')));
  fs.rmSync(dir, { recursive: true, force: true });
});

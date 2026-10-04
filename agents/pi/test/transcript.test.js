import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTranscript, transcriptLine } from '../src/transcript.js';

const user = { id: 'e1', kind: 'pi.user', model: [{ role: 'user', content: 'hi', timestamp: 1_700_000_000_000 }] };
const assistant = { id: 'e2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'yo' }], provider: 'gateway', model: 'openai-codex/gpt-5.6-sol', timestamp: 1_700_000_001_000 }] };
const system = { id: 'e3', kind: 'pi.system', data: {} };

test('assistant lines record the model and upstream provider', () => {
  const line = transcriptLine(assistant);
  assert.equal(line.type, 'message');
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
  assert.equal(JSON.parse(lines[2]).id, 'e2');
  assert.equal(fs.statSync(second.file).mode & 0o777, 0o600);
});

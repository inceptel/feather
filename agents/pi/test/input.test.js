import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputParser } from '../src/input.js';

function parser() {
  const sent = [];
  let interrupts = 0;
  const p = createInputParser({ onSubmit: text => sent.push(text), onInterrupt: () => { interrupts += 1; } });
  return { p, sent, interrupts: () => interrupts };
}

test('typed line submits on Enter; empty Enters do nothing', () => {
  const { p, sent } = parser();
  p.feed('\r\r');
  p.feed('hello\r');
  assert.deepEqual(sent, ['hello']);
});

test('bracketed paste keeps newlines inside one message', () => {
  const { p, sent } = parser();
  p.feed('\x1b[200~line one\nline two\x1b[201~');
  assert.deepEqual(sent, []);
  p.feed('\r');
  assert.deepEqual(sent, ['line one\nline two']);
});

test('paste markers split across chunks', () => {
  const { p, sent } = parser();
  p.feed('\x1b[20');
  p.feed('0~a\nb\x1b[2');
  p.feed('01~\r');
  assert.deepEqual(sent, ['a\nb']);
});

test('Ctrl-C interrupts and clears the line', () => {
  const { p, sent, interrupts } = parser();
  p.feed('half typed\x03');
  p.feed('\r');
  assert.equal(interrupts(), 1);
  assert.deepEqual(sent, []);
});

test('backspace and other escape sequences', () => {
  const { p, sent } = parser();
  p.feed('abx\x7fc\x1b[A\x1b[I\r');
  assert.deepEqual(sent, ['abc']);
});

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseMessage } from '../../lib/parse.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.join(__dirname, '..', 'fixtures', 'synthetic-session.jsonl')
const lines = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean)

// Helper to build a JSONL line
function jsonl(overrides) {
  return JSON.stringify({
    type: 'user',
    uuid: 'test-uuid-0001',
    timestamp: '2025-06-15T10:00:00Z',
    isSidechain: false,
    isMeta: false,
    message: { role: 'user', content: 'hello world' },
    ...overrides,
  })
}

// ── Basic parsing ───────────────────────────────────────────────────────────

describe('parseMessage: basic parsing', () => {
  it('parses a plain user message', () => {
    const msg = parseMessage(lines[0])
    assert.ok(msg)
    assert.equal(msg.role, 'user')
    assert.equal(msg.uuid, 'aaaa-1111-bbbb-2222')
    assert.equal(msg.timestamp, '2025-06-15T10:00:00Z')
    assert.equal(msg.content.length, 1)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Hello, can you help me refactor the login page?')
  })

  it('parses assistant message with text + thinking blocks', () => {
    const msg = parseMessage(lines[1])
    assert.ok(msg)
    assert.equal(msg.role, 'assistant')
    assert.equal(msg.content.length, 2)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Sure! Let me look at the current login page first.')
    assert.equal(msg.content[1].type, 'thinking')
    assert.equal(msg.content[1].thinking, 'I should read the login component to understand the current structure before making changes.')
  })

  it('parses tool_use with name and input', () => {
    const msg = parseMessage(lines[2])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_use')
    assert.equal(msg.content[0].name, 'Read')
    assert.equal(msg.content[0].id, 'tool_001')
    assert.equal(msg.content[0].input.file_path, '/src/pages/Login.tsx')
  })

  it('parses tool_result with content string', () => {
    const msg = parseMessage(lines[3])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_result')
    assert.equal(msg.content[0].tool_use_id, 'tool_001')
    assert.ok(msg.content[0].content.includes('export function Login'))
  })

  it('parses error tool_result with is_error flag', () => {
    const msg = parseMessage(lines[8])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_result')
    assert.equal(msg.content[0].is_error, true)
    assert.ok(msg.content[0].content.includes('FAIL'))
  })

  it('preserves markdown formatting in text', () => {
    const msg = parseMessage(lines[4])
    assert.ok(msg)
    assert.ok(msg.content[0].text.includes('**Extract**'))
    assert.ok(msg.content[0].text.includes('**validation**'))
    assert.ok(msg.content[0].text.includes('1.'))
    assert.ok(msg.content[0].text.includes('2.'))
    assert.ok(msg.content[0].text.includes('3.'))
  })

  it('converts string content to [{type: "text", text}] block', () => {
    const msg = parseMessage(lines[17])
    assert.ok(msg)
    assert.equal(msg.content.length, 1)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Simple string content instead of array')
  })

  it('parses user message with markdown inline elements', () => {
    const msg = parseMessage(lines[20])
    assert.ok(msg)
    assert.ok(msg.content[0].text.includes('**bold**'))
    assert.ok(msg.content[0].text.includes('`code`'))
    assert.ok(msg.content[0].text.includes('[link](https://example.com)'))
  })
})

// ── Filtering ───────────────────────────────────────────────────────────────

describe('parseMessage: filtering', () => {
  it('returns null for every kind of non-message line', () => {
    const cases = {
      progress: lines[12],
      system: lines[13],
      sidechain: lines[14],
      'all tags stripped': lines[15],
      'empty string': lines[18],
      'empty array': lines[19],
      isMeta: jsonl({ isMeta: true }),
      'sidecar envelope': jsonl({ message: { role: 'user', content: '[feather-sidecar room-feather 42 operator] "internal coordination"' } }),
      'null content': jsonl({ message: { role: 'user', content: null } }),
      'missing message': JSON.stringify({ type: 'user', uuid: 'x', timestamp: 'x' }),
      whitespace: jsonl({ message: { role: 'user', content: '   \n\t  ' } }),
    }
    for (const [name, line] of Object.entries(cases)) assert.equal(parseMessage(line), null, name)
  })
})

// ── XML tag stripping ───────────────────────────────────────────────────────

describe('parseMessage: tag stripping', () => {
  it('strips local-command-caveat and keeps remaining text', () => {
    const line = jsonl({
      message: { role: 'user', content: '<local-command-caveat>internal</local-command-caveat>visible text' },
    })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.content[0].text, 'visible text')
  })

  it('strips command-name tags', () => {
    const line = jsonl({
      message: { role: 'user', content: '<command-name>foo</command-name>after' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'after')
  })

  it('strips command-message tags', () => {
    const line = jsonl({
      message: { role: 'user', content: 'before<command-message>bar</command-message>after' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'beforeafter')
  })

  it('strips command-args tags', () => {
    const line = jsonl({
      message: { role: 'user', content: '<command-args>--flag</command-args>rest' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'rest')
  })

  it('strips persisted-output tags', () => {
    const line = jsonl({
      message: { role: 'user', content: '<persisted-output>big blob</persisted-output>clean' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'clean')
  })

  it('strips multiple tags in one message', () => {
    const msg = parseMessage(lines[16])
    assert.ok(msg)
    assert.equal(msg.content[0].text, 'real user text here')
  })

  it('strips multiline tag content', () => {
    const line = jsonl({
      message: { role: 'user', content: '<local-command-caveat>line1\nline2\nline3</local-command-caveat>after' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'after')
  })

  it('does NOT strip tags in array content (only string content)', () => {
    const line = jsonl({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '<command-name>should remain</command-name>' }],
      },
    })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.content[0].text, '<command-name>should remain</command-name>')
  })
})

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('parseMessage: edge cases', () => {
  it('returns null for invalid JSON', () => {
    assert.equal(parseMessage('not json'), null)
    assert.equal(parseMessage('{broken'), null)
    assert.equal(parseMessage(''), null)
  })

  it('returns null for valid JSON but wrong structure', () => {
    assert.equal(parseMessage('{"type":"user"}'), null)
    assert.equal(parseMessage('42'), null)
    assert.equal(parseMessage('"string"'), null)
    assert.equal(parseMessage('null'), null)
    assert.equal(parseMessage('[]'), null)
  })

  it('round-trips long, unicode, and whitespace-bearing text unchanged', () => {
    for (const text of ['x'.repeat(100000), '你好世界 🚀 café naïve', 'line1\nline2\ttab']) {
      assert.equal(parseMessage(jsonl({ message: { role: 'user', content: text } }))?.content[0].text, text)
    }
  })

  it('handles both isSidechain=true and isMeta=true', () => {
    const line = jsonl({ isSidechain: true, isMeta: true })
    assert.equal(parseMessage(line), null)
  })

  it('tolerates a missing uuid or timestamp', () => {
    const msg = parseMessage(JSON.stringify({ type: 'user', isSidechain: false, isMeta: false, message: { role: 'user', content: 'bare' } }))
    assert.ok(msg)
    assert.equal(msg.uuid, undefined)
    assert.equal(msg.timestamp, undefined)
    assert.equal(msg.content[0].text, 'bare')
  })

  it('handles content array with mixed known and unknown block types', () => {
    const line = jsonl({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'unknown_future_type', data: 'something' },
          { type: 'tool_use', name: 'Read', id: 'x', input: {} },
        ],
      },
    })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.content.length, 3)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[1].type, 'unknown_future_type')
    assert.equal(msg.content[2].type, 'tool_use')
  })
})


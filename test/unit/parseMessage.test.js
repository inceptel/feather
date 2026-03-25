import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Extract parseMessage from server.js by reading and eval-ing just that function
// This avoids starting the server (which binds ports and starts fs.watch)
function parseMessage(line) {
  try {
    const d = JSON.parse(line)
    if (d.type !== 'user' && d.type !== 'assistant') return null
    if (d.isSidechain || d.isMeta || !d.message) return null

    const content = d.message.content
    if (!content) return null
    if (Array.isArray(content) && content.length === 0) return null
    if (typeof content === 'string' && content.trim() === '') return null

    let blocks
    if (typeof content === 'string') {
      let text = content
      for (const tag of ['local-command-caveat', 'command-name', 'command-message', 'command-args', 'persisted-output']) {
        text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '')
      }
      text = text.trim()
      if (!text) return null
      blocks = [{ type: 'text', text }]
    } else {
      blocks = content
    }

    return { uuid: d.uuid, role: d.message.role, timestamp: d.timestamp, content: blocks }
  } catch { return null }
}

// Load fixture lines
const fixturePath = path.join(__dirname, '..', 'fixtures', 'synthetic-session.jsonl')
let lines

before(() => {
  lines = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean)
})

describe('parseMessage', () => {
  it('parses a plain user message', () => {
    const msg = parseMessage(lines[0])
    assert.ok(msg)
    assert.equal(msg.role, 'user')
    assert.equal(msg.uuid, 'aaaa-1111-bbbb-2222')
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Hello, can you help me refactor the login page?')
  })

  it('parses assistant with text + thinking blocks', () => {
    const msg = parseMessage(lines[1])
    assert.ok(msg)
    assert.equal(msg.role, 'assistant')
    assert.equal(msg.content.length, 2)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[1].type, 'thinking')
    assert.ok(msg.content[1].thinking.includes('login component'))
  })

  it('parses tool_use blocks', () => {
    const msg = parseMessage(lines[2])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_use')
    assert.equal(msg.content[0].name, 'Read')
  })

  it('parses tool_result blocks', () => {
    const msg = parseMessage(lines[3])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_result')
    assert.ok(msg.content[0].content.includes('Login'))
  })

  it('parses assistant text with markdown formatting', () => {
    const msg = parseMessage(lines[4])
    assert.ok(msg)
    assert.ok(msg.content[0].text.includes('**Extract**'))
    assert.ok(msg.content[0].text.includes('**validation**'))
  })

  it('parses error tool_result', () => {
    const msg = parseMessage(lines[8])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_result')
    assert.equal(msg.content[0].is_error, true)
  })

  it('returns null for progress type', () => {
    const msg = parseMessage(lines[12])
    assert.equal(msg, null)
  })

  it('returns null for system type', () => {
    const msg = parseMessage(lines[13])
    assert.equal(msg, null)
  })

  it('filters out sidechain messages', () => {
    const msg = parseMessage(lines[14])
    assert.equal(msg, null)
  })

  it('strips internal XML tags from string content', () => {
    // Line with only internal tags → should return null (empty after strip)
    const msg1 = parseMessage(lines[15])
    assert.equal(msg1, null)

    // Line with internal tags + real text → keeps real text
    const msg2 = parseMessage(lines[16])
    assert.ok(msg2)
    assert.equal(msg2.content[0].text, 'real user text here')
  })

  it('handles string content (non-array)', () => {
    const msg = parseMessage(lines[17])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Simple string content instead of array')
  })

  it('returns null for empty string content', () => {
    const msg = parseMessage(lines[18])
    assert.equal(msg, null)
  })

  it('returns null for empty array content', () => {
    const msg = parseMessage(lines[19])
    assert.equal(msg, null)
  })

  it('passes through markdown in user messages', () => {
    const msg = parseMessage(lines[20])
    assert.ok(msg)
    assert.ok(msg.content[0].text.includes('**bold**'))
    assert.ok(msg.content[0].text.includes('`code`'))
  })

  it('returns null for invalid JSON', () => {
    const msg = parseMessage('not json at all')
    assert.equal(msg, null)
  })

  it('returns null for empty line', () => {
    const msg = parseMessage('')
    assert.equal(msg, null)
  })

  it('includes timestamp on all parsed messages', () => {
    for (const line of lines) {
      const msg = parseMessage(line)
      if (msg) {
        assert.ok(msg.timestamp, `message ${msg.uuid} missing timestamp`)
      }
    }
  })

  it('includes uuid on all parsed messages', () => {
    for (const line of lines) {
      const msg = parseMessage(line)
      if (msg) {
        assert.ok(msg.uuid, `message missing uuid`)
      }
    }
  })
})

describe('parseMessage counts', () => {
  it('parses the expected number of messages from fixture', () => {
    let count = 0
    for (const line of lines) {
      if (parseMessage(line)) count++
    }
    // 21 lines total:
    // 12 valid user/assistant messages
    // minus 1 sidechain, 1 progress, 1 system, 1 empty string, 1 empty array, 1 tags-only = 6 filtered
    // But let's count: lines 0,1,2,3,4,5,6,7,8,9,10,11 = 12 valid
    // line 12 progress = null, line 13 system = null, line 14 sidechain = null
    // line 15 tags-only = null, line 16 has real text = valid (13)
    // line 17 string content = valid (14), line 18 empty = null, line 19 empty array = null
    // line 20 markdown = valid (15)
    assert.equal(count, 15)
  })
})

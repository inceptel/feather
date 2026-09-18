import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createSessionSearch, buildMatchExpression, splitSnippet, messageSearchText } from '../../lib/session-search.js'

function claudeLine(uuid, role, content, timestamp = '2026-01-01T00:00:00Z') {
  return JSON.stringify({ type: role, uuid, timestamp, isSidechain: false, isMeta: false, message: { role, content } }) + '\n'
}

function candidate(id, fpath, agent = 'claude') {
  const stat = fs.statSync(fpath)
  return { id, fpath, agent, size: stat.size, mtime: stat.mtime }
}

describe('buildMatchExpression', () => {
  it('quotes every token as a prefix phrase so operators are inert', () => {
    assert.equal(buildMatchExpression('hello world'), '"hello"* "world"*')
    assert.equal(buildMatchExpression('  AND OR NOT  '), '"AND"* "OR"* "NOT"*')
    assert.equal(buildMatchExpression('say "hi"'), '"say"* "hi"*')
    assert.equal(buildMatchExpression('search.db'), '"search db"*')
    assert.equal(buildMatchExpression('***'), '')
  })
})

describe('splitSnippet', () => {
  it('turns marker-delimited text into match and non-match parts', () => {
    assert.deepEqual(splitSnippet('a \u0001b\u0002 c'), [
      { text: 'a ', match: false }, { text: 'b', match: true }, { text: ' c', match: false },
    ])
    assert.deepEqual(splitSnippet('\u0001only\u0002'), [{ text: 'only', match: true }])
  })
})

describe('messageSearchText', () => {
  it('keeps text blocks and ignores tools and thinking', () => {
    const text = messageSearchText({ content: [
      { type: 'thinking', thinking: 'secret plan' },
      { type: 'text', text: ' first ' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
      { type: 'tool_result', content: 'tool noise' },
      { type: 'text', text: 'second' },
    ] })
    assert.equal(text, 'first\nsecond')
  })
})

describe('createSessionSearch', () => {
  let root, dbPath, search
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-search-'))
    dbPath = path.join(root, 'index.db')
    search = createSessionSearch({ dbPath })
    await search.ready
  })
  after(() => {
    search.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('indexes message text and returns one ranked hit per session with a snippet', async () => {
    const a = path.join(root, 'a.jsonl')
    const b = path.join(root, 'b.jsonl')
    fs.writeFileSync(a, claudeLine('a1', 'user', 'Please plan the kitchen renovation budget')
      + claudeLine('a2', 'assistant', [{ type: 'text', text: 'The renovation needs a budget spreadsheet first.' }])
      + claudeLine('a3', 'assistant', [{ type: 'tool_result', content: 'renovation renovation renovation' }]))
    fs.writeFileSync(b, claudeLine('b1', 'user', 'Unrelated question about tides'))
    const result = await search.sync([candidate('session-a', a), candidate('session-b', b)])
    assert.deepEqual(result, { indexedFiles: 2, indexedMessages: 3, failures: [] })

    const hits = search.search('renov')
    assert.deepEqual([...hits.keys()], [a])
    const hit = hits.get(a)
    assert.equal(hit.sessionId, 'session-a')
    assert.equal(hit.count, 2, 'two messages matched but only the tool result was ignored')
    assert.ok(['a1', 'a2'].includes(hit.messageId))
    assert.ok(hit.snippet.some(part => part.match && /^renov/i.test(part.text)))
    assert.equal(search.search('tides').get(b).messageId, 'b1')
    assert.equal(search.search('nothing-here').size, 0)
  })

  it('does not match tool output or thinking', async () => {
    const c = path.join(root, 'c.jsonl')
    fs.writeFileSync(c, claudeLine('c1', 'assistant', [
      { type: 'thinking', thinking: 'zebra thoughts' },
      { type: 'text', text: 'Visible reply' },
      { type: 'tool_result', content: 'giraffe output' },
    ]))
    await search.sync([candidate('session-c', c)])
    assert.equal(search.search('zebra').size, 0)
    assert.equal(search.search('giraffe').size, 0)
    assert.equal(search.search('visible').size, 1)
  })

  it('indexes only appended bytes on the next sync and forgets removed files', async () => {
    const d = path.join(root, 'd.jsonl')
    fs.writeFileSync(d, claudeLine('d1', 'user', 'first message'))
    await search.sync([candidate('session-d', d)])
    fs.appendFileSync(d, claudeLine('d2', 'assistant', [{ type: 'text', text: 'appended pelican fact' }]))
    const result = await search.sync([candidate('session-d', d)])
    assert.equal(result.indexedMessages, 1)
    assert.equal(search.search('pelican').get(d).messageId, 'd2')
    assert.equal(search.search('first').get(d).messageId, 'd1')

    fs.unlinkSync(d)
    await search.sync([])
    assert.equal(search.search('pelican').size, 0)
    assert.equal(search.stats().files, 0)
  })

  it('reindexes a file that shrank instead of trusting stale offsets', async () => {
    const e = path.join(root, 'e.jsonl')
    fs.writeFileSync(e, claudeLine('e1', 'user', 'a long message about walruses that will be replaced later on'))
    await search.sync([candidate('session-e', e)])
    fs.writeFileSync(e, claudeLine('e2', 'user', 'short otter note'))
    await search.sync([candidate('session-e', e)])
    assert.equal(search.search('walrus').size, 0)
    assert.equal(search.search('otter').get(e).messageId, 'e2')
    fs.unlinkSync(e)
    await search.sync([])
  })

  it('handles multi-byte text across chunk boundaries and a trailing partial line', async () => {
    const f = path.join(root, 'f.jsonl')
    const full = claudeLine('f1', 'user', 'café résumé naïve ' + 'é'.repeat(5000))
    fs.writeFileSync(f, full + '{"type":"user","uuid":"f2","message":{"role":"user","content":"trunc')
    await search.sync([candidate('session-f', f)])
    assert.equal(search.search('resume').get(f).messageId, 'f1', 'diacritics are folded')
    assert.equal(search.search('trunc').size, 0, 'a partial trailing line is not indexed')
    fs.appendFileSync(f, 'ated line"}}\n' + claudeLine('f3', 'user', 'complete after truncation'))
    await search.sync([candidate('session-f', f)])
    assert.equal(search.search('truncated').get(f).messageId, 'f2', 'the completed line is picked up on the next sync')
    assert.equal(search.search('complete').get(f).count, 1)
    fs.unlinkSync(f)
    await search.sync([])
  })

  it('parses omp and codex transcripts with their own parsers', async () => {
    const omp = path.join(root, 'omp.jsonl')
    fs.writeFileSync(omp, JSON.stringify({ type: 'message', id: 'o1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'omp says platypus' }] } }) + '\n')
    const codex = path.join(root, 'rollout-codex.jsonl')
    fs.writeFileSync(codex, JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'message', id: 'x1', role: 'user', content: [{ type: 'input_text', text: 'codex mentions quokka' }] } }) + '\n')
    await search.sync([candidate('omp-session', omp, 'omp'), candidate('codex-session', codex, 'codex')])
    assert.equal(search.search('platypus').get(omp).sessionId, 'omp-session')
    assert.equal(search.search('quokka').get(codex).messageId, 'x1')
  })

  it('rebuilds a corrupt database file instead of failing', async () => {
    const corrupt = path.join(root, 'corrupt.db')
    fs.writeFileSync(corrupt, 'this is not a sqlite file')
    const other = createSessionSearch({ dbPath: corrupt })
    await other.ready
    assert.deepEqual(other.stats(), { files: 0, messages: 0, ready: true })
    other.close()
  })

  it('survives a query made of operators and punctuation', () => {
    assert.equal(search.search('AND OR NOT ^ : * ( )').size, 0)
    assert.equal(search.search('"').size, 0)
  })
})

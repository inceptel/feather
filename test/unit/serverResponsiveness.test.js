import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { parseMessageForAgent } from '../../lib/parse.js'
import { ompTurnBoundaryFromLine } from '../../lib/omp-session.js'

const source = fs.readFileSync(process.env.FEATHER_TEST_SOURCE || new URL('../../server.js', import.meta.url), 'utf8')
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-transcript-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

it('a transcript beginning with blank lines terminates without duplicating messages', t => {
  const file = path.join(temporaryRoot(t), 'chat.jsonl')
  const context = vm.createContext({ fs, Buffer, parseMessageForAgent, file })
  vm.runInContext(section('const MESSAGE_TAIL_CHUNK_BYTES', 'function getMessages('), context)
  fs.writeFileSync(file, '\n\n' + JSON.stringify({ type: 'progress', data: {} }) + '\n')
  const empty = vm.runInContext("readLatestMessages(file, 'claude', 100)", context, { timeout: 1000 })
  assert.equal(empty.messages.length, 0)
  assert.equal(empty.hasEarlier, false)
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'one', timestamp: '2026-01-01T00:00:00Z', message: { content: 'One real message' } }) + '\n')
  const page = vm.runInContext("readLatestMessages(file, 'claude', 100)", context, { timeout: 1000 })
  assert.deepEqual(Array.from(page.messages, item => item.uuid), ['one'])
  assert.equal(page.hasEarlier, false)
  assert.equal(page.cursor, fs.statSync(file).size)
})

it('catch-up yields mid-drain and coalesces appends in byte order without publishing partial UTF-8 records', async t => {
  const file = path.join(temporaryRoot(t), 'chat.jsonl')
  const total = 3000
  const record = (index, text = `Reply ${index} — preserved`) => JSON.stringify({
    type: 'message', id: String(index), timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n'
  // Put the first byte of a multibyte character at the end of a read chunk.
  const prefixBytes = Buffer.byteLength(record(0, '').split('"text":"')[0] + '"text":"')
  const longText = 'x'.repeat(64 * 1024 - 2 - prefixBytes) + '— preserved'
  const records = Array.from({ length: total }, (_, index) => record(index, index === 0 ? longText : undefined))
  const partial = Buffer.from(record(total + 1))
  const split = partial.indexOf(Buffer.from('—')) + 1
  fs.writeFileSync(file, '\n' + records.join(''))
  const delivered = []
  const offsets = new Map()
  let deliveredAtHeartbeat
  let overlapping
  let resolveHeartbeat
  const heartbeat = new Promise(resolve => { resolveHeartbeat = resolve })
  const context = vm.createContext({
    fs, path, Buffer, setImmediate, console, RALPH_MODE: 'ralph',
    fileOffsets: offsets, processingFileChanges: new Map(), sseClients: new Map([['chat', new Set([{}])]]),
    parseMessageForAgent, observeOmpTurnBoundary() {}, observeRalphBoundary() {},
    readMeta: () => ({ chat: { agent: 'omp' } }), getAgentForSession: () => 'omp',
    writeSse: (_sessionId, _clients, _response, chunk) => {
      delivered.push({ offset: Number(chunk.match(/^id: (\d+)/)[1]), message: JSON.parse(chunk.match(/\ndata: (.*)\n/)[1]) })
      if (delivered.length === 1) setImmediate(() => {
        deliveredAtHeartbeat = delivered.length
        // This event arrives after the original drain took its size snapshot.
        fs.appendFileSync(file, Buffer.concat([Buffer.from(record(total)), partial.subarray(0, split)]))
        overlapping = context.processFileChange(file, 'chat')
        resolveHeartbeat()
      })
      return true
    },
  })
  vm.runInContext(section('function broadcast(', 'function broadcastNamedEvent(')
    + section('function processFileChange(', '// ── omp session dir watchers'), context)
  const first = context.processFileChange(file, 'chat')
  const duplicate = context.processFileChange(file, 'chat')
  await Promise.all([first, duplicate, heartbeat])
  await overlapping
  assert.ok(deliveredAtHeartbeat < total, 'other work must run after delivery starts and before catch-up finishes')
  assert.deepEqual(delivered.map(event => event.message.uuid), Array.from({ length: total + 1 }, (_, index) => String(index)))
  assert.equal(delivered[0].message.content[0].text, longText)
  let expectedOffset = 1
  for (const [index, line] of [...records, record(total)].entries()) {
    expectedOffset += Buffer.byteLength(line)
    assert.equal(delivered[index].offset, expectedOffset)
  }
  assert.equal(offsets.get('chat'), expectedOffset)
  fs.appendFileSync(file, partial.subarray(split))
  await context.processFileChange(file, 'chat')
  assert.equal(delivered.length, total + 2)
  assert.equal(delivered.at(-1).message.content[0].text, `Reply ${total + 1} — preserved`)
  assert.equal(delivered.at(-1).offset, fs.statSync(file).size)
  await context.processFileChange(file, 'chat')
  assert.equal(delivered.length, total + 2)
})

function migrationFixture(t, readOnly = false) {
  const root = temporaryRoot(t)
  fs.mkdirSync(path.join(root, 'chat'))
  const timers = new Set()
  const processing = new Map()
  const launches = []
  let terminalChecks = 0
  const context = vm.createContext({
    fs, path, URL, console, OMP_SESSIONS: root, PORT: 3300, READ_ONLY_MODE: readOnly,
    OMP_BRIDGE_VERSION: 1, ompBridgeLastSeen: new Map(), processingFileChanges: processing,
    ompTurnBoundaryFromLine, getAgentForSession: () => 'omp', getOmpSessionCwd: () => root,
    tmuxIsActive: () => { terminalChecks++; return true },
    launchOmpSession: id => launches.push(id),
    setTimeout: callback => { const timer = { callback, unref() {} }; timers.add(timer); return timer },
    clearTimeout: timer => timers.delete(timer),
  })
  vm.runInContext(section('const pendingOmpBridgeMigrations', 'function processFileChange('), context)
  return {
    context, processing, launches, terminalChecks: () => terminalChecks,
    complete: () => context.observeOmpTurnBoundary('chat', JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop' } }), 'omp'),
    tick: () => { for (const timer of [...timers]) { timers.delete(timer); timer.callback() } },
    owner: port => fs.writeFileSync(path.join(root, 'chat', '.feather-bridge.json'), JSON.stringify({ sessionId: 'chat', url: `http://127.0.0.1:${port}/api/internal/sessions/chat/events` })),
  }
}

it('historical OMP completions defer terminal probes and cannot migrate across active turns or bridge owners', t => {
  const f = migrationFixture(t)
  f.processing.set('chat', {})
  for (let index = 0; index < 3000; index++) f.complete()
  f.tick()
  assert.equal(f.terminalChecks(), 0)
  assert.deepEqual(f.launches, [])
  f.context.observeOmpTurnBoundary('chat', JSON.stringify({ type: 'message', message: { role: 'user', content: 'next turn' } }), 'omp')
  f.processing.delete('chat')
  f.tick()
  assert.deepEqual(f.launches, [])
  f.complete()
  // Ownership changes before the final migration check, not when it is queued.
  f.owner(3301)
  f.tick()
  assert.deepEqual(f.launches, [])
  f.owner(3300)
  f.complete()
  f.tick()
  assert.deepEqual(f.launches, ['chat'])
})

it('read-only transcript observers never migrate legacy OMP sessions', t => {
  const f = migrationFixture(t, true)
  f.complete()
  f.tick()
  assert.deepEqual(f.launches, [])
  assert.equal(f.terminalChecks(), 0)
})

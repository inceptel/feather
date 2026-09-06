import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

import { classifyBookmark, normalizeBookmark, selectUnseen } from '../../lib/x-bookmarks.js'

const roots = []
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }) })

function raw(id, text = 'saved reference https://example.com/item') {
  return { id, text, createdAt: 'Fri Sep 04 23:00:08 +0000 2026', author: { username: 'person', name: 'Person' } }
}

describe('X bookmark dispatcher', () => {
  it('normalizes bookmarks and routes an external Council skill to conflicting review', () => {
    const bookmark = normalizeBookmark(raw('2096010451251499343', 'use my council skill https://github.com/kitze/council'))
    const classification = classifyBookmark(bookmark, { roomExists: () => true, skillCollision: true })
    assert.equal(classification.kind, 'skill-candidate')
    assert.equal(classification.disposition, 'review-required')
    assert.equal(classification.room, 'feather')
    assert.equal(classification.collision, true)
    assert.match(classification.rationale, /preserve it/u)
  })

  it('requires an artifact signal for skill candidates across the six-receipt corpus', () => {
    const cases = [
      {
        id: '2096469846334865513',
        text: 'The two best I know personally, skill wise are @ImDanTheMan and @AntoineRSX',
        urls: [],
        expected: 'reference',
      },
      {
        id: '2096259218835718273',
        text: 'Build a reusable agent skill named `evm-token-due-diligence`. Create the actual skill files.',
        urls: [],
        expected: 'skill-candidate',
      },
      {
        id: '2096010451251499343',
        text: 'u can use my council skill',
        urls: ['https://github.com/kitze/council'],
        expected: 'skill-candidate',
        collision: true,
      },
      {
        id: '2096276340337172659',
        text: '@KaiavRNihalani',
        urls: ['https://github.com/Fchaubard/autoresearcherUI'],
        expected: 'code-reference',
      },
      {
        id: '2096433162230600019',
        text: 'made a performant terminal for uniswap LPs on robinhood chain',
        urls: ['https://robinhoodpools.lol/'],
        expected: 'reference',
      },
      {
        id: '2096608599413837973',
        text: 'every model can search x',
        urls: ['https://x.pcstyle.dev/'],
        expected: 'reference',
      },
    ]

    for (const item of cases) {
      const bookmark = { ...normalizeBookmark(raw(item.id, item.text)), canonicalUrls: item.urls }
      const classification = classifyBookmark(bookmark, {
        roomExists: () => true,
        skillCollision: item.collision === true,
      })
      assert.equal(classification.kind, item.expected, item.id)
      assert.equal(classification.collision, item.collision === true, item.id)
      if (item.expected !== 'skill-candidate') {
        assert.match(classification.rationale, /does not encode execution intent/u, item.id)
        assert.doesNotMatch(classification.rationale, /approval/iu, item.id)
      }
    }
  })

  it('bootstraps only the newest item, then processes unseen items oldest first', () => {
    const bookmarks = ['103', '101', '102'].map((id) => normalizeBookmark(raw(`2096010451251499${id}`)))
    assert.deepEqual(selectUnseen(bookmarks, null).map((item) => item.id), ['2096010451251499103'])
    assert.deepEqual(selectUnseen(bookmarks, '2096010451251499101').map((item) => item.id), [
      '2096010451251499102', '2096010451251499103',
    ])
  })

  it('creates one intake and referral dispatch with durable receipts across repeated polls', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-x-bookmarks-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const destinationRoom = path.join(home, 'rooms/feather')
    const intakeRoom = path.join(home, 'rooms/x-bookmarks')
    fs.mkdirSync(binDir, { recursive: true })
    fs.mkdirSync(destinationRoom, { recursive: true })
    fs.mkdirSync(intakeRoom, { recursive: true })
    fs.writeFileSync(path.join(destinationRoom, 'notes.md'), '# notes\n')
    fs.writeFileSync(path.join(intakeRoom, 'notes.md'), '# notes\n')
    fs.writeFileSync(path.join(binDir, 'x'), `#!/bin/sh\nprintf '%s\\n' '{"tweets":[{"id":"2096010451251499343","text":"use my council skill https://github.com/kitze/council","createdAt":"Fri Sep 04 23:00:08 +0000 2026","author":{"username":"thekitze","name":"Kitze"}}],"nextCursor":"next-page"}'\n`)
    const roomCalls = path.join(root, 'room-calls.log')
    fs.writeFileSync(path.join(binDir, 'room'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$ROOM_CALLS"\nroom="$2"\ncase "$3" in\n  note) text="$4" ;;\n  dispatch) text="$8" ;;\n  *) exit 2 ;;\nesac\nprintf -- '- 2026-09-05 00:00 %s\\n' "$text" >> "$ROOMS_DIR/$room/notes.md"\n`)
    fs.chmodSync(path.join(binDir, 'x'), 0o755)
    fs.chmodSync(path.join(binDir, 'room'), 0o755)
    const env = {
      ...process.env,
      HOME: home,
      ROOMS_DIR: path.join(home, 'rooms'),
      X_BOOKMARK_STATE_DIR: stateDir,
      X_BOOKMARK_X_BIN: path.join(binDir, 'x'),
      X_BOOKMARK_ROOM_BIN: path.join(binDir, 'room'),
      ROOM_CALLS: roomCalls,
      X_BOOKMARK_SKIP_URL_RESOLUTION: '1',
    }
    const cli = path.resolve(import.meta.dirname, '../../bin/x-bookmark-dispatcher')
    const first = spawnSync(process.execPath, [cli], { env, encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    const second = spawnSync(process.execPath, [cli], { env, encoding: 'utf8' })
    assert.equal(second.status, 0, second.stderr)
    const receipt = JSON.parse(fs.readFileSync(path.join(stateDir, 'items/2096010451251499343.json'), 'utf8'))
    assert.equal(receipt.status, 'dispatched')
    assert.equal(receipt.classification.kind, 'skill-candidate')
    assert.equal(receipt.intakeRoom, 'x-bookmarks')
    const destinationNotes = fs.readFileSync(path.join(destinationRoom, 'notes.md'), 'utf8')
    const intakeNotes = fs.readFileSync(path.join(intakeRoom, 'notes.md'), 'utf8')
    assert.equal(destinationNotes.match(/\[X bookmark 2096010451251499343\]/gu)?.length, 1)
    assert.equal(intakeNotes.match(/\[X bookmark 2096010451251499343\]/gu)?.length, 1)
    const calls = fs.readFileSync(roomCalls, 'utf8').trim().split('\n')
    assert.equal(calls.length, 2)
    assert.ok(calls.some((call) => call.startsWith('-r x-bookmarks dispatch --id x-bookmark-2096010451251499343 --to caretaker ')))
    assert.ok(calls.some((call) => call.startsWith('-r feather dispatch --id x-bookmark-2096010451251499343 --to caretaker ')))
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(state.cursor.tweetId, '2096010451251499343')
  })
})

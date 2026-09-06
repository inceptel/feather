import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  ROOM_MISSION_MAX_CHARS, ROOM_STANDARD_RESIDENTS, ROOM_TEMPLATE_DIRS,
  leaderKickoffPrompt, normalizeRoomMission, residentWakePrompt, roomTemplateFiles, scaffoldRoom,
} from '../../lib/room-template.js'

const MISSION = 'go investigate this one spot that\'s available for rent or for purchase and build me a business plan for what it would look like to run an EV-only auto shop out of that location'

describe('Room template', () => {
  it('normalizes a mission without rewording it', () => {
    assert.equal(normalizeRoomMission(`  ${MISSION}  \r\n`), MISSION)
    assert.equal(normalizeRoomMission('first line \r\nsecond'), 'first line\nsecond')
    assert.equal(normalizeRoomMission(''), null)
    assert.equal(normalizeRoomMission('   '), null)
    assert.equal(normalizeRoomMission(undefined), null)
    assert.equal(normalizeRoomMission(42), null)
    assert.throws(() => normalizeRoomMission('x'.repeat(ROOM_MISSION_MAX_CHARS + 1)), /exceeds/)
    assert.throws(() => normalizeRoomMission('bad\x07bell'), /control characters/)
  })

  it('stamps the mission verbatim into AGENTS.md, notes, and the Wiki home', () => {
    const files = roomTemplateFiles({ name: 'ev-shop', mission: MISSION, now: new Date('2026-09-06T12:00:00Z') })
    assert.deepEqual(Object.keys(files), ['AGENTS.md', 'CARETAKER.md', 'UPDATER.md', 'MARKETER.md', 'notes.md', 'wiki/Home.md'])
    assert.match(files['AGENTS.md'], /^# Room: #ev-shop\n/)
    assert.ok(files['AGENTS.md'].includes('## Mission (verbatim from the user)'))
    assert.ok(files['AGENTS.md'].includes(`> ${MISSION}`))
    assert.ok(files['AGENTS.md'].includes('[Super Feed comment'))
    assert.ok(files['notes.md'].includes(`- 2026-09-06 12:00 Mission (verbatim from the user): ${MISSION}`))
    assert.ok(files['wiki/Home.md'].includes(`> ${MISSION}`))
    for (const spec of ROOM_STANDARD_RESIDENTS) {
      assert.ok(files[spec.charter].includes('room-ev-shop'), `${spec.charter} names the Sidecar group`)
      assert.ok(files[spec.charter].includes('~/rooms/ev-shop'), `${spec.charter} names the room path`)
    }
    assert.ok(files['UPDATER.md'].includes('room publish'))
    assert.ok(files['MARKETER.md'].includes('room visual --out ~/rooms/ev-shop/artifacts/<slug>.png'))
    assert.ok(files['MARKETER.md'].includes('notes-md-2026-09-06t18-12-mission-outcome'))
    assert.ok(files['MARKETER.md'].includes('"sourceEvidenceId": "<evidence-id>"'))
    assert.ok(files['UPDATER.md'].includes('plain slugs'))
    assert.ok(files['CARETAKER.md'].includes('RALPH_COMPLETE'))
  })

  it('leaves an editable placeholder when there is no mission', () => {
    const files = roomTemplateFiles({ name: 'bare', mission: null })
    assert.ok(files['AGENTS.md'].includes('## Mission\n\n<!-- One sentence'))
    assert.ok(!files['notes.md'].includes('Mission (verbatim'))
    assert.ok(!files['wiki/Home.md'].includes('Mission:'))
  })

  it('describes three standard residents with their wake cadence', () => {
    assert.deepEqual(ROOM_STANDARD_RESIDENTS.map(spec => [spec.role, spec.wakeIntervalMs]), [
      ['caretaker', 15 * 60 * 1000],
      ['updater', 30 * 60 * 1000],
      ['marketer', null],
    ])
  })

  it('writes wake and kickoff prompts that quote the charter and mission', () => {
    const wake = residentWakePrompt({ roomName: 'ev-shop', role: 'caretaker', charter: 'CARETAKER.md', at: new Date('2026-09-06T12:00:00Z') })
    assert.equal(wake.split('\n')[0], '[Room wake · #ev-shop · caretaker · 2026-09-06T12:00:00.000Z]')
    assert.ok(wake.includes('Re-read CARETAKER.md'))
    assert.ok(wake.includes('RALPH_COMPLETE: nothing to do'))
    const kickoff = leaderKickoffPrompt({ roomName: 'ev-shop', mission: MISSION })
    assert.match(kickoff, /^\[Room kickoff · #ev-shop\]\n/)
    assert.ok(kickoff.includes(`> ${MISSION}`))
    assert.ok(kickoff.includes('room note'))
  })

  it('scaffolds the folder with the CLAUDE.md symlink and working directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-template-'))
    try {
      const dir = path.join(root, 'ev-shop')
      fs.mkdirSync(dir)
      const files = scaffoldRoom(dir, { name: 'ev-shop', mission: MISSION })
      assert.deepEqual(files, ['AGENTS.md', 'CARETAKER.md', 'UPDATER.md', 'MARKETER.md', 'notes.md', 'wiki/Home.md'])
      for (const file of files) assert.ok(fs.existsSync(path.join(dir, file)), file)
      for (const sub of ROOM_TEMPLATE_DIRS) assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), sub)
      assert.equal(fs.readlinkSync(path.join(dir, 'CLAUDE.md')), 'AGENTS.md')
      assert.ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes(`> ${MISSION}`))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

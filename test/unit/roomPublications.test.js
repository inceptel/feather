import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  appendRoomPublication,
  readRoomPublications,
  verifiedPublicationVisual,
} from '../../lib/room-publications.js'

function fixture() {
  const roomRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'room-publications-'))
  fs.mkdirSync(path.join(roomRoot, 'artifacts'))
  fs.writeFileSync(path.join(roomRoot, 'artifacts', 'brief.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  return roomRoot
}


function input(id = 'jax-ev-0001', sourceEvidenceId = 'https://example.test/evidence/1', attention = undefined) {
  return {
    id,
    sourceEvidenceId,
    ...(attention ? { attention } : {}),
    title: 'Charging program changed',
    summary: 'The operating terms changed in a way that affects local planning.',
    detail: 'Primary source checked on 2026-09-06.',
    visual: 'artifacts/brief.png',
    visualAlt: 'A compact chart of the changed charging terms.',
  }
}

describe('Room publication store', () => {
  it('publishes idempotently while rejecting duplicate evidence', () => {
    const roomRoot = fixture()
    try {
      const first = appendRoomPublication({
        roomRoot, roomName: 'jacksonville-ev', publisherSessionId: 'updater-1', input: input(),
        now: new Date('2026-09-06T12:00:00Z'),
      })
      assert.equal(first.reused, false)
      assert.equal(first.record.attention, 'briefing')
      const retry = appendRoomPublication({
        roomRoot, roomName: 'jacksonville-ev', publisherSessionId: 'updater-1', input: input(),
        now: new Date('2026-09-06T12:01:00Z'),
      })
      assert.equal(retry.reused, true)
      assert.throws(() => appendRoomPublication({
        roomRoot, roomName: 'jacksonville-ev', publisherSessionId: 'updater-1',
        input: input('jax-ev-0002'), now: new Date('2026-09-06T12:31:00Z'),
      }), /source evidence was already published/)
      const rapid = appendRoomPublication({
        roomRoot, roomName: 'jacksonville-ev', publisherSessionId: 'updater-1',
        input: input('jax-ev-0003', 'https://example.test/evidence/3', 'by-the-way'), now: new Date('2026-09-06T12:10:00Z'),
      })
      assert.equal(rapid.reused, false)
      assert.equal(rapid.record.attention, 'by-the-way')
      assert.throws(() => appendRoomPublication({
        roomRoot, roomName: 'jacksonville-ev', publisherSessionId: 'updater-1',
        input: input('jax-ev-0004', 'https://example.test/evidence/4', 'urgent'),
      }), /attention must be briefing or by-the-way/)
      assert.equal(readRoomPublications(roomRoot, 'jacksonville-ev').length, 2)
    } finally {
      fs.rmSync(roomRoot, { recursive: true, force: true })
    }
  })

  it('keeps legacy publications without an attention field as briefing-compatible evidence', () => {
    const roomRoot = fixture()
    try {
      const legacy = {
        room: 'jacksonville-ev',
        ...input(),
        occurredAt: '2026-09-06T12:00:00.000Z',
        publisherSessionId: 'updater-1',
      }
      fs.writeFileSync(path.join(roomRoot, 'feed-publications.jsonl'), `${JSON.stringify(legacy)}\n`)
      assert.equal(readRoomPublications(roomRoot, 'jacksonville-ev').length, 1)
      const retry = appendRoomPublication({
        roomRoot, roomName: 'jacksonville-ev', publisherSessionId: 'updater-1', input: input(),
      })
      assert.equal(retry.reused, true)
      assert.equal(retry.record.attention, undefined)
    } finally {
      fs.rmSync(roomRoot, { recursive: true, force: true })
    }
  })

  it('allows multiple same-day publications and confines visuals to regular Room artifact files', () => {
    const roomRoot = fixture()
    const outside = path.join(path.dirname(roomRoot), `outside-${path.basename(roomRoot)}.png`)
    try {
      for (let index = 0; index < 4; index++) {
        appendRoomPublication({
          roomRoot, roomName: 'jacksonville-ev', publisherSessionId: 'updater-1',
          input: input(`jax-ev-000${index + 1}`, `evidence-${index + 1}`),
          now: new Date(`2026-09-06T12:00:0${index}Z`),
        })
      }
      assert.equal(readRoomPublications(roomRoot, 'jacksonville-ev').length, 4)

      fs.writeFileSync(outside, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
      fs.symlinkSync(outside, path.join(roomRoot, 'artifacts', 'escape.png'))

      assert.throws(() => verifiedPublicationVisual(roomRoot, 'artifacts/escape.png'), /visual not found/)
      assert.equal(verifiedPublicationVisual(roomRoot, 'artifacts/brief.png'), path.join(roomRoot, 'artifacts', 'brief.png'))
    } finally {
      fs.rmSync(roomRoot, { recursive: true, force: true })
      fs.rmSync(outside, { force: true })
    }
  })
})

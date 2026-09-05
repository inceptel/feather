import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { encodeProjectPath } from '../../lib/rooms.js'

const REPO = path.resolve(import.meta.dirname, '../..')

async function waitForFeed(base, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(stderr() || `server exited ${child.exitCode}`)
    try {
      const response = await fetch(`${base}/api/feed`)
      if (response.ok) return response.json()
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(stderr() || 'server did not become ready')
}

describe('Super Feed API', () => {
  it('projects Room and friction evidence and persists subscriptions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-super-feed-'))
    const home = path.join(root, 'home')
    const state = path.join(root, 'state')
    const rooms = path.join(home, 'rooms')
    fs.mkdirSync(rooms, { recursive: true })
    for (const name of ['health', 'friction']) {
      const room = path.join(rooms, name)
      fs.mkdirSync(room)
      fs.writeFileSync(path.join(room, 'AGENTS.md'), `# Room: #${name}\n`)
      fs.writeFileSync(path.join(room, 'notes.md'), `# #${name} — notes\n`)
    }
    fs.appendFileSync(path.join(rooms, 'health/notes.md'), '- 2026-09-05 12:00 PRIVATE RAW NOTE.\n')
    fs.appendFileSync(path.join(rooms, 'friction/notes.md'), [
      '- 2026-09-05 23:17 Complaint from #x-bookmarks: --stdin',
      '- 2026-09-05 23:20 Complaint from #feather: --stdin',
      '- 2026-09-05 23:20 Complaint from #x-bookmarks: --stdin',
      '- 2026-09-05 23:21 [id:calendar-auth] Complaint from #health: Calendar login loop | Evidence: OAuth returned 401',
      '',
    ].join('\n'))
    const leaderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const healthRoom = path.join(rooms, 'health')
    const projectDir = path.join(home, '.claude/projects', encodeProjectPath(healthRoom))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${leaderId}.jsonl`), [
      JSON.stringify({
        type: 'user', uuid: 'sidecar-message', cwd: healthRoom, timestamp: '2026-09-05T12:05:00Z',
        isMeta: false, isSidechain: false,
        message: { role: 'user', content: '[feather-sidecar room-health 1 operator] PRIVATE SIDECAR TEXT' },
      }),
      JSON.stringify({
        type: 'assistant', uuid: 'health-outcome', cwd: healthRoom, timestamp: '2026-09-05T12:10:00Z',
        isMeta: false, isSidechain: false,
        message: { role: 'assistant', content: 'Health review completed.' },
      }),
      '',
    ].join('\n'))
    fs.mkdirSync(path.join(home, '.feather'), { recursive: true })
    fs.writeFileSync(path.join(home, '.feather/room-mains.json'), JSON.stringify({ health: leaderId }))

    const port = 32_000 + (process.pid % 1000)
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO,
      env: { ...process.env, HOME: home, FEATHER_STATE_DIR: state, FEATHER_ROOM_PULSES: '0', PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let serverError = ''
    child.stderr.on('data', chunk => { serverError += chunk })

    try {
      const initial = await waitForFeed(base, child, () => serverError)
      assert.deepEqual(initial.following, ['friction', 'health'])
      const complaint = initial.items.find(item => item.complaintId === 'calendar-auth')
      assert.equal(complaint.room, 'health')
      assert.equal(complaint.summary, 'Calendar login loop')
      assert.equal(complaint.detail, 'OAuth returned 401')
      assert.equal(complaint.needsReview, false)
      assert.equal(complaint.status, null)
      const serialized = JSON.stringify(initial)
      assert.equal(serialized.includes('Health review completed.'), true)
      assert.equal(serialized.includes('PRIVATE RAW NOTE'), false)
      assert.equal(serialized.includes('PRIVATE SIDECAR TEXT'), false)
      assert.equal(serialized.includes('friction:legacy-'), false)
      assert.equal(serialized.includes('--stdin'), false)

      const current = await fetch(`${base}/api/feed`)
      const etag = current.headers.get('etag')
      assert.ok(etag)
      const unchanged = await fetch(`${base}/api/feed`, { headers: { 'If-None-Match': etag } })
      assert.equal(unchanged.status, 304)

      const unfollowed = await fetch(`${base}/api/feed/following`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: 'health', following: false }),
      })
      assert.equal(unfollowed.status, 200)
      assert.deepEqual((await unfollowed.json()).following, ['friction'])
      const refreshed = await (await fetch(`${base}/api/feed`)).json()
      assert.deepEqual(refreshed.following, ['friction'])

      const missing = await fetch(`${base}/api/feed/following`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: 'missing', following: true }),
      })
      assert.equal(missing.status, 404)
    } finally {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

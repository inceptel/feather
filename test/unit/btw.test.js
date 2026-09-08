import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { freePort } from './freePort.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

const REPO = path.resolve(import.meta.dirname, '../..')
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('/btw side questions', () => {
  it('answers from a copy of the session via omp print mode, keeps the exchange off the transcript, and refuses bad input', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-btw-'))
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const tmuxReg = path.join(root, 'tmux.reg')
    const ompLog = path.join(root, 'omp.log')
    fs.mkdirSync(path.join(home, '.feather'), { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(path.join(home, '.omp'), { recursive: true })
    fs.writeFileSync(path.join(home, '.omp/auth-gateway.token'), 'gateway-test-token\n', { mode: 0o600 })
    fs.writeFileSync(path.join(home, '.bashrc'), `export PATH=${JSON.stringify(binDir)}:$PATH\n`)
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'tmux'), [
      '#!/bin/sh',
      'case "$1" in',
      '  list-sessions) if [ -f "$TMUX_REG" ]; then now=$(date +%s); while IFS= read -r n; do printf "%s|%s\\n" "$n" "$now"; done < "$TMUX_REG"; fi; exit 0 ;;',
      '  has-session) if [ -f "$TMUX_REG" ] && grep -qxF "$3" "$TMUX_REG"; then exit 0; fi; exit 1 ;;',
      '  new-session) name=""; while [ $# -gt 0 ]; do [ "$1" = "-s" ] && name="$2"; shift; done; [ -n "$name" ] && printf "%s\\n" "$name" >> "$TMUX_REG"; exit 0 ;;',
      'esac',
      'exit 0',
    ].join('\n'))
    fs.chmodSync(path.join(binDir, 'tmux'), 0o755)
    // Fake omp: logs its argv and the copied session dir, answers on stdout.
    fs.writeFileSync(path.join(binDir, 'omp'), [
      '#!/bin/sh',
      `printf "%s\\n" "$*" >> ${JSON.stringify(ompLog)}`,
      'dir=""; while [ $# -gt 0 ]; do [ "$1" = "--session-dir" ] && dir="$2"; shift; done',
      `ls "$dir" >> ${JSON.stringify(ompLog)}`,
      'echo "The context says the answer is 42."',
    ].join('\n'))
    fs.chmodSync(path.join(binDir, 'omp'), 0o755)

    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO,
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_OMP_AUTH_GATEWAY_URL: 'http://127.0.0.1:14000', FEATHER_OMP_MODEL: 'anthropic/claude-fable-5-1',
        PATH: `${binDir}:${process.env.PATH}`, TMUX_REG: tmuxReg,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    try {
      let health
      for (let attempt = 0; attempt < 100 && !health; attempt++) {
        if (child.exitCode !== null) throw new Error(stderr)
        try { health = await (await fetch(`${base}/api/health`)).json() } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
      }
      const id = '22222222-2222-4222-8222-222222222222'
      const created = await post(`${base}/api/sessions`, { id, cwd: home, agent: 'omp' })
      assert.equal(created.status, 200, await created.text())

      // Before the first turn there is no transcript to copy.
      const early = await post(`${base}/api/sessions/${id}/btw`, { question: 'anything?' })
      assert.equal(early.status, 409)

      const sessionDir = path.join(home, '.feather/omp-sessions', id)
      fs.mkdirSync(sessionDir, { recursive: true })
      const ompId = '01a07926-ae64-7000-bb46-4ed36e280f7f'
      fs.writeFileSync(path.join(sessionDir, `2026-09-06T23-56-13_${ompId}.jsonl`), [
        JSON.stringify({ type: 'session', version: 3, id: ompId, timestamp: '2026-09-06T23:56:13.284Z', cwd: home }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'the answer is 42' } }),
      ].join('\n') + '\n')

      assert.equal((await post(`${base}/api/sessions/${id}/btw`, { question: '' })).status, 400)
      assert.equal((await post(`${base}/api/sessions/${id}/btw`, { question: 'x'.repeat(5000) })).status, 400)
      assert.equal((await post(`${base}/api/sessions/not-a-uuid/btw`, { question: 'hi' })).status, 400)

      const asked = await post(`${base}/api/sessions/${id}/btw`, { question: "what's the answer?" })
      const askedText = await asked.text()
      assert.equal(asked.status, 200, askedText)
      const item = JSON.parse(askedText)
      assert.equal(item.question, "what's the answer?")
      assert.equal(item.answer, 'The context says the answer is 42.')
      assert.equal(item.model, 'anthropic/claude-fable-5-1')
      assert.ok(item.ms >= 0)

      const log = fs.readFileSync(ompLog, 'utf8')
      assert.match(log, /--model anthropic\/claude-fable-5-1/)
      assert.match(log, /-p --no-tools --no-extensions --no-skills --no-rules --no-title/)
      assert.match(log, new RegExp(`--resume ${ompId}`))
      assert.match(log, /<btw>[\s\S]*Question: what's the answer\?[\s\S]*<\/btw>/)
      assert.match(log, new RegExp(`--session-dir ${path.join(home, '.feather/btw')}/22222222-`))
      assert.match(log, new RegExp(`^2026-09-06T23-56-13_${ompId}\\.jsonl$`, 'm'), 'transcript copied into the scratch session dir')
      assert.doesNotMatch(log, new RegExp(`--session-dir ${sessionDir}`), 'the real session dir is never used')
      assert.deepEqual(fs.readdirSync(path.join(home, '.feather/btw')), [], 'scratch dir cleaned up')
      assert.equal(fs.readdirSync(sessionDir).filter(name => name.endsWith('.jsonl')).length, 1, 'real transcript untouched')

      const listed = await (await fetch(`${base}/api/sessions/${id}/btw`)).json()
      assert.equal(listed.items.length, 1)
      assert.equal(listed.items[0].id, item.id)
      assert.equal(listed.pending, false)

      const claude = await post(`${base}/api/sessions`, { id: '33333333-3333-4333-8333-333333333333', cwd: home, agent: 'claude' })
      assert.equal(claude.status, 200, await claude.text())
      assert.equal((await post(`${base}/api/sessions/33333333-3333-4333-8333-333333333333/btw`, { question: 'hi' })).status, 409)
    } finally {
      child.kill('SIGKILL')
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

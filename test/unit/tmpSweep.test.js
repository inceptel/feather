import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { stopChild } from './stopChild.js'

const SWEEP = path.resolve(import.meta.dirname, '../../bin/feather-tmp-sweep')
const OLD = new Date(Date.now() - 10 * 86400 * 1000)

// Age a whole tree: every entry, deepest first so directory times stick.
function age(target) {
  if (fs.lstatSync(target).isDirectory()) for (const name of fs.readdirSync(target)) age(path.join(target, name))
  fs.utimesSync(target, OLD, OLD)
}
function oldDir(root, name, files = ['a.txt']) {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
  for (const file of files) fs.writeFileSync(path.join(dir, 'nested', file), 'x')
  age(dir)
  return dir
}

test('removes only stale, unused, ordinary entries', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-sweep-test-'))
  const children = []
  t.after(async () => {
    for (const child of children) await stopChild(child)
    spawnSync('chmod', ['-R', 'u+w', root])
    fs.rmSync(root, { recursive: true, force: true })
  })

  const stale = oldDir(root, 'stale-test-home')
  const readOnly = oldDir(root, 'stale-read-only-release')
  spawnSync('chmod', ['-R', 'a-w', readOnly])
  fs.utimesSync(readOnly, OLD, OLD)
  fs.writeFileSync(path.join(root, 'stale.log'), 'x'); fs.utimesSync(path.join(root, 'stale.log'), OLD, OLD)
  fs.mkdirSync(path.join(root, 'fresh-dir'))
  const touchedInside = oldDir(root, 'old-dir-with-fresh-file')
  fs.writeFileSync(path.join(touchedInside, 'nested', 'fresh.txt'), 'x')
  fs.utimesSync(touchedInside, OLD, OLD)
  const cwdInUse = oldDir(root, 'old-dir-a-process-runs-in')
  const argvInUse = oldDir(root, 'old-dir-named-in-argv')
  const tmuxSockets = oldDir(root, 'tmux-1000')
  const socket = path.join(root, 'old.socket')
  const server = net.createServer().listen(socket)
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  fs.lutimesSync(socket, OLD, OLD)

  children.push(spawn('sleep', ['30'], { cwd: cwdInUse, stdio: 'ignore' }))
  children.push(spawn('sh', ['-c', 'sleep 30', path.join(argvInUse, 'nested', 'a.txt')], { stdio: 'ignore' }))
  await new Promise(resolve => setTimeout(resolve, 100))

  const env = { ...process.env, FEATHER_TMP_SWEEP_ROOT: root, FEATHER_TMP_SWEEP_MIN_AGE_DAYS: '3' }
  const dry = spawnSync(SWEEP, ['--dry-run'], { env, encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  assert.deepEqual(dry.stdout.trim().split('\n').sort(), [readOnly, path.join(root, 'stale.log'), stale].sort())
  assert.ok(fs.existsSync(stale), 'a dry run deletes nothing')

  const run = spawnSync(SWEEP, [], { env, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stderr, /removed 3 entries/)
  assert.deepEqual(fs.readdirSync(root).sort(), [
    'fresh-dir', 'old-dir-a-process-runs-in', 'old-dir-named-in-argv', 'old-dir-with-fresh-file', 'old.socket', 'tmux-1000',
  ])
  assert.ok(fs.existsSync(path.join(tmuxSockets, 'nested', 'a.txt')))
})

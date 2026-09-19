import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { commitWikiChanges, describeWikiChanges, isWikiRepository } from '../../lib/wiki-git.js'

function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim() }

test('a wiki that is not a repository is left alone', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-wiki-git-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'Home.md'), '# Home\n')
  assert.equal(isWikiRepository(dir), false)
  assert.deepEqual(await commitWikiChanges(dir), { committed: false, reason: 'not a repository' })
  assert.deepEqual(fs.readdirSync(dir), ['Home.md'])
  assert.deepEqual(await commitWikiChanges(''), { committed: false, reason: 'not a repository' })
})

test('changes in a wiki repository are committed with a readable subject', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-wiki-git-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main')
  assert.equal(isWikiRepository(dir), true)
  assert.deepEqual(await commitWikiChanges(dir), { committed: false, reason: 'clean' })
  fs.writeFileSync(path.join(dir, 'Home.md'), '# Home\n')
  fs.mkdirSync(path.join(dir, 'health'))
  fs.writeFileSync(path.join(dir, 'health', 'foot fungus.md'), 'evidence\n')
  const first = await commitWikiChanges(dir)
  assert.equal(first.committed, true)
  assert.equal(first.subject, 'wiki: update Home, health/foot fungus')
  assert.deepEqual(first.files.sort(), ['Home.md', 'health/foot fungus.md'])
  assert.deepEqual(await commitWikiChanges(dir), { committed: false, reason: 'clean' })
  fs.appendFileSync(path.join(dir, 'Home.md'), 'more\n')
  fs.unlinkSync(path.join(dir, 'health', 'foot fungus.md'))
  const second = await commitWikiChanges(dir)
  assert.equal(second.subject, 'wiki: update Home, health/foot fungus')
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '2')
  assert.equal(git(dir, 'status', '--porcelain'), '')
  assert.match(git(dir, 'log', '-1', '--format=%an <%ae>'), /Feather wiki <wiki@feather\.local>/)
})

test('commit subjects name at most five pages', () => {
  const lines = Array.from({ length: 7 }, (_, i) => `?? page-${i}.md`).join('\n')
  assert.equal(describeWikiChanges(lines).subject, 'wiki: update page-0, page-1, page-2, page-3, page-4 and 2 more')
  assert.equal(describeWikiChanges('R  "old name.md" -> "new name.md"').subject, 'wiki: update new name')
  assert.deepEqual(describeWikiChanges('\n').files, [])
})

// Automatic history for the shared wiki.
//
// The wiki is Markdown on disk, written by agents. When the directory is a git
// repository, Feather commits whatever has changed so `git log -- <page>`
// shows who changed what and when. Nothing here rewrites history, pushes, or
// touches a directory that is not already a repository: an operator opts in
// with `git init` and can opt out by removing `.git`.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const COMMITTER = { name: 'Feather wiki', email: 'wiki@feather.local' }
const MAX_NAMED_FILES = 5

export function isWikiRepository(wikiPath) {
  try {
    const stat = fs.lstatSync(path.join(wikiPath, '.git'))
    return stat.isDirectory()
  } catch { return false }
}

// Turn `git status --porcelain` lines into a short human commit subject.
export function describeWikiChanges(porcelain) {
  const files = []
  for (const line of String(porcelain).split('\n')) {
    if (!line.trim()) continue
    let file = line.slice(3).trim()
    if (file.includes(' -> ')) file = file.split(' -> ').pop()
    file = file.replace(/^"(.*)"$/, '$1')
    files.push(file)
  }
  const names = files.map(file => file.replace(/\.md$/i, ''))
  const shown = names.slice(0, MAX_NAMED_FILES)
  const more = names.length - shown.length
  const subject = `wiki: update ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  return { files, subject }
}

/**
 * commitWikiChanges(wikiPath) → { committed, reason?, files?, subject? }
 * Commits every pending change in wikiPath when it is a git repository.
 */
export async function commitWikiChanges(wikiPath, { timeoutMs = 15_000 } = {}) {
  if (!wikiPath || !isWikiRepository(wikiPath)) return { committed: false, reason: 'not a repository' }
  const git = args => execFileAsync('git', ['-C', wikiPath, ...args], {
    timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  const { stdout } = await git(['status', '--porcelain', '--untracked-files=all'])
  const { files, subject } = describeWikiChanges(stdout)
  if (!files.length) return { committed: false, reason: 'clean' }
  await git(['add', '-A'])
  await git([
    '-c', `user.name=${COMMITTER.name}`, '-c', `user.email=${COMMITTER.email}`,
    'commit', '-q', '--no-verify', '-m', subject,
  ])
  return { committed: true, files, subject }
}

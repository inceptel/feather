import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWikiSearch } from '../../lib/wiki-search.js'

function page(source, name, content, updatedAt = '2026-09-19T00:00:00.000Z') {
  return { source, name, size: content.length, updatedAt, content }
}
const read = page => page.content

test('wiki search finds pages by body text and by words in the page name', async t => {
  const search = createWikiSearch()
  t.after(() => search.close())
  await search.sync([
    page('shared', 'feather-session-search-index', '# Chat search\nSQLite FTS5 replaced grepping transcripts.'),
    page('room:trading', 'Robinhood-Chain-Vitals', 'Mean transaction fee rose to $0.475 on 2026-09-03.'),
    page('shared', 'Home', 'Front door. Lists every page.'),
  ], read)
  assert.equal(search.stats().pages, 3)
  const fees = search.search('transaction fee')
  assert.deepEqual(fees.map(hit => hit.name), ['Robinhood-Chain-Vitals'])
  assert.ok(fees[0].snippet.some(part => part.match && /transaction/i.test(part.text)))
  assert.equal(fees[0].source, 'room:trading')
  const byName = search.search('session search')
  assert.equal(byName[0].name, 'feather-session-search-index')
  assert.deepEqual(search.search('nothing-here-at-all'), [])
  assert.deepEqual(search.search('   '), [])
  assert.deepEqual(search.search('AND OR NOT "unbalanced'), [], 'operators never raise')
})

test('wiki search re-reads a changed page and forgets a removed one', async t => {
  const search = createWikiSearch()
  t.after(() => search.close())
  let reads = 0
  const counting = page => { reads++; return page.content }
  const a = page('shared', 'alpha', 'The first draft mentions pelicans.')
  const b = page('shared', 'beta', 'Nothing of note.')
  await search.sync([a, b], counting)
  assert.equal(reads, 2)
  await search.sync([a, b], counting)
  assert.equal(reads, 2, 'unchanged pages are not re-read')
  const a2 = page('shared', 'alpha', 'The second draft mentions herons instead.', '2026-09-19T01:00:00.000Z')
  await search.sync([a2], counting)
  assert.equal(reads, 3)
  assert.deepEqual(search.search('pelicans'), [])
  assert.equal(search.search('herons')[0].name, 'alpha')
  assert.deepEqual(search.search('note'), [], 'a page no longer listed is dropped')
  assert.equal(search.stats().pages, 1)
})

test('wiki search skips pages whose content cannot be read', async t => {
  const search = createWikiSearch()
  t.after(() => search.close())
  await search.sync([page('shared', 'gone', 'x')], () => null)
  assert.equal(search.stats().pages, 0)
  await search.sync([page('shared', 'broken', 'x')], () => { throw new Error('boom') })
  assert.equal(search.stats().pages, 0)
})

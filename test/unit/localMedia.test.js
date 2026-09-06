import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { localFilePath, localFileUrl } from '../../frontend/src/lib/localMedia.js'

describe('localFilePath', () => {
  it('accepts absolute filesystem paths', () => {
    assert.equal(
      localFilePath('/home/user/rooms/family/rosalie_recent_24_48h.png'),
      '/home/user/rooms/family/rosalie_recent_24_48h.png',
    )
  })

  it('accepts home-relative and file:// forms', () => {
    assert.equal(localFilePath('~/plots/chart.png'), '~/plots/chart.png')
    assert.equal(localFilePath('file:///tmp/shot.png'), '/tmp/shot.png')
  })

  it('decodes percent-encoded paths', () => {
    assert.equal(localFilePath('/home/user/My%20Charts/a.png'), '/home/user/My Charts/a.png')
  })

  it('returns null for anything that is not a local file reference', () => {
    for (const ref of [
      'https://example.com/a.png', 'http://example.com/a.png', 'data:image/png;base64,AAAA',
      'blob:https://example.com/x', 'mailto:a@b.com', 'chart.png', 'images/chart.png', '', null, undefined,
      '/uploads/123-pasted-image.png', '/api/file?path=%2Ftmp%2Fx.png', '/assets/index.js', '/static/icon-192.png',
    ]) assert.equal(localFilePath(ref), null, String(ref))
    assert.equal(localFilePath('/feather2/api/file?path=%2Ftmp%2Fx.png', '/feather2/'), null)
  })
})

describe('localFileUrl', () => {
  it('routes local paths through /api/file with encoding', () => {
    assert.equal(
      localFileUrl('/home/user/rooms/family/rosalie_recent_24_48h.png'),
      '/api/file?path=%2Fhome%2Fuser%2Frooms%2Ffamily%2Frosalie_recent_24_48h.png',
    )
  })

  it('preserves a mounted application prefix', () => {
    assert.equal(
      localFileUrl('/tmp/chart.png', '/feather2/'),
      '/feather2/api/file?path=%2Ftmp%2Fchart.png',
    )
  })

  it('returns null for non-local references', () => {
    assert.equal(localFileUrl('https://example.com/a.png'), null)
    assert.equal(localFileUrl('/uploads/x.png'), null)
  })
})

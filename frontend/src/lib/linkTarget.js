import { appUrl } from './appPath.js'

export function addHeadingIds(root) {
  const ids = new Set(Array.from(root.querySelectorAll('[id]'), node => node.id))
  for (const heading of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (heading.id) continue
    const slug = (heading.textContent || '').toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section'
    let id = slug, n = 1
    while (ids.has(id)) id = `${slug}-${n++}`
    heading.id = id; ids.add(id)
  }
}

// One classifier for Markdown, raw HTML anchors, and file-preview links.
// Unknown executable schemes are never reinterpreted as local paths.
export function linkTarget(input, cwd, pathname) {
  if (typeof input !== 'string') return { kind: 'invalid' }
  let raw = input.trim()
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return { kind: 'invalid' }
  if (raw.startsWith('#')) return { kind: 'anchor', hash: raw.slice(1) }
  if (/^(https?:\/\/|mailto:|tel:)/i.test(raw) || raw.startsWith('//')) return { kind: 'web', href: raw }
  if (/^www\./i.test(raw)) return { kind: 'web', href: 'https://' + raw }
  for (const route of ['/api/file', appUrl('/api/file', pathname)]) {
    if (raw.startsWith(route + '?')) {
      const value = new URL(raw, 'https://feather.invalid').searchParams.get('path')
      return value && /^(\/|~\/)/.test(value) && !/[\u0000-\u001f\u007f]/.test(value) ? { kind: 'file', path: value } : { kind: 'invalid' }
    }
  }
  if (/^file:/i.test(raw)) {
    try { const url = new URL(raw); if (url.hostname && url.hostname !== 'localhost') return { kind: 'invalid' }; raw = url.pathname + url.hash }
    catch { return { kind: 'invalid' } }
  } else if (/^sandbox:\//i.test(raw)) raw = raw.slice('sandbox:'.length)
  else if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return { kind: 'invalid' }
  else if (['/api/', '/uploads/', '/assets/', '/static/', '/vnc'].some(p => raw.startsWith(p) || raw.startsWith(appUrl(p, pathname)))) return { kind: 'web', href: raw }
  const hashAt = raw.indexOf('#')
  const fragment = hashAt < 0 ? '' : raw.slice(hashAt + 1)
  raw = hashAt < 0 ? raw : raw.slice(0, hashAt)
  const queryAt = raw.indexOf('?')
  if (queryAt >= 0) raw = raw.slice(0, queryAt)
  try { raw = decodeURIComponent(raw) } catch { return { kind: 'invalid' } }
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return { kind: 'invalid' }
  const suffix = raw.match(/:(\d+)(?::\d+)?$/)
  const line = Number(suffix?.[1] || fragment.match(/^L?(\d+)/)?.[1]) || undefined
  if (suffix) raw = raw.slice(0, -suffix[0].length)
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return { kind: 'invalid' }
  if (!raw.startsWith('/') && !raw.startsWith('~/') && raw !== '~') {
    if (!cwd) return { kind: 'file', path: raw, relative: true, line, fragment }
    raw = cwd.replace(/\/$/, '') + '/' + raw
  }
  const home = raw.startsWith('~')
  const parts = []
  for (const p of raw.replace(/^~/, '').split('/')) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop(); else parts.push(p)
  }
  return { kind: 'file', path: (home ? '~/' : '/') + parts.join('/'), line, fragment }
}

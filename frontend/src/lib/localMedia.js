// Map media/link references that point at the local filesystem to the
// authenticated /api/file endpoint. Assistant messages often embed Markdown
// images like ![chart](/home/user/rooms/family/chart.png); the browser would
// request that as a site URL and render a broken image. Anything that is
// already a web URL, a data/blob URI, or an app-served route stays untouched.

import { appUrl } from './appPath.js'

const WEB_SCHEME_RE = /^(https?:|data:|blob:|mailto:)/i
const APP_ROUTES = ['/api/', '/uploads/', '/assets/', '/static/', '/vnc']

// Return the filesystem path a src/href refers to, or null if it is not a
// local file reference. Accepts /abs/path, ~/path, and file:// URLs.
export function localFilePath(src, pathname) {
  if (!src || typeof src !== 'string') return null
  if (WEB_SCHEME_RE.test(src)) return null
  if (APP_ROUTES.some(route => src.startsWith(route) || src.startsWith(appUrl(route, pathname)))) return null
  const raw = src.startsWith('file://') ? src.slice(7) : src
  if (!raw.startsWith('/') && !raw.startsWith('~/') && raw !== '~') return null
  try { return decodeURIComponent(raw) } catch { return raw }
}

// URL that serves the file through Feather's authenticated file endpoint,
// or null when src is not a local file reference.
export function localFileUrl(src, pathname) {
  const p = localFilePath(src, pathname)
  return p ? appUrl(`/api/file?path=${encodeURIComponent(p)}`, pathname) : null
}

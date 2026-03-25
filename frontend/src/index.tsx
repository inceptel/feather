import { render } from 'solid-js/web'
import App from './App'

let viewportSyncFrame = 0

function syncViewportHeight() {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--vh', `${viewportHeight * 0.01}px`)
}

function queueViewportSync() {
  if (viewportSyncFrame) cancelAnimationFrame(viewportSyncFrame)
  viewportSyncFrame = requestAnimationFrame(() => {
    viewportSyncFrame = 0
    syncViewportHeight()
  })
}

syncViewportHeight()
queueViewportSync()
window.addEventListener('resize', queueViewportSync)
window.addEventListener('load', queueViewportSync)
window.addEventListener('orientationchange', queueViewportSync)
window.addEventListener('pageshow', queueViewportSync)
window.addEventListener('focus', queueViewportSync)
window.addEventListener('scroll', queueViewportSync)
document.addEventListener('scroll', queueViewportSync)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) queueViewportSync()
})
window.visualViewport?.addEventListener('resize', queueViewportSync)
window.visualViewport?.addEventListener('scroll', queueViewportSync)

render(() => <App />, document.getElementById('root')!)

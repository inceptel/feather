import { render } from 'solid-js/web'
import App from './App'

function syncViewportHeight() {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--vh', `${viewportHeight * 0.01}px`)
}

syncViewportHeight()
window.addEventListener('resize', syncViewportHeight)
window.addEventListener('orientationchange', syncViewportHeight)
window.addEventListener('pageshow', syncViewportHeight)
window.addEventListener('focus', syncViewportHeight)
window.addEventListener('scroll', syncViewportHeight)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncViewportHeight()
})
window.visualViewport?.addEventListener('resize', syncViewportHeight)
window.visualViewport?.addEventListener('scroll', syncViewportHeight)

render(() => <App />, document.getElementById('root')!)

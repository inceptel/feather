import { render } from 'solid-js/web'
import App from './App'

function syncViewportHeight() {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--vh', `${viewportHeight * 0.01}px`)
}

syncViewportHeight()
window.addEventListener('resize', syncViewportHeight)
window.visualViewport?.addEventListener('resize', syncViewportHeight)

render(() => <App />, document.getElementById('root')!)

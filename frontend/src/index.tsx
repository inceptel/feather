import { render } from 'solid-js/web'
import App from './App'
import { initTheme } from './theme'

initTheme()
render(() => <App />, document.getElementById('root')!)

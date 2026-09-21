// App shell: header, navigation, connection indicator, and a tiny hash router.
// Each view module exports mount(el, params) and returns an unmount function
// that removes its listeners/channels, so navigating never leaks.
import './style.css'
import { checkSchema, onSchema } from './lib/schema.js'
import { connection, onConnection, startRealtime } from './lib/realtime.js'
import { initLiveStore, getEntries, subscribe } from './lib/live-store.js'
import { ago } from './lib/format.js'
import { setupPanel } from './lib/ui.js'
import * as live from './views/live.js'
import * as sessions from './views/sessions.js'
import * as sessionDetail from './views/session-detail.js'
import * as drivers from './views/drivers.js'
import * as dev from './views/dev.js'

document.querySelector('#app').innerHTML = `
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="#/live" aria-label="Smart Wheel — live overview">
        <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12.5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M5 17h6l2.5-5 4 9 2.5-4H27" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span><strong>Smart Wheel</strong><small>Biometric steering wheel</small></span>
      </a>
      <nav class="nav" aria-label="Main">
        <a href="#/live" data-nav="live">Live<span class="nav-count js-live-count" hidden></span></a>
        <a href="#/sessions" data-nav="sessions">Drives</a>
        <a href="#/drivers" data-nav="drivers">Drivers</a>
        <a href="#/dev" data-nav="dev">Developer feed</a>
      </nav>
      <div class="conn js-conn" role="status" aria-live="polite">
        <span class="conn-dot" aria-hidden="true"></span>
        <span class="js-conn-label">Connecting…</span>
        <span class="conn-fresh js-fresh"></span>
      </div>
    </div>
  </header>
  <div class="js-banner banner-wrap"></div>
  <main id="main" class="page" tabindex="-1"></main>
  <footer class="footer">
    <p><strong>Prototype — not for medical use.</strong> Readings come from a finger sensor on a steering wheel and can be affected by movement and grip.</p>
  </footer>`

const main = document.querySelector('#main')
const connEl = document.querySelector('.js-conn')
const connLabel = document.querySelector('.js-conn-label')
const freshEl = document.querySelector('.js-fresh')
const banner = document.querySelector('.js-banner')
const liveCount = document.querySelector('.js-live-count')

// ------------------------------------------------------------ indicators --
const CONN_TEXT = { connecting: 'Connecting…', connected: 'Live', reconnecting: 'Reconnecting…' }
onConnection(({ state }) => {
  connEl.dataset.state = state
  connLabel.textContent = CONN_TEXT[state]
})
setInterval(() => {
  freshEl.textContent = connection.lastUpdateAt ? `· updated ${ago(Date.now() - connection.lastUpdateAt)}` : ''
}, 1000)

onSchema(({ v3 }) => {
  banner.innerHTML = v3 === false ? `<div class="banner">${setupPanel()}</div>` : ''
})

// Number of live drives, shown on the "Live" tab from any page.
subscribe(() => {
  const n = getEntries().filter((e) => e.status === 'active').length
  liveCount.hidden = !n
  liveCount.textContent = n
  liveCount.setAttribute('aria-label', `${n} active`)
})

// ---------------------------------------------------------------- router --
const TITLES = { live: 'Live', sessions: 'Drives', drivers: 'Drivers', dev: 'Developer feed' }
let unmount = null
let first = true

function route() {
  const raw = location.hash.replace(/^#\/?/, '') || 'live'
  const [path, qs = ''] = raw.split('?')
  const [section, id] = path.split('/')
  const query = new URLSearchParams(qs)

  let view = live
  let params = {}
  if (section === 'live') params = { id: id || null }
  else if (section === 'sessions') view = id ? sessionDetail : sessions
  else if (section === 'drivers') view = drivers
  else if (section === 'dev') view = dev
  else {
    location.replace('#/live')
    return
  }
  if (section === 'sessions') params = { id, query }

  unmount?.()
  main.innerHTML = ''
  window.scrollTo(0, 0)
  unmount = view.mount(main, params)

  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })
  document.title = `${id && section === 'sessions' ? 'Drive' : TITLES[section]} · Smart Wheel`
  // Move focus to the new page for keyboard and screen-reader users.
  if (!first) main.focus({ preventScroll: true })
  first = false
}

// Schema first (decides the fallbacks), then Realtime and the live store.
const { v3 } = await checkSchema()
startRealtime({ v3 })
initLiveStore()
window.addEventListener('hashchange', route)
route()

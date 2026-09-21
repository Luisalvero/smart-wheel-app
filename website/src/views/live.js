// Live overview (#/live) and focused live view (#/live/:id).
//
// Rules:
//   * one active drive  -> it is focused automatically (big charts)
//   * several           -> a grid of cards; click one to focus it
//   * none              -> "all quiet", plus drives that just finished
// When a focused drive ends, the view turns into its summary in place.
// Rendering is throttled to one pass per animation frame.
import {
  alertState,
  getEntries,
  getEntry,
  initLiveStore,
  latest,
  liveState,
  liveStore,
  rangeCheck,
  subscribe,
} from '../lib/live-store.js'
import { vitalsChart, drawSparkline } from '../lib/charts.js'
import { ago, clock, duration, esc, num, smartNum } from '../lib/format.js'
import { errorBox, loading } from '../lib/ui.js'
import { schema } from '../lib/schema.js'
import { summaryHtml } from './summary.js'

const PILL_ICON = {
  streaming: '<span class="pulse" aria-hidden="true"></span>',
}

function pill(state) {
  return `<span class="pill pill-${state.key}" ${state.detail ? `title="${esc(state.detail)}"` : ''}>${PILL_ICON[state.key] ?? '<span class="pill-dot" aria-hidden="true"></span>'}${esc(state.label)}</span>`
}

/** Calm banner for an open or recently escalated drive alert. */
function alertHtml(st) {
  if (!st) return ''
  const icon = st.level === 'escalated'
    ? '<path d="M12 3 2 20h20L12 3Zm0 6v5m0 3v.01" />'
    : '<circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4v.01" />'
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
    <div><strong>${esc(st.title)}</strong><span>${esc(st.detail)}</span></div>`
}

function updateAlert(el, e, now, prev) {
  const st = e.status === 'active' ? alertState(e, now) : null
  const html = alertHtml(st)
  if (html !== prev.alert) {
    prev.alert = html
    el.innerHTML = html
    el.hidden = !st
    el.dataset.level = st?.level ?? ''
  }
}

function nameBlock(e, tag = 'h3') {
  return `<${tag} class="driver-name">${esc(e.name ?? 'Driver')}</${tag}>${
    e.customId ? `<span class="custom-id">${esc(e.customId)}</span>` : ''
  }`
}

function elapsedSeconds(e, now) {
  return ((e.endedAt ?? now) - e.startedAt) / 1000
}

function baselineText(e) {
  const b = e.baseline
  if (!b) {
    return schema.v3 === false
      ? 'Usual range appears after the v3 database update.'
      : 'Learning this driver’s usual range — no finished drives yet.'
  }
  if (!b.established) return `Learning this driver’s usual range · ${num(b.readings)} of 60 readings`
  return `<span class="band-swatch" aria-hidden="true"></span>Usual range ${num(b.bpm_p10)}–${num(b.bpm_p90)} bpm · from ${num(b.sessions)} drive${b.sessions == 1 ? '' : 's'}`
}

// --------------------------------------------------------------- card ----
function buildCard(e) {
  const root = document.createElement('a')
  root.className = 'card live-card'
  root.href = `#/live/${e.id}`
  root.innerHTML = `
    <div class="card-head"><div class="who">${nameBlock(e)}</div><span class="js-pill"></span></div>
    <div class="alert-banner js-alert-banner" role="status" hidden></div>
    <div class="vitals">
      <div class="vital is-bpm"><span class="v-label">Heart rate</span><span class="v-value"><b class="js-bpm">—</b><small>bpm</small></span></div>
      <div class="vital is-spo2"><span class="v-label">SpO₂</span><span class="v-value"><b class="js-spo2">—</b><small>%</small></span></div>
    </div>
    <canvas class="spark" aria-hidden="true"></canvas>
    <div class="card-foot"><span>Driving <b class="js-elapsed">0:00</b></span><span class="js-fresh"></span></div>`
  const $ = (s) => root.querySelector(s)
  const prev = { alert: '' }
  const refs = { banner: $('.js-alert-banner'), pill: $('.js-pill'), bpm: $('.js-bpm'), spo2: $('.js-spo2'), elapsed: $('.js-elapsed'), fresh: $('.js-fresh'), spark: $('.spark') }
  let drawn = -1
  return {
    root,
    update(e, now) {
      const st = liveState(e, now)
      refs.pill.innerHTML = pill(st)
      updateAlert(refs.banner, e, now, prev)
      const b = latest(e, 'bpm')
      const s = latest(e, 'spo2')
      refs.bpm.textContent = smartNum(b?.value)
      refs.spo2.textContent = smartNum(s?.value)
      root.classList.toggle('is-stale', e.lastUsable === false || st.key === 'quiet')
      refs.elapsed.textContent = clock(elapsedSeconds(e, now))
      refs.fresh.textContent = e.t.length ? `updated ${ago(now - e.t[e.t.length - 1])}` : ''
      root.setAttribute('aria-label', `${e.name ?? 'Driver'}: ${st.label}, heart rate ${smartNum(b?.value)} bpm, SpO2 ${smartNum(s?.value)} percent. Open live view.`)
      if (drawn !== e.version) {
        drawSparkline(refs.spark, e.bpm, '--bpm')
        drawn = e.version
      }
    },
    destroy() {},
  }
}

function finishedCardHtml(e) {
  const s = e.summary
  const r = (v) => smartNum(v != null ? Math.round(v) : null)
  // Percentiles need the v3 views; before that, fall back to min/avg/max.
  const cells = s?.bpm_p05 != null || !s
    ? [['Realistic low', r(s?.bpm_p05)], ['Median', r(s?.bpm_median)], ['Realistic high', r(s?.bpm_p95)]]
    : [['Lowest', r(s.bpm_min)], ['Average', r(s.bpm_avg)], ['Highest', r(s.bpm_max)]]
  return `
    <a class="card done-card" href="#/sessions/${e.id}">
      <div class="card-head"><div class="who">${nameBlock(e)}</div>${pill({ key: 'ended', label: 'Finished' })}</div>
      <p class="muted">${duration(e.durationSeconds)} drive · heart rate (bpm)</p>
      <dl class="mini-stats">
        ${cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
      </dl>
      <span class="card-link">View drive details →</span>
    </a>`
}

// -------------------------------------------------------------- focus ----
function buildFocus(e, { showBack }) {
  const root = document.createElement('section')
  root.className = 'focus'
  root.setAttribute('aria-label', `Live view for ${e.name ?? 'driver'}`)
  root.innerHTML = `
    ${showBack ? '<a class="back" href="#/live">← All active drives</a>' : ''}
    <div class="focus-head">
      <div class="who">${nameBlock(e, 'h2')}</div>
      <div class="focus-status"><span class="js-pill" aria-live="polite"></span><span class="elapsed"><span class="js-elapsed-label">Driving</span> <b class="js-elapsed">0:00</b></span></div>
    </div>
    <div class="alert-banner alert-banner-lg js-alert-banner" role="status" aria-live="polite" hidden></div>
    <div class="focus-body">
      <div class="now-panel js-now">
        <div class="big-vital is-bpm">
          <span class="v-label">Heart rate</span>
          <span class="big" aria-live="polite"><b class="js-bpm">—</b><small>bpm</small></span>
        </div>
        <div class="big-vital is-spo2">
          <span class="v-label">Blood oxygen (SpO₂)</span>
          <span class="big" aria-live="polite"><b class="js-spo2">—</b><small>%</small></span>
        </div>
        <p class="baseline js-baseline"></p>
        <div class="range-alert js-alert" role="status" hidden></div>
      </div>
      <div class="summary-panel js-summary" hidden></div>
      <div class="charts">
        <figure class="chart-fig is-bpm">
          <figcaption><span class="swatch" aria-hidden="true"></span>Heart rate <span class="muted">· last 10 minutes</span></figcaption>
          <div class="chart js-bpm-chart" role="img" aria-label="Heart rate over the last 10 minutes"></div>
        </figure>
        <figure class="chart-fig is-spo2">
          <figcaption><span class="swatch" aria-hidden="true"></span>SpO₂ <span class="muted">· last 10 minutes</span></figcaption>
          <div class="chart js-spo2-chart" role="img" aria-label="Blood oxygen over the last 10 minutes"></div>
        </figure>
        <p class="fine">Drag across a chart to zoom, double-click to reset. Gaps mean no usable reading (e.g. hand off the sensor).</p>
      </div>
    </div>`
  const $ = (s) => root.querySelector(s)
  const refs = {
    pill: $('.js-pill'), elapsed: $('.js-elapsed'), elapsedLabel: $('.js-elapsed-label'),
    bpm: $('.js-bpm'), spo2: $('.js-spo2'), baseline: $('.js-baseline'), alert: $('.js-alert'),
    now: $('.js-now'), summary: $('.js-summary'), banner: $('.js-alert-banner'),
  }
  let current = e
  const band = () => {
    const b = current.baseline
    return b?.established ? [Number(b.bpm_p10), Number(b.bpm_p90)] : null
  }
  let bpmChart = null
  let spo2Chart = null
  // Charts need the element in the document to measure its width.
  const mountCharts = () => {
    bpmChart = vitalsChart($('.js-bpm-chart'), { label: 'Heart rate', unit: 'bpm', color: '--bpm', height: 260, soft: [55, 100], band, sync: 'live' })
    spo2Chart = vitalsChart($('.js-spo2-chart'), { label: 'SpO₂', unit: '%', color: '--spo2', height: 160, soft: [90, 100], sync: 'live' })
  }
  let drawn = -1
  let shownSummary = null
  let last = { bpm: null, spo2: null, pill: '', alert: '' }

  return {
    root,
    mountCharts,
    update(e, now) {
      current = e
      const st = liveState(e, now)
      const pillHtml = pill(st)
      if (pillHtml !== last.pill) refs.pill.innerHTML = last.pill = pillHtml
      refs.elapsed.textContent = e.status === 'active' ? clock(elapsedSeconds(e, now)) : duration(e.durationSeconds)
      refs.elapsedLabel.textContent = e.status === 'active' ? 'Driving' : 'Drove'
      updateAlert(refs.banner, e, now, last)

      if (e.status === 'active') {
        const b = smartNum(latest(e, 'bpm')?.value)
        const s = smartNum(latest(e, 'spo2')?.value)
        if (b !== last.bpm) refs.bpm.textContent = last.bpm = b
        if (s !== last.spo2) refs.spo2.textContent = last.spo2 = s
        refs.now.classList.toggle('is-stale', e.lastUsable === false || st.key === 'quiet')
        refs.baseline.innerHTML = baselineText(e)
        const rc = rangeCheck(e)
        const outside = !!rc?.outside && st.key === 'streaming'
        root.classList.toggle('is-outside', outside)
        refs.alert.hidden = !outside
        if (outside)
          refs.alert.textContent = `Heart rate is ${rc.direction} this driver’s usual range — ${Math.round(rc.median)} bpm over the last 10 s (usual ${Math.round(rc.low + 15)}–${Math.round(rc.high - 15)}).`
      } else if (shownSummary !== e.summary) {
        // The drive just ended: swap the live numbers for its summary.
        shownSummary = e.summary
        root.classList.remove('is-outside')
        root.classList.add('is-ended')
        refs.now.hidden = true
        refs.summary.hidden = false
        refs.summary.innerHTML = `
          <div class="summary-head"><h3>Drive summary</h3><a class="btn btn-quiet" href="#/sessions/${e.id}">Full drive & details →</a></div>
          ${e.summary ? summaryHtml(e.summary, { durationSeconds: e.durationSeconds }) : loading('Calculating summary…')}`
      }

      if (drawn !== e.version && bpmChart) {
        bpmChart.setData(e.t, e.bpm)
        spo2Chart.setData(e.t, e.spo2)
        drawn = e.version
      }
    },
    destroy() {
      bpmChart?.destroy()
      spo2Chart?.destroy()
    },
  }
}

// --------------------------------------------------------------- view ----
export function mount(el, { id: focusId = null } = {}) {
  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${focusId ? 'Live drive' : 'Live now'}</h1>
        <p class="lede js-lede">Drives appear here automatically the moment they start.</p>
      </div>
    </div>
    <div class="js-main">${loading('Looking for active drives…')}</div>
    <section class="finished" hidden aria-labelledby="finished-h">
      <h2 id="finished-h">Just finished</h2>
      <div class="card-grid js-finished"></div>
    </section>`
  const main = el.querySelector('.js-main')
  const lede = el.querySelector('.js-lede')
  const finishedSec = el.querySelector('.finished')
  const finishedGrid = el.querySelector('.js-finished')

  let mode = null
  let focus = null
  let grid = null
  const cards = new Map()
  let lastAuto = null
  let finishedKey = ''
  let frame = 0

  function clearMain() {
    focus?.destroy()
    focus = null
    cards.forEach((c) => c.destroy())
    cards.clear()
    grid = null
    main.innerHTML = ''
  }

  function render() {
    frame = 0
    if (!liveStore.loaded) return
    const now = Date.now()
    const all = getEntries()
    const active = all.filter((e) => e.status === 'active').sort((a, b) => a.startedAt - b.startedAt)
    if (active.length === 1) lastAuto = active[0].id
    else if (active.length > 1) lastAuto = null

    const target =
      focusId ?? (active.length === 1 ? active[0].id : active.length === 0 && lastAuto && getEntry(lastAuto) ? lastAuto : null)
    const targetEntry = target ? getEntry(target) : null
    const nextMode = liveStore.error && !all.length ? 'error'
      : target ? (targetEntry ? `focus:${target}` : `missing:${target}`)
      : active.length ? 'grid' : 'empty'

    if (nextMode !== mode) {
      clearMain()
      mode = nextMode
      if (mode === 'error') {
        main.innerHTML = errorBox(`Could not load live drives: ${liveStore.error}`)
      } else if (mode.startsWith('focus:')) {
        focus = buildFocus(targetEntry, { showBack: !!focusId })
        main.append(focus.root)
        focus.mountCharts()
      } else if (mode.startsWith('missing:')) {
        main.innerHTML = `
          <div class="empty">
            <h2>This drive isn’t live right now</h2>
            <p>It may have finished, or the phone stopped reporting.</p>
            <p><a class="btn" href="#/sessions/${esc(target)}">See the drive’s details</a> <a class="btn btn-quiet" href="#/live">Back to live overview</a></p>
          </div>`
      } else if (mode === 'grid') {
        grid = document.createElement('div')
        grid.className = 'card-grid'
        main.append(grid)
      } else {
        main.innerHTML = `
          <div class="empty">
            <svg class="empty-icon" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="24" r="5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 7v12M8.5 30l11-3.5M39.5 30l-11-3.5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>
            <h2>All quiet</h2>
            <p>No one is driving right now. When a driver starts a drive in the phone app, it will show up here within a second — no need to refresh.</p>
          </div>`
      }
    }

    if (focus && targetEntry) focus.update(targetEntry, now)

    if (grid) {
      for (const [id, c] of cards) {
        if (!active.some((e) => e.id === id)) {
          c.root.remove()
          cards.delete(id)
        }
      }
      for (const e of active) {
        let c = cards.get(e.id)
        if (!c) {
          c = buildCard(e)
          cards.set(e.id, c)
        }
        grid.append(c.root) // keeps order stable (oldest drive first)
        c.update(e, now)
      }
    }

    // Finished drives other than the one on screen.
    const done = all.filter((e) => e.status !== 'active' && e.id !== target).sort((a, b) => b.endedAt - a.endedAt)
    const key = done.map((e) => `${e.id}:${e.version}`).join('|')
    if (key !== finishedKey) {
      finishedKey = key
      finishedSec.hidden = !done.length
      finishedGrid.innerHTML = done.map(finishedCardHtml).join('')
    }

    lede.textContent =
      active.length === 0
        ? 'No active drives. New drives appear here automatically.'
        : active.length === 1
          ? '1 drive in progress · updates arrive live, no refresh needed.'
          : `${active.length} drives in progress · choose one to follow it closely.`
  }

  const schedule = () => {
    frame ||= requestAnimationFrame(render)
  }
  const off = subscribe(schedule)
  const tick = setInterval(schedule, 1000) // elapsed timers and "quiet" detection
  initLiveStore().then(schedule)

  return () => {
    off()
    clearInterval(tick)
    cancelAnimationFrame(frame)
    clearMain()
  }
}

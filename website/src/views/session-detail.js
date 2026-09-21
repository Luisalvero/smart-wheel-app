// One drive (#/sessions/:id): summary, full BPM/SpO2 chart, and — when the
// drive was recorded in full-waveform mode — the "Unfold waveform" archive.
import {
  fetchAlerts,
  fetchAllTelemetry,
  fetchArchiveRow,
  fetchBaseline,
  fetchSummary,
} from '../lib/data.js'
import { on } from '../lib/realtime.js'
import { schema } from '../lib/schema.js'
import { vitalsChart } from '../lib/charts.js'
import { ChecksumError, downloadAndUnfold } from '../lib/archive.js'
import { bytes, dateTime, dateTimeSeconds, esc, num } from '../lib/format.js'
import { ALERT_KIND } from '../lib/live-store.js'
import { errorBox, loading } from '../lib/ui.js'
import { summaryHtml } from './summary.js'
import { renderWaveform } from './waveform.js'

export function mount(el, { id }) {
  let alive = true
  const cleanups = []
  const t = []
  const bpm = []
  const spo2 = []
  let charts = null
  let baseline = null
  let summary = null
  let raf = 0

  el.innerHTML = `
    <a class="back" href="#/sessions">← All drives</a>
    <div class="js-head">${loading('Loading drive…')}</div>
    <div class="js-body" hidden>
      <section class="panel" aria-labelledby="sum-h"><h2 id="sum-h" class="panel-title">Summary</h2><div class="js-summary"></div></section>
      <section class="panel" aria-labelledby="chart-h">
        <h2 id="chart-h" class="panel-title">Heart rate & SpO₂ over the drive</h2>
        <p class="js-progress muted" role="status"></p>
        <figure class="chart-fig is-bpm"><figcaption><span class="swatch" aria-hidden="true"></span>Heart rate <span class="muted js-band-note"></span></figcaption><div class="chart js-bpm" role="img" aria-label="Heart rate over the drive"></div></figure>
        <figure class="chart-fig is-spo2"><figcaption><span class="swatch" aria-hidden="true"></span>SpO₂</figcaption><div class="chart js-spo2" role="img" aria-label="Blood oxygen over the drive"></div></figure>
        <p class="fine">Drag across a chart to zoom, double-click to reset. Gaps mean no usable reading.</p>
      </section>
      <section class="panel" aria-labelledby="alerts-h"><h2 id="alerts-h" class="panel-title">Alerts</h2><div class="js-alerts"></div></section>
      <section class="panel" aria-labelledby="arc-h"><h2 id="arc-h" class="panel-title">Full waveform</h2><div class="js-archive"></div></section>
    </div>`
  const $ = (s) => el.querySelector(s)

  function renderHead(s) {
    const live = s.status === 'active'
    $('.js-head').innerHTML = `
      <div class="page-head">
        <div>
          <h1>${esc(s.display_name ?? 'Driver')} ${s.custom_id ? `<span class="custom-id">${esc(s.custom_id)}</span>` : ''}</h1>
          <p class="lede">Drive started ${esc(dateTime(s.started_at))}${s.ended_at ? ` · ended ${esc(dateTime(s.ended_at))}` : ''}</p>
        </div>
        ${live ? `<a class="btn" href="#/live/${esc(s.session_id)}"><span class="pulse" aria-hidden="true"></span>Watch live</a>` : ''}
      </div>`
  }

  function drawCharts() {
    if (!charts) return
    charts.bpm.setData(t, bpm)
    charts.spo2.setData(t, spo2)
  }

  async function loadTelemetry() {
    const progress = $('.js-progress')
    progress.textContent = 'Loading readings…'
    const rows = await fetchAllTelemetry(id, (n) => {
      if (alive) progress.textContent = `Loading readings… ${num(n)}`
    })
    if (!alive) return
    for (const r of rows) {
      t.push(Date.parse(r.received_at))
      bpm.push(r.bpm)
      spo2.push(r.spo2)
    }
    progress.textContent = rows.length ? `${num(rows.length)} readings` : 'No readings were recorded for this drive.'
    drawCharts()
  }

  // drive_alerts rows for this drive, kept by id so Realtime can update them.
  const alerts = new Map()
  let alertsAvailable = true

  function renderAlerts() {
    const box = $('.js-alerts')
    if (!alertsAvailable) {
      box.innerHTML = '<p class="muted">Alerts appear once the v3 database update is run (see the notice above).</p>'
      return
    }
    const list = [...alerts.values()].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
    if (!list.length) {
      box.innerHTML = '<p class="muted">No alerts during this drive.</p>'
      return
    }
    const unit = (a) => (a.kind === 'spo2_low' ? '%' : ' bpm')
    const NO_VALUE = new Set(['no_contact', 'irregular_rhythm'])
    const outcome = (a) => {
      const at = a.responded_at ? ` at ${esc(dateTimeSeconds(a.responded_at))}` : ''
      const how = a.channel === 'voice' ? ' by voice' : a.channel === 'button' ? ' by button' : ''
      if (a.response === 'ok') return `<span class="badge badge-active">Driver said OK${how}</span><span class="muted">${at}</span>`
      if (a.response === 'not_ok' || a.response === 'unwell') return `<span class="badge badge-danger">Driver said not OK${how}</span><span class="muted">${at}</span>`
      if (a.response === 'no_response') return `<span class="badge badge-interrupted">No answer</span>`
      if (a.response === 'recovered') return `<span class="badge badge-active">Recovered on its own</span>`
      if (a.response === 'unconfirmed') return `<span class="badge badge-interrupted">Not confirmed (poor signal)</span>`
      if (a.level === 'notice') return `<span class="badge">Logged</span>`
      return `<span class="badge badge-interrupted">Open — waiting for driver</span>`
    }
    box.innerHTML = `
      <ol class="alert-list">
        ${list
          .map(
            (a) => `
          <li>
            <div class="alert-when">${esc(dateTimeSeconds(a.started_at))}</div>
            <div class="alert-what"><strong>${esc(ALERT_KIND[a.kind] ?? a.kind)}</strong>${a.level && a.level !== 'notice' ? ` <span class="badge ${a.level === 'critical' ? 'badge-danger' : 'badge-interrupted'}">${esc(a.level)}</span>` : ''}
              <span class="muted">${a.value != null && !NO_VALUE.has(a.kind) ? `${Math.round(a.value)}${unit(a)} (5-s median)` : ''}${a.threshold != null && !NO_VALUE.has(a.kind) ? ` · limit ${Math.round(a.threshold)}${unit(a)}` : ''}</span></div>
            <div class="alert-outcome">${outcome(a)}${a.escalated ? ' <span class="badge badge-danger" title="Nobody is actually contacted in this prototype">Escalated (simulated)</span>' : ''}</div>
          </li>`
          )
          .join('')}
      </ol>
      <p class="fine">Escalation is simulated in this prototype: it is recorded, but nobody is contacted.</p>`
  }

  async function loadAlerts() {
    const rows = await fetchAlerts(id).catch(() => null)
    if (!alive) return
    alertsAvailable = rows !== null
    for (const a of rows ?? []) alerts.set(a.id, a)
    renderAlerts()
  }

  async function loadArchive() {
    const box = $('.js-archive')
    if (schema.v3 === false) {
      box.innerHTML = '<p class="muted">Waveform archives appear once the v3 database update is run (see the notice above).</p>'
      return
    }
    let row
    try {
      row = await fetchArchiveRow(id)
    } catch (err) {
      box.innerHTML = err.missing
        ? '<p class="muted">Waveform archives appear once the v3 database update is run (see the notice above).</p>'
        : errorBox(err.message)
      return
    }
    if (!alive) return
    if (!row) {
      box.innerHTML = `<p class="muted">No waveform archive for this drive. Drives recorded in “vitals only” mode keep heart rate and SpO₂, not the raw sensor waveform.</p>`
      return
    }
    box.innerHTML = `
      <div class="archive-card">
        <div>
          <p><strong>Folded archive available</strong></p>
          <p class="muted">${num(row.sample_count)} samples at ${esc(row.sample_rate_hz)} Hz · ${bytes(row.packed_bytes)} folded (${bytes(row.raw_bytes)} unfolded)</p>
        </div>
        <button class="btn js-unfold">Unfold waveform</button>
      </div>
      <p class="js-arc-status muted" role="status"></p>
      <div class="js-wave"></div>`
    const btn = box.querySelector('.js-unfold')
    const status = box.querySelector('.js-arc-status')
    btn.addEventListener('click', async () => {
      btn.disabled = true
      status.classList.remove('error-text')
      try {
        const result = await downloadAndUnfold(row, (s) => (status.textContent = s))
        if (!alive) return
        status.textContent = ''
        box.querySelector('.archive-card').hidden = true
        cleanups.push(
          renderWaveform(box.querySelector('.js-wave'), { ...result, sampleRateHz: row.sample_rate_hz, verified: true })
        )
      } catch (err) {
        status.classList.add('error-text')
        status.textContent =
          err instanceof ChecksumError ? `Integrity check failed. ${err.message}` : `Could not unfold the archive: ${err.message}`
        btn.disabled = false
      }
    })
  }

  ;(async () => {
    try {
      summary = await fetchSummary(id)
    } catch (err) {
      $('.js-head').innerHTML = errorBox(`Could not load this drive: ${err.message}`)
      return
    }
    if (!alive) return
    if (!summary) {
      $('.js-head').innerHTML = `<div class="empty"><h2>Drive not found</h2><p>It may have been deleted.</p><p><a class="btn" href="#/sessions">See all drives</a></p></div>`
      return
    }
    renderHead(summary)
    $('.js-summary').innerHTML = summaryHtml(summary)
    $('.js-body').hidden = false

    baseline = await fetchBaseline(summary.profile_id).catch(() => null)
    if (!alive) return
    const band = () => (baseline?.established ? [Number(baseline.bpm_p10), Number(baseline.bpm_p90)] : null)
    if (band()) $('.js-band-note').innerHTML = `· <span class="band-swatch" aria-hidden="true"></span>shaded: usual range ${num(baseline.bpm_p10)}–${num(baseline.bpm_p90)} bpm`
    charts = {
      bpm: vitalsChart($('.js-bpm'), { label: 'Heart rate', unit: 'bpm', color: '--bpm', height: 280, soft: [55, 100], band, sync: 'detail' }),
      spo2: vitalsChart($('.js-spo2'), { label: 'SpO₂', unit: '%', color: '--spo2', height: 170, soft: [90, 100], sync: 'detail' }),
    }
    await Promise.all([
      loadTelemetry().catch((err) => ($('.js-progress').textContent = `Could not load readings: ${err.message}`)),
      loadArchive(),
      loadAlerts(),
    ])
  })()

  // While the drive is still live, keep its chart growing and refresh the
  // summary when it ends.
  cleanups.push(
    on('telemetry', (r) => {
      if (r.session_id !== id || !charts) return
      t.push(Date.parse(r.received_at))
      bpm.push(r.bpm)
      spo2.push(r.spo2)
      raf ||= requestAnimationFrame(() => {
        raf = 0
        drawCharts()
      })
    }),
    on('session', async ({ new: row }) => {
      if (row?.id !== id || !summary || row.status === summary.status) return
      summary = await fetchSummary(id).catch(() => summary)
      if (!alive || !summary) return
      renderHead(summary)
      $('.js-summary').innerHTML = summaryHtml(summary)
    }),
    on('alert', (row) => {
      if (row.session_id !== id) return
      if (row._deleted) alerts.delete(row.id)
      else alerts.set(row.id, row)
      alertsAvailable = true
      renderAlerts()
    }),
    on('archive', (row) => {
      if (row.session_id === id) loadArchive()
    })
  )

  return () => {
    alive = false
    cancelAnimationFrame(raf)
    cleanups.forEach((fn) => fn())
    charts?.bpm.destroy()
    charts?.spo2.destroy()
  }
}

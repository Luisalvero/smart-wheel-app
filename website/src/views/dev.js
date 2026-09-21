// Developer feed (#/dev): the team's original page — the latest rows of
// public.test_readings with a live INSERT subscription — plus a local
// inspector for .ppga archive files.
import { supabase } from '../supabase.js'
import { fetchTestReadings } from '../lib/data.js'
import { touch } from '../lib/realtime.js'
import { esc, dateTimeSeconds } from '../lib/format.js'
import { unfoldBytes, sha256Hex } from '../lib/archive.js'
import { renderWaveform } from './waveform.js'

const MAX_READINGS = 50

export function mount(el) {
  let readings = []
  let alive = true
  let destroyWave = null

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Developer feed</h1><p class="lede">Raw rows from the <code>test_readings</code> table, as the team’s original page showed them. New rows appear live.</p></div>
      <p class="js-status feed-status" role="status">Loading readings…</p>
    </div>
    <div class="panel">
      <table class="table dev-table">
        <caption class="sr-only">Latest test readings</caption>
        <thead><tr><th scope="col">ID</th><th scope="col" class="num">Value</th><th scope="col">Device</th><th scope="col">Received</th></tr></thead>
        <tbody class="js-rows"></tbody>
      </table>
      <p class="js-empty muted" hidden>No readings have been received yet.</p>
    </div>
    <section class="panel" aria-labelledby="inspect-h">
      <h2 id="inspect-h" class="panel-title">Inspect a local archive</h2>
      <p class="muted">Open a <code>.ppga</code> file from disk to unfold and plot it (nothing is uploaded).</p>
      <input class="js-file" type="file" accept=".ppga,application/octet-stream" aria-label="Choose a .ppga archive file" />
      <p class="js-file-status muted" role="status"></p>
      <div class="js-wave"></div>
    </section>`
  const status = el.querySelector('.js-status')
  const body = el.querySelector('.js-rows')
  const empty = el.querySelector('.js-empty')

  function showStatus(message, isError = false) {
    status.textContent = message
    status.className = `js-status feed-status ${isError ? 'error-text' : 'ok-text'}`
  }

  function render(newId = null) {
    empty.hidden = readings.length > 0
    body.innerHTML = readings
      .map(
        (r) => `<tr class="${r.id === newId ? 'flash' : ''}">
          <td data-label="ID">${esc(r.id)}</td>
          <td data-label="Value" class="num">${esc(r.value)}</td>
          <td data-label="Device">${esc(r.device_name)}</td>
          <td data-label="Received">${esc(dateTimeSeconds(r.created_at))}</td></tr>`
      )
      .join('')
  }

  fetchTestReadings(MAX_READINGS)
    .then((rows) => {
      if (!alive) return
      readings = rows
      render()
      showStatus('Connected — waiting for live readings.')
    })
    .catch((err) => showStatus(`Could not load readings: ${err.message}`, true))

  // The original page's own channel, removed when leaving this tab.
  const channel = supabase
    .channel('test-readings-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'test_readings' }, (payload) => {
      touch()
      readings = [payload.new, ...readings.filter((r) => r.id !== payload.new.id)].slice(0, MAX_READINGS)
      render(payload.new.id)
      showStatus('Live update received.')
    })
    .subscribe((s) => {
      if (s === 'SUBSCRIBED' && readings.length) showStatus('Connected — live updates enabled.')
      if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT')
        showStatus('Connected, but live updates could not start. Check Supabase Realtime settings.', true)
    })

  // Local archive inspector.
  const fileStatus = el.querySelector('.js-file-status')
  el.querySelector('.js-file').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0]
    if (!file) return
    destroyWave?.()
    destroyWave = null
    el.querySelector('.js-wave').innerHTML = ''
    fileStatus.classList.remove('error-text')
    try {
      fileStatus.textContent = 'Unfolding…'
      const bytes = new Uint8Array(await file.arrayBuffer())
      const sha = await sha256Hex(bytes)
      const result = unfoldBytes(bytes)
      fileStatus.textContent = `${file.name} · SHA-256 ${sha.slice(0, 16)}…`
      destroyWave = renderWaveform(el.querySelector('.js-wave'), result)
    } catch (err) {
      fileStatus.classList.add('error-text')
      fileStatus.textContent = `Could not unfold ${file.name}: ${err.message}`
    }
  })

  return () => {
    alive = false
    supabase.removeChannel(channel)
    destroyWave?.()
  }
}

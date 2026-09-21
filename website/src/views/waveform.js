// Raw PPG waveform viewer for an unfolded archive: red and IR channels as two
// stacked charts that always show the same time window.
import { waveformChart } from '../lib/charts.js'
import { bytes, duration, esc, num } from '../lib/format.js'

const WINDOWS = [
  [10, '10 seconds'],
  [30, '30 seconds'],
  [120, '2 minutes'],
  [600, '10 minutes'],
  [0, 'Whole recording'],
]

/** Returns a destroy() function. */
export function renderWaveform(el, { archive, packedBytes, unfoldedBytes, sampleRateHz, verified = false }) {
  const n = archive.red.length
  const rate = Number(archive.meta.sampleRateHz || sampleRateHz || 100)
  const total = n / rate
  const x = new Float64Array(n)
  for (let i = 0; i < n; i += 1) x[i] = i / rate
  const ratio = packedBytes ? unfoldedBytes / packedBytes : null

  el.innerHTML = `
    <div class="wave-facts">
      <p class="fold-ratio"><strong>Folded ${bytes(packedBytes)} → unfolded ${bytes(unfoldedBytes)}</strong>${ratio ? ` <span class="ratio">×${ratio.toFixed(1)}</span>` : ''}</p>
      <p class="muted">${num(n)} samples per channel at ${esc(rate)} Hz · ${duration(total)} · ${num(archive.frames.length)} frames · ${verified ? 'SHA-256 verified · ' : ''}lossless</p>
    </div>
    <div class="wave-controls">
      <label>Window
        <select class="js-win">${WINDOWS.map(([s, l]) => `<option value="${s}" ${s === 30 ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <div class="pan">
        <button class="btn btn-quiet js-prev" aria-label="Earlier">◀</button>
        <label class="grow"><span class="sr-only">Position in recording</span>
          <input class="js-pos" type="range" min="0" max="1000" value="0" step="1" />
        </label>
        <button class="btn btn-quiet js-next" aria-label="Later">▶</button>
      </div>
      <span class="js-where muted" aria-live="polite"></span>
    </div>
    <figure class="chart-fig is-red"><figcaption><span class="swatch" aria-hidden="true"></span>Red channel <span class="muted">(raw ADC counts)</span></figcaption><div class="chart js-red" role="img" aria-label="Red PPG waveform"></div></figure>
    <figure class="chart-fig is-ir"><figcaption><span class="swatch" aria-hidden="true"></span>Infrared channel <span class="muted">(raw ADC counts)</span></figcaption><div class="chart js-ir" role="img" aria-label="Infrared PPG waveform"></div></figure>
    <p class="fine">Drag across a chart to zoom in; the other channel follows. Use the slider or arrows to move through the recording.</p>`

  const $ = (s) => el.querySelector(s)
  const win = $('.js-win')
  const pos = $('.js-pos')
  const where = $('.js-where')
  let syncing = false
  let view = [0, Math.min(30, total)]

  const onZoom = (min, max) => {
    if (syncing || min == null) return
    view = [min, max]
    apply()
  }
  const red = waveformChart($('.js-red'), { label: 'Red', color: '--red-ch', x, y: archive.red, onZoom })
  const ir = waveformChart($('.js-ir'), { label: 'IR', color: '--ir-ch', x, y: archive.ir, onZoom })

  // Puts both charts on the current window (guarded: setScale re-enters onZoom).
  function apply() {
    const [a, b] = view
    syncing = true
    red.setWindow(a, b)
    ir.setWindow(a, b)
    syncing = false
    const span = b - a
    pos.value = total > span ? Math.round((a / (total - span)) * 1000) : 0
    pos.disabled = span >= total
    where.textContent = `${a.toFixed(1)}–${b.toFixed(1)} s of ${total.toFixed(0)} s`
  }

  function setSpan(seconds) {
    const span = seconds > 0 ? Math.min(seconds, total) : total
    const start = Math.min(Math.max(0, view[0]), Math.max(0, total - span))
    view = [start, start + span]
    apply()
  }

  function move(fraction) {
    const span = view[1] - view[0]
    const start = Math.min(Math.max(0, view[0] + span * fraction), Math.max(0, total - span))
    view = [start, start + span]
    apply()
  }

  win.addEventListener('change', () => setSpan(Number(win.value)))
  pos.addEventListener('input', () => {
    const span = view[1] - view[0]
    const start = (Number(pos.value) / 1000) * Math.max(0, total - span)
    view = [start, start + span]
    apply()
  })
  $('.js-prev').addEventListener('click', () => move(-0.8))
  $('.js-next').addEventListener('click', () => move(0.8))
  setSpan(30)

  return () => {
    red.destroy()
    ir.destroy()
  }
}

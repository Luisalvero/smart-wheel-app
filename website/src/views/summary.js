// The end-of-drive summary block, shared by the live view (when a drive
// finishes) and the session detail page. Input: a session_summaries row.
import { duration, num, smartNum } from '../lib/format.js'
import { infoTip } from '../lib/ui.js'

const WHY_PERCENTILES =
  'A steering-wheel sensor picks up hand movement and changes in grip. A single bad second could otherwise set the lowest or highest value of the whole drive, so we show the 5th and 95th percentiles as the realistic range. The absolute minimum and maximum are listed for completeness.'

/** A value with its unit, or a bare dash when there is no value. */
const withUnit = (text, unit) => (text === '—' ? '—' : `${text}<small>${unit}</small>`)
const whole = (v) => smartNum(v != null ? Math.round(v) : null)

function group({ title, unit, low, mid, high, avg, min, max, cls }) {
  return `
    <section class="stat-group ${cls}" aria-label="${title}">
      <h4><span class="swatch" aria-hidden="true"></span>${title} ${infoTip(WHY_PERCENTILES)}</h4>
      <dl class="stats">
        <div><dt>Realistic low</dt><dd>${withUnit(whole(low), unit)}</dd></div>
        <div class="stat-mid"><dt>Median</dt><dd>${withUnit(whole(mid), unit)}</dd></div>
        <div><dt>Realistic high</dt><dd>${withUnit(whole(high), unit)}</dd></div>
        <div><dt>Average</dt><dd>${withUnit(num(avg, 1), unit)}</dd></div>
      </dl>
      <p class="fine">Absolute min ${smartNum(min)} · max ${smartNum(max)} ${unit}${low == null && avg != null ? ' · realistic range needs the v3 database update' : ''}</p>
    </section>`
}

export function summaryHtml(s, { durationSeconds } = {}) {
  if (!s) return '<p class="muted">No summary is available for this drive yet.</p>'
  const secs =
    s.duration_seconds ??
    durationSeconds ??
    (s.ended_at ? (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000 : null)
  const usable = s.usable_pct ?? null
  return `
    <div class="summary">
      <dl class="summary-meta">
        <div><dt>Duration</dt><dd>${duration(secs)}</dd></div>
        <div><dt>Usable readings</dt><dd>${usable != null ? `${num(usable, 0)}%` : '—'}</dd></div>
        <div><dt>Readings</dt><dd>${num(s.samples)}${s.frames != null ? ` <small>of ${num(s.frames)}</small>` : ''}</dd></div>
      </dl>
      <div class="stat-groups">
        ${group({ title: 'Heart rate', unit: 'bpm', cls: 'is-bpm', low: s.bpm_p05, mid: s.bpm_median, high: s.bpm_p95, avg: s.bpm_avg, min: s.bpm_min, max: s.bpm_max })}
        ${group({ title: 'Blood oxygen (SpO₂)', unit: '%', cls: 'is-spo2', low: s.spo2_p05, mid: s.spo2_median, high: s.spo2_p95, avg: s.spo2_avg, min: s.spo2_min, max: s.spo2_max })}
      </div>
    </div>`
}

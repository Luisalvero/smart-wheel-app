// Drivers (#/drivers): each driver with their baseline — the usual heart-rate
// range learned from their finished drives (driver_baselines view).
import { fetchBaselines, fetchProfiles, fetchSessionCounts, fetchThresholdHistory } from '../lib/data.js'
import { schema } from '../lib/schema.js'
import { esc, num } from '../lib/format.js'
import { errorBox, infoTip, loading } from '../lib/ui.js'

const BASELINE_TIP =
  'The usual range is the 10th–90th percentile of every usable heart-rate reading from this driver’s finished drives. It becomes “established” after 60 readings (about one minute). It is a personal reference, not a medical one.'

function baselineHtml(b, v3) {
  if (!v3) return '<p class="muted">Baselines appear once the v3 database update is run (see the notice above).</p>'
  if (!b) return `<p class="baseline-state learning"><span class="badge badge-learning">Learning</span> No finished drives with usable readings yet.</p>`
  if (!b.established) {
    const pct = Math.min(100, (Number(b.readings) / 60) * 100)
    return `
      <p class="baseline-state learning"><span class="badge badge-learning">Learning</span> ${num(b.readings)} of 60 readings</p>
      <div class="meter" role="progressbar" aria-label="Baseline progress" aria-valuemin="0" aria-valuemax="60" aria-valuenow="${num(b.readings)}"><span style="width:${pct}%"></span></div>`
  }
  return `
    <p class="baseline-state"><span class="badge badge-completed">Established</span></p>
    <dl class="mini-stats">
      <div><dt>Usual heart rate</dt><dd>${num(b.bpm_p10)}–${num(b.bpm_p90)}<small> bpm</small></dd></div>
      <div><dt>Typical</dt><dd>${num(b.bpm_median)}<small> bpm</small></dd></div>
      <div><dt>SpO₂ typical</dt><dd>${num(b.spo2_median)}<small> %</small></dd></div>
    </dl>
    <p class="fine">${num(b.readings)} readings from ${num(b.sessions)} finished drive${b.sessions == 1 ? '' : 's'}</p>`
}

const REASON = { drive: 'after a drive', ok_answer: 'after an “I’m OK”', profile: 'profile loaded', reset: 'reset' }

/**
 * How the phone's warning lines for this driver moved over time: high and
 * low warning lines and the expected heart rate, one point per snapshot.
 * Inline SVG (small multiples, no library needed).
 */
function historyHtml(rows) {
  if (!rows?.length) return ''
  const W = 320, H = 110, P = 26
  const vals = rows.flatMap((r) => [r.high_warn, r.low_warn, Number(r.mean)])
  const lo = Math.min(...vals) - 5, hi = Math.max(...vals) + 5
  const x = (i) => P + (rows.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (rows.length - 1))
  const y = (v) => H - 14 - ((v - lo) / (hi - lo)) * (H - 28)
  const line = (key, cls) =>
    `<polyline class="${cls}" fill="none" points="${rows.map((r, i) => `${x(i).toFixed(1)},${y(Number(r[key])).toFixed(1)}`).join(' ')}" />`
  const first = rows[0], last = rows[rows.length - 1]
  const tick = (v) => `<text x="2" y="${(y(v) + 4).toFixed(1)}" class="hist-tick">${Math.round(v)}</text>`
  return `
    <div class="history">
      <h3>How the phone adapted</h3>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Warning lines over time: high from ${first.high_warn} to ${last.high_warn} bpm">
        ${tick(last.high_warn)}${tick(last.low_warn)}
        ${line('high_warn', 'hist-high')}${line('mean', 'hist-mean')}${line('low_warn', 'hist-low')}
      </svg>
      <p class="fine">
        <span class="key key-high"></span>warn above <b>${first.high_warn} → ${last.high_warn}</b> ·
        <span class="key key-low"></span>below <b>${first.low_warn} → ${last.low_warn}</b> ·
        <span class="key key-mean"></span>expected <b>${Math.round(first.mean)} → ${Math.round(last.mean)}</b> bpm.
        Now ${Math.round(Number(last.learned) * 100)}% learned from ${last.drives} drive${last.drives == 1 ? '' : 's'}
        (last change ${esc(REASON[last.reason] ?? last.reason)}).
      </p>
    </div>`
}

export function mount(el) {
  let alive = true
  el.innerHTML = `
    <div class="page-head"><div><h1>Drivers</h1><p class="lede">Each driver’s usual range, learned from their own drives ${infoTip(BASELINE_TIP)}</p></div></div>
    <div class="js-body">${loading('Loading drivers…')}</div>`
  const body = el.querySelector('.js-body')

  ;(async () => {
    try {
      const [profiles, counts, baselines, history] = await Promise.all([
        fetchProfiles(),
        fetchSessionCounts(),
        schema.v3 === false ? null : fetchBaselines().catch((err) => (err.missing ? null : Promise.reject(err))),
        fetchThresholdHistory(),
      ])
      if (!alive) return
      const v3 = !!baselines
      if (!profiles.length) {
        body.innerHTML = '<div class="empty"><h2>No drivers yet</h2><p>Driver profiles are created in the phone app.</p></div>'
        return
      }
      body.innerHTML = `
        <div class="card-grid">
          ${profiles
            .map((p) => {
              const n = counts.get(p.id) || 0
              return `
                <article class="card driver-card">
                  <div class="card-head"><div class="who"><h2 class="driver-name">${esc(p.display_name)}</h2>${p.custom_id ? `<span class="custom-id">${esc(p.custom_id)}</span>` : ''}</div>
                  <span class="muted">${n} drive${n === 1 ? '' : 's'}</span></div>
                  ${baselineHtml(baselines?.get(p.id), v3)}
                  ${historyHtml(history.get(p.id))}
                  ${n ? `<a class="card-link" href="#/sessions?driver=${esc(p.id)}">View drives →</a>` : ''}
                </article>`
            })
            .join('')}
        </div>`
    } catch (err) {
      body.innerHTML = errorBox(`Could not load drivers: ${err.message}`)
    }
  })()

  return () => {
    alive = false
  }
}

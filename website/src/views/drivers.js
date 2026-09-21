// Drivers (#/drivers): each driver with their baseline — the usual heart-rate
// range learned from their finished drives (driver_baselines view).
import { fetchBaselines, fetchProfiles, fetchSessionCounts } from '../lib/data.js'
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

export function mount(el) {
  let alive = true
  el.innerHTML = `
    <div class="page-head"><div><h1>Drivers</h1><p class="lede">Each driver’s usual range, learned from their own drives ${infoTip(BASELINE_TIP)}</p></div></div>
    <div class="js-body">${loading('Loading drivers…')}</div>`
  const body = el.querySelector('.js-body')

  ;(async () => {
    try {
      const [profiles, counts, baselines] = await Promise.all([
        fetchProfiles(),
        fetchSessionCounts(),
        schema.v3 === false ? null : fetchBaselines().catch((err) => (err.missing ? null : Promise.reject(err))),
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

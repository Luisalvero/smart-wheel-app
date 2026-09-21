// History (#/sessions): recent drives, newest first, with a driver filter
// and "load more". Reads the session_summaries view one page at a time.
import { fetchProfiles, fetchSummaries } from '../lib/data.js'
import { on } from '../lib/realtime.js'
import { dateTime, duration, esc, num, smartNum } from '../lib/format.js'
import { errorBox, loading } from '../lib/ui.js'

const PAGE_SIZE = 20

const r0 = (v) => (v == null ? null : Math.round(v))

function statusBadge(status) {
  if (!status) return ''
  const label = { active: 'Live', completed: 'Completed', interrupted: 'Interrupted' }[status] ?? status
  return `<span class="badge badge-${esc(status)}">${esc(label)}</span>`
}

function rowHtml(s) {
  const low = r0(s.bpm_p05)
  const high = r0(s.bpm_p95)
  const range = low != null && high != null ? `${low}–${high}` : s.bpm_min != null ? `${s.bpm_min}–${s.bpm_max}` : null
  const spo2 = r0(s.spo2_median ?? s.spo2_avg)
  return `
    <tr>
      <td data-label="Started"><span class="cell"><a class="row-link" href="#/sessions/${esc(s.session_id)}">${esc(dateTime(s.started_at))}</a> ${statusBadge(s.status)}</span></td>
      <td data-label="Driver"><span class="cell">${esc(s.display_name ?? '—')}${s.custom_id ? ` <span class="custom-id">${esc(s.custom_id)}</span>` : ''}</span></td>
      <td data-label="Duration"><span class="cell">${duration(s.duration_seconds)}</span></td>
      <td data-label="Heart rate" class="num"><span class="cell">${range ? `${range}<small> bpm</small>` : '—'}${s.bpm_median != null ? `<span class="sub">median ${smartNum(r0(s.bpm_median))}</span>` : ''}</span></td>
      <td data-label="SpO₂" class="num"><span class="cell">${spo2 != null ? `${spo2}<small> %</small>` : '—'}</span></td>
      <td data-label="Usable" class="num"><span class="cell">${s.usable_pct != null ? `${num(s.usable_pct)}%` : '—'}</span></td>
    </tr>`
}

export function mount(el, { query }) {
  let profileId = query.get('driver') || ''
  let rows = []
  let done = false
  let busy = false
  let alive = true

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Drives</h1><p class="lede">Every recorded drive, newest first. Open one for its full chart and waveform.</p></div>
      <label class="filter">Driver
        <select class="js-driver"><option value="">All drivers</option></select>
      </label>
    </div>
    <div class="panel">
      <table class="table sessions-table">
        <caption class="sr-only">Recorded drives</caption>
        <thead><tr><th scope="col">Started</th><th scope="col">Driver</th><th scope="col">Duration</th><th scope="col" class="num">Heart rate <span class="muted">(realistic range)</span></th><th scope="col" class="num">SpO₂</th><th scope="col" class="num">Usable</th></tr></thead>
        <tbody class="js-rows"></tbody>
      </table>
      <div class="js-status"></div>
      <div class="more"><button class="btn js-more" hidden>Load more drives</button></div>
    </div>`
  const tbody = el.querySelector('.js-rows')
  const status = el.querySelector('.js-status')
  const more = el.querySelector('.js-more')
  const select = el.querySelector('.js-driver')

  fetchProfiles()
    .then((profiles) => {
      if (!alive) return
      select.insertAdjacentHTML(
        'beforeend',
        profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.display_name)}${p.custom_id ? ` (${esc(p.custom_id)})` : ''}</option>`).join('')
      )
      select.value = profileId
    })
    .catch(() => {})

  async function load({ reset = false } = {}) {
    if (busy) return
    busy = true
    more.disabled = true
    if (reset) {
      rows = []
      done = false
      tbody.innerHTML = ''
    }
    status.innerHTML = rows.length ? '' : loading('Loading drives…')
    try {
      // After a reset we reload as many rows as were showing (min one page).
      const page = await fetchSummaries({ profileId: profileId || null, offset: rows.length, limit: PAGE_SIZE })
      if (!alive) return
      rows.push(...page)
      done = page.length < PAGE_SIZE
      tbody.insertAdjacentHTML('beforeend', page.map(rowHtml).join(''))
      status.innerHTML = rows.length ? '' : '<div class="empty small"><h2>No drives yet</h2><p>Drives recorded with the phone app will be listed here.</p></div>'
    } catch (err) {
      status.innerHTML = errorBox(`Could not load drives: ${err.message}`)
    } finally {
      busy = false
      more.disabled = false
      more.hidden = done
    }
  }

  select.addEventListener('change', () => {
    profileId = select.value
    history.replaceState(null, '', profileId ? `#/sessions?driver=${profileId}` : '#/sessions')
    load({ reset: true })
  })
  more.addEventListener('click', () => load())

  // A drive starting or finishing changes the top of the list; refresh just
  // the first page (debounced) when the user hasn't paged further.
  let t = 0
  const off = on('session', () => {
    clearTimeout(t)
    t = setTimeout(() => rows.length <= PAGE_SIZE && load({ reset: true }), 2000)
  })

  load()
  return () => {
    alive = false
    off()
    clearTimeout(t)
  }
}

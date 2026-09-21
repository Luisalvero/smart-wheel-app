// In-memory picture of the drives happening right now.
//
// Loaded once from the database (active_sessions + the last 10 minutes of
// telemetry), then kept current from Realtime deltas only: a telemetry INSERT
// appends one point, a drive_sessions UPDATE changes state. Nothing is ever
// refetched wholesale. Views subscribe() and redraw on requestAnimationFrame.
import {
  fetchActiveSessions,
  fetchAlerts,
  fetchBaseline,
  fetchRecentTelemetry,
  fetchSessionRow,
  fetchSummary,
  fetchSummaries,
  getProfile,
} from './data.js'
import { on } from './realtime.js'
import { median } from './format.js'

export const WINDOW_MS = 10 * 60 * 1000 // live charts show the last 10 minutes
const MAX_POINTS = 3000 // hard cap per session, whatever the rate
const QUIET_MS = 15 * 1000 // "phone quiet" after 15 s without news
const DROP_MS = 2 * 60 * 1000 // gone from "active" after 2 minutes, like the view
const KEEP_FINISHED = 6

const entries = new Map()
const listeners = new Set()
const checkedUnknown = new Set()
let ready = null

export const liveStore = { error: null, loaded: false }

function notify(id) {
  listeners.forEach((fn) => fn(id))
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getEntries() {
  return [...entries.values()]
}

export function getEntry(id) {
  return entries.get(id) ?? null
}

// ------------------------------------------------------------ entry model --
function makeEntry(row) {
  return {
    id: row.session_id ?? row.id,
    profileId: row.profile_id,
    name: row.display_name ?? null,
    customId: row.custom_id ?? null,
    startedAt: Date.parse(row.started_at),
    lastSeenAt: row.last_seen_at ? Date.parse(row.last_seen_at) : null,
    linkState: row.link_state ?? null,
    status: 'active',
    endedAt: null,
    durationSeconds: null,
    // Parallel arrays, oldest first; t in ms. bpm/spo2 are null when unusable.
    t: [],
    bpm: [],
    spo2: [],
    lastFinger: null,
    lastUsable: null,
    lastTelemetryAt: null,
    baseline: null,
    summary: null,
    alerts: new Map(), // drive_alerts rows by id
    version: 0, // bumped on every change so views can skip unchanged work
  }
}

function pushPoint(e, row) {
  const t = Date.parse(row.received_at)
  // Rows can arrive slightly out of order after a phone reconnects; keep the
  // arrays sorted so the chart line never doubles back.
  let i = e.t.length
  while (i > 0 && e.t[i - 1] > t) i -= 1
  e.t.splice(i, 0, t)
  e.bpm.splice(i, 0, row.bpm ?? null)
  e.spo2.splice(i, 0, row.spo2 ?? null)

  if (i === e.t.length - 1) {
    e.lastFinger = row.finger ?? null
    e.lastUsable = row.bpm != null
  }
  e.lastTelemetryAt = Math.max(e.lastTelemetryAt ?? 0, Date.now())

  // Trim to the time window and the point cap.
  const cutoff = e.t[e.t.length - 1] - WINDOW_MS
  let drop = 0
  while (drop < e.t.length && e.t[drop] < cutoff) drop += 1
  drop = Math.max(drop, e.t.length - MAX_POINTS)
  if (drop > 0) {
    e.t.splice(0, drop)
    e.bpm.splice(0, drop)
    e.spo2.splice(0, drop)
  }
  e.version += 1
}

async function hydrate(e) {
  const [profile, baseline, rows, alerts] = await Promise.all([
    e.name ? null : getProfile(e.profileId),
    fetchBaseline(e.profileId).catch(() => null),
    fetchRecentTelemetry(e.id, Date.now() - WINDOW_MS).catch(() => []),
    fetchAlerts(e.id, 20).catch(() => null),
  ])
  for (const a of alerts ?? []) if (!e.alerts.has(a.id)) e.alerts.set(a.id, a)
  if (profile) {
    e.name = profile.display_name
    e.customId = profile.custom_id
  }
  e.baseline = baseline
  // Realtime may already have appended newer points while we were loading.
  const seen = new Set(e.t)
  for (const r of rows) if (!seen.has(Date.parse(r.received_at))) pushPoint(e, r)
  if (rows.length) e.lastTelemetryAt = Math.max(e.lastTelemetryAt ?? 0, Date.parse(rows.at(-1).received_at))
  e.version += 1
  notify(e.id)
}

async function addActive(row) {
  const e = makeEntry(row)
  if (entries.has(e.id)) return entries.get(e.id)
  entries.set(e.id, e)
  notify(e.id)
  await hydrate(e)
  return e
}

async function finish(e, row) {
  e.status = row.status
  e.endedAt = row.ended_at ? Date.parse(row.ended_at) : Date.now()
  e.durationSeconds = row.duration_seconds ?? Math.round((e.endedAt - e.startedAt) / 1000)
  e.version += 1
  notify(e.id)
  try {
    e.summary = await fetchSummary(e.id)
  } catch {
    e.summary = null
  }
  e.version += 1
  pruneFinished()
  notify(e.id)
}

function pruneFinished() {
  const done = getEntries()
    .filter((x) => x.status !== 'active')
    .sort((a, b) => b.endedAt - a.endedAt)
  for (const x of done.slice(KEEP_FINISHED)) entries.delete(x.id)
}

// -------------------------------------------------------- realtime deltas --
function onSession({ eventType, new: row, old }) {
  if (eventType === 'DELETE') {
    if (entries.delete(old?.id)) notify(old.id)
    return
  }
  const e = entries.get(row.id)
  if (row.status === 'active') {
    if (!e) {
      addActive({ ...row, session_id: row.id })
      return
    }
    if (row.last_seen_at) e.lastSeenAt = Date.parse(row.last_seen_at)
    if ('link_state' in row) e.linkState = row.link_state
    e.version += 1
    notify(e.id)
  } else if (e && e.status === 'active') {
    finish(e, row)
  }
}

function onTelemetry(row) {
  const e = entries.get(row.session_id)
  if (e) {
    pushPoint(e, row)
    notify(e.id)
    return
  }
  // Telemetry for a session we don't know: it may have started before this
  // page subscribed. Look it up once.
  if (checkedUnknown.has(row.session_id)) return
  checkedUnknown.add(row.session_id)
  fetchSessionRow(row.session_id)
    .then((s) => {
      if (s?.status === 'active') addActive({ ...s, session_id: s.id })
    })
    .catch(() => {})
}

function onAlert(row) {
  const e = entries.get(row.session_id)
  if (!e) return
  if (row._deleted) e.alerts.delete(row.id)
  else e.alerts.set(row.id, row)
  e.version += 1
  notify(e.id)
}

/** Drops sessions whose phone went silent for 2 minutes (like the view). */
function sweep() {
  const now = Date.now()
  for (const e of entries.values()) {
    if (e.status === 'active' && now - lastActivity(e) > DROP_MS) {
      entries.delete(e.id)
      checkedUnknown.delete(e.id)
      notify(e.id)
    }
  }
}

/** Drives that ended in the last 15 minutes, so a page reload right after a
 *  drive still shows it under "Just finished". */
async function seedRecentlyFinished() {
  const recent = await fetchSummaries({ limit: KEEP_FINISHED }).catch(() => [])
  for (const s of recent) {
    const endedAt = s.ended_at ? Date.parse(s.ended_at) : null
    if (!endedAt || entries.has(s.session_id) || Date.now() - endedAt > 15 * 60 * 1000) continue
    if (s.status === 'active') continue
    const e = makeEntry(s)
    e.status = s.status ?? 'completed'
    e.endedAt = endedAt
    e.durationSeconds = s.duration_seconds
    e.summary = s
    entries.set(e.id, e)
  }
}

/** Loads the current state once and starts following Realtime. */
export function initLiveStore() {
  ready ??= (async () => {
    on('session', onSession)
    on('telemetry', onTelemetry)
    on('alert', onAlert)
    setInterval(sweep, 5000)
    try {
      const rows = await fetchActiveSessions()
      await Promise.all(rows.map(addActive))
      await seedRecentlyFinished()
      liveStore.error = null
    } catch (err) {
      liveStore.error = err.message
    }
    liveStore.loaded = true
    notify(null)
  })()
  return ready
}

// ------------------------------------------------------ derived readings --
export function lastActivity(e) {
  return Math.max(e.lastSeenAt ?? 0, e.lastTelemetryAt ?? 0, e.startedAt ?? 0)
}

/** Newest non-null value of a series, with its time. */
export function latest(e, key) {
  const arr = e[key]
  for (let i = arr.length - 1; i >= 0; i -= 1) if (arr[i] != null) return { value: arr[i], t: e.t[i] }
  return null
}

/**
 * The single state shown on the pill. Order matters: silence from the phone
 * trumps everything, then the relay's link report, then the finger flag.
 */
export function liveState(e, now = Date.now()) {
  if (e.status !== 'active') return { key: 'ended', label: 'Drive finished' }
  const silent = now - lastActivity(e)
  if (silent > QUIET_MS)
    return {
      key: 'quiet',
      label: 'Phone quiet',
      detail: `No word from the phone for ${Math.round(silent / 1000)} s`,
    }
  if (e.linkState === 'sensor_lost')
    return { key: 'lost', label: 'Sensor link lost', detail: 'The wheel sensor stopped reaching the relay' }
  if (e.linkState === 'pi_lost')
    return { key: 'lost', label: 'Sensor link lost', detail: 'The phone lost its Bluetooth link to the relay' }
  if (!e.t.length) return { key: 'waiting', label: 'Waiting for readings' }
  if (e.lastFinger === false || (e.lastFinger == null && e.lastUsable === false))
    return { key: 'nofinger', label: 'No finger on wheel', detail: 'Place a finger on the sensor pad' }
  if (e.lastUsable === false) return { key: 'settling', label: 'Steadying signal' }
  return { key: 'streaming', label: 'Streaming' }
}

export const ALERT_KIND = {
  bpm_high: 'Heart rate above usual range',
  bpm_low: 'Heart rate below usual range',
  spo2_low: 'Blood oxygen low',
  no_contact: 'No hand on the sensor',
  irregular_rhythm: 'Irregular pulse pattern (advisory)',
}

/**
 * The alert banner to show, if any: an escalated alert from the last
 * 10 minutes wins over an open one (driver not yet answered).
 * Escalation is SIMULATED in this prototype — nobody is contacted.
 */
export function alertState(e, now = Date.now()) {
  let open = null
  let escalated = null
  for (const a of e.alerts.values()) {
    const at = Date.parse(a.responded_at ?? a.prompted_at ?? a.started_at)
    if (a.escalated && now - at < 10 * 60 * 1000 && (!escalated || at > escalated.at)) escalated = { a, at }
    // Notices (and advisories) are only logged by the phone; the banner is for
    // real warnings being confirmed and emergencies waiting for an answer.
    if (a.response == null && !a.escalated && a.level !== 'notice' && (!open || at > open.at)) open = { a, at }
  }
  if (escalated) {
    const a = escalated.a
    return {
      level: 'escalated',
      title:
        a.response === 'no_response'
          ? 'No answer from driver — escalation (simulated)'
          : a.response === 'not_ok' || a.response === 'unwell'
            ? 'Driver said they are not OK — escalation (simulated)'
            : 'Alert escalated (simulated)',
      detail: `${ALERT_KIND[a.kind] ?? a.kind}${a.value != null ? ` (${Math.round(a.value)}${a.kind === 'spo2_low' ? '%' : ' bpm'})` : ''}. Simulated: nobody is actually contacted in this prototype.`,
    }
  }
  if (open) {
    const a = open.a
    return {
      level: 'open',
      title: a.prompted_at
        ? 'Emergency check — the phone is asking the driver if they are OK'
        : `Unusual reading — confirming over the next ${a.level === 'critical' ? 8 : 15} s`,
      detail: `${ALERT_KIND[a.kind] ?? a.kind}${a.value != null ? ` (${Math.round(a.value)}${a.kind === 'spo2_low' ? '%' : ' bpm'})` : ''}.`,
    }
  }
  return null
}

/**
 * Median BPM over the last 10 s compared with the driver's usual range
 * widened by 15 bpm each side. Only meaningful once the baseline is
 * established; returns null otherwise.
 */
export function rangeCheck(e) {
  const b = e.baseline
  if (!b?.established || b.bpm_p10 == null || !e.t.length) return null
  const since = e.t[e.t.length - 1] - 10_000
  const recent = []
  for (let i = e.t.length - 1; i >= 0 && e.t[i] >= since; i -= 1) if (e.bpm[i] != null) recent.push(e.bpm[i])
  const m = median(recent)
  if (m == null) return null
  const low = Number(b.bpm_p10) - 15
  const high = Number(b.bpm_p90) + 15
  return { median: m, low, high, outside: m < low || m > high, direction: m < low ? 'below' : 'above' }
}

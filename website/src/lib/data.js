// Every Supabase read the dashboard makes. Views call these and never build
// queries themselves, so the database contract lives in one file.
//
// Contract: mobile-app/supabase/schema.sql + v3_dashboard.sql.
import { supabase } from '../supabase.js'
import { isMissing, markV3Missing, schema } from './schema.js'
import { touch } from './realtime.js'

export const PAGE = 1000 // PostgREST's default max rows per request
const ACTIVE_WINDOW_MS = 2 * 60 * 1000 // same 2 minutes as the active_sessions view

function telemetryColumns() {
  const base = 'id, session_id, sequence_number, bpm, spo2, received_at'
  return schema.v3 === false ? base : `${base}, finger, quality`
}

/** Throws a readable error; flags the v3 panel when an object is missing. */
function check({ data, error }) {
  if (error) {
    if (isMissing(error)) markV3Missing()
    throw Object.assign(new Error(error.message), { code: error.code, missing: isMissing(error) })
  }
  touch()
  return data
}

// ---------------------------------------------------------------- profiles --
const profileCache = new Map()

export async function getProfile(id) {
  if (!profileCache.has(id)) {
    profileCache.set(
      id,
      supabase
        .from('driver_profiles')
        .select('id, custom_id, display_name')
        .eq('id', id)
        .maybeSingle()
        .then(check)
        .catch(() => null)
    )
  }
  return profileCache.get(id)
}

export async function fetchProfiles() {
  return check(
    await supabase
      .from('driver_profiles')
      .select('id, custom_id, display_name, age, gender, created_at')
      .order('display_name')
  )
}

// ---------------------------------------------------------------- sessions --
/**
 * Sessions driving right now, normalised to the active_sessions view shape.
 * Without v3 the view is missing, so fall back to status = 'active' and use
 * the newest telemetry row as the "phone checked in" time.
 */
export async function fetchActiveSessions() {
  if (schema.v3 !== false) {
    const res = await supabase.from('active_sessions').select('*')
    if (!res.error) return check(res)
    if (!isMissing(res.error)) check(res)
    markV3Missing()
  }

  const rows = check(
    await supabase
      .from('drive_sessions')
      .select('id, profile_id, started_at, status, driver_profiles(display_name, custom_id)')
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(20)
  )
  const out = []
  for (const s of rows) {
    const last = await latestTelemetryAt(s.id)
    const lastMs = last ? Date.parse(last) : Date.parse(s.started_at)
    // A phone that died mid-drive leaves its session 'active' forever; hide
    // it after 2 minutes of silence, like the v3 view does.
    if (Date.now() - lastMs > ACTIVE_WINDOW_MS) continue
    out.push({
      session_id: s.id,
      profile_id: s.profile_id,
      display_name: s.driver_profiles?.display_name,
      custom_id: s.driver_profiles?.custom_id,
      started_at: s.started_at,
      last_seen_at: last,
      link_state: null,
      storage_mode: null,
      sample_rate_hz: null,
    })
  }
  return out
}

async function latestTelemetryAt(sessionId) {
  const rows = check(
    await supabase
      .from('telemetry_events')
      .select('received_at')
      .eq('session_id', sessionId)
      .order('received_at', { ascending: false })
      .limit(1)
  )
  return rows[0]?.received_at ?? null
}

export async function fetchSessionRow(id) {
  const cols = schema.v3 === false
    ? 'id, profile_id, started_at, ended_at, duration_seconds, status'
    : 'id, profile_id, started_at, ended_at, duration_seconds, status, last_seen_at, link_state, storage_mode, sample_rate_hz'
  return check(await supabase.from('drive_sessions').select(cols).eq('id', id).maybeSingle())
}

// --------------------------------------------------------------- summaries --
export async function fetchSummary(sessionId) {
  return check(
    await supabase.from('session_summaries').select('*').eq('session_id', sessionId).maybeSingle()
  )
}

/** Newest first, one page at a time; optional driver filter. */
export async function fetchSummaries({ profileId = null, offset = 0, limit = 20 } = {}) {
  let q = supabase
    .from('session_summaries')
    .select('*')
    .order('started_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (profileId) q = q.eq('profile_id', profileId)
  return check(await q)
}

/** Number of sessions per driver (all statuses). */
export async function fetchSessionCounts() {
  const rows = check(await supabase.from('drive_sessions').select('profile_id').limit(10000))
  const counts = new Map()
  for (const r of rows) counts.set(r.profile_id, (counts.get(r.profile_id) || 0) + 1)
  return counts
}

// --------------------------------------------------------------- telemetry --
/** The last few minutes of one session, oldest first (live chart seed). */
export async function fetchRecentTelemetry(sessionId, sinceMs) {
  const rows = check(
    await supabase
      .from('telemetry_events')
      .select(telemetryColumns())
      .eq('session_id', sessionId)
      .gte('received_at', new Date(sinceMs).toISOString())
      .order('received_at', { ascending: false })
      .limit(PAGE)
  )
  return rows.reverse()
}

/**
 * Every row of a session, in pages of 1000 (a long drive is thousands of
 * rows and PostgREST caps each response). onProgress(rowsSoFar) per page.
 */
export async function fetchAllTelemetry(sessionId, onProgress) {
  const all = []
  for (let from = 0; ; from += PAGE) {
    const rows = check(
      await supabase
        .from('telemetry_events')
        .select(telemetryColumns())
        .eq('session_id', sessionId)
        .order('received_at', { ascending: true })
        .order('id', { ascending: true }) // stable order across pages
        .range(from, from + PAGE - 1)
    )
    all.push(...rows)
    onProgress?.(all.length)
    if (rows.length < PAGE) return all
  }
}

// --------------------------------------------------------------- baselines --
/** A driver's usual range, or null (not enough data, or v3 not applied). */
export async function fetchBaseline(profileId) {
  if (schema.v3 === false) return null
  try {
    return check(
      await supabase.from('driver_baselines').select('*').eq('profile_id', profileId).maybeSingle()
    )
  } catch (err) {
    if (err.missing) return null
    throw err
  }
}

export async function fetchBaselines() {
  const rows = check(await supabase.from('driver_baselines').select('*'))
  return new Map(rows.map((r) => [r.profile_id, r]))
}

// ---------------------------------------------------------------- archives --
export async function fetchArchiveRow(sessionId) {
  return check(
    await supabase.from('session_archives').select('*').eq('session_id', sessionId).maybeSingle()
  )
}

// ------------------------------------------------------------------ alerts --
/**
 * A session's alerts (drive_alerts, v3), newest first. Returns null when the
 * table does not exist yet so callers can say so instead of failing.
 */
export async function fetchAlerts(sessionId, limit = 200) {
  if (schema.v3 === false) return null
  try {
    return check(
      await supabase
        .from('drive_alerts')
        .select('*')
        .eq('session_id', sessionId)
        .order('started_at', { ascending: false })
        .limit(limit)
    )
  } catch (err) {
    if (err.missing) return null
    throw err
  }
}

// ----------------------------------------------------------- test readings --
export async function fetchTestReadings(limit) {
  return check(
    await supabase
      .from('test_readings')
      .select('id, created_at, value, device_name')
      .order('created_at', { ascending: false })
      .limit(limit)
  )
}

// Detects whether the Supabase project has the v3 dashboard update
// (mobile-app/supabase/v3_dashboard.sql). Until it is run, the heartbeat
// columns, the active_sessions / driver_baselines views and session_archives
// do not exist, and the site degrades instead of breaking.
import { supabase } from '../supabase.js'

// PostgREST / Postgres codes for "that table, view or column is not there".
const MISSING_CODES = new Set(['PGRST205', 'PGRST204', 'PGRST200', '42703', '42P01'])

export function isMissing(error) {
  if (!error) return false
  return (
    MISSING_CODES.has(error.code) ||
    /does not exist|schema cache|could not find/i.test(error.message || '')
  )
}

let probe = null
const listeners = new Set()
export const schema = { v3: null, checked: false }

/** Resolves to { v3: true|false }. One cheap query, cached for the page. */
export function checkSchema() {
  probe ??= (async () => {
    const { error } = await supabase
      .from('drive_sessions')
      .select('last_seen_at, link_state')
      .limit(1)
    schema.checked = true
    // A network error is not proof the update is missing; assume it is there
    // and let the individual queries report their own errors.
    schema.v3 = !error || !isMissing(error)
    listeners.forEach((fn) => fn(schema))
    return schema
  })()
  return probe
}

/** Called when a later query discovers a missing v3 object. */
export function markV3Missing() {
  if (schema.v3 === false) return
  schema.v3 = false
  listeners.forEach((fn) => fn(schema))
}

export function onSchema(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

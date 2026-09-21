// One app-wide Realtime channel for the wheel tables. Views never open their
// own channel for these; they register listeners with on() and remove them
// when they unmount, so navigating never leaks subscriptions.
//
// Also owns the two header indicators: connection state and "last update".
import { supabase } from '../supabase.js'

const handlers = { session: new Set(), telemetry: new Set(), archive: new Set(), alert: new Set() }
const statusListeners = new Set()

export const connection = {
  state: 'connecting', // 'connecting' | 'connected' | 'reconnecting'
  lastUpdateAt: null, // ms of the last data we received (load or event)
}

let channel = null

function setState(state) {
  connection.state = state
  statusListeners.forEach((fn) => fn(connection))
}

/** Marks "fresh data just arrived" for the header freshness indicator. */
export function touch() {
  connection.lastUpdateAt = Date.now()
}

function emit(kind, payload) {
  touch()
  handlers[kind].forEach((fn) => {
    try {
      fn(payload)
    } catch (err) {
      console.error(`realtime ${kind} handler failed`, err)
    }
  })
}

/** Starts the shared channel once. session_archives and drive_alerts only
 *  exist after v3; subscribing to a missing table would fail the channel. */
export function startRealtime({ v3 }) {
  if (channel) return
  channel = supabase
    .channel('wheel-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'drive_sessions' }, (p) =>
      emit('session', p)
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'telemetry_events' },
      (p) => emit('telemetry', p.new)
    )
  if (v3) {
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'session_archives' },
      (p) => emit('archive', p.new)
    )
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'drive_alerts' }, (p) =>
      emit('alert', p.eventType === 'DELETE' ? { ...p.old, _deleted: true } : p.new)
    )
  }
  // supabase-js rejoins the channel on its own after a drop; we only reflect it.
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') setState('connected')
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
      setState('reconnecting')
  })
}

/** Registers a listener; returns the function that removes it. */
export function on(kind, fn) {
  handlers[kind].add(fn)
  return () => handlers[kind].delete(fn)
}

export function onConnection(fn) {
  statusListeners.add(fn)
  fn(connection)
  return () => statusListeners.delete(fn)
}

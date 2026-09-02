/**
 * Pushes locally recorded drives to Supabase.
 *
 * Design rules this follows, in order of importance:
 *
 * 1. **Local SQLite is the source of truth.** Sync is a background convenience.
 *    A failed upload must never lose or alter a recorded drive, so nothing here
 *    deletes local rows — it only advances `sync_status`.
 * 2. **Idempotent by construction.** Every row already carries a phone-generated
 *    UUID, so uploads are `upsert`s keyed on that id. Re-running after a partial
 *    failure re-sends the same rows harmlessly; no duplicates, no ID remapping.
 * 3. **Parents before children.** Profiles, then sessions, then telemetry, so a
 *    foreign key never points at a row that has not landed yet.
 * 4. **Never called automatically.** The caller decides when to sync, which
 *    keeps the offline guarantee honest: the app is fully usable with the radio
 *    off and only touches the network when someone asks it to.
 */
import { supabase } from '../supabase';
import { getDatabase } from './database';
import type { DriveSession, DriverProfile, TelemetryEvent } from './repositories';

/** Rows are uploaded in batches; a whole session can be thousands of samples. */
const BATCH_SIZE = 500;

export type SyncResult = {
  profiles: number;
  sessions: number;
  events: number;
  errors: string[];
};

/**
 * Uploads everything still marked `local`.
 *
 * Only *finished* sessions are sent: an active session is still accumulating
 * telemetry and has no duration yet, so uploading it would publish a row that
 * is about to change.
 */
export async function syncToSupabase(): Promise<SyncResult> {
  const db = await getDatabase();
  const result: SyncResult = { profiles: 0, sessions: 0, events: 0, errors: [] };

  // --- 1. profiles ---------------------------------------------------------
  const profiles = await db.getAllAsync<DriverProfile>(
    'SELECT * FROM driver_profiles',
  );
  if (profiles.length > 0) {
    const { error } = await supabase.from('driver_profiles').upsert(
      profiles.map((p) => ({
        id: p.id,
        custom_id: p.custom_id,
        display_name: p.display_name,
        weight_kg: p.weight_kg,
        age: p.age,
        height_cm: p.height_cm,
        gender: p.gender,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })),
      { onConflict: 'id' },
    );
    if (error) {
      // Without profiles, every session below would violate its foreign key.
      result.errors.push(`profiles: ${error.message}`);
      return result;
    }
    result.profiles = profiles.length;
  }

  // --- 2. sessions ---------------------------------------------------------
  const sessions = await db.getAllAsync<DriveSession>(
    `SELECT * FROM drive_sessions
     WHERE sync_status = 'local' AND status != 'active'`,
  );
  if (sessions.length > 0) {
    const { error } = await supabase.from('drive_sessions').upsert(
      sessions.map((s) => ({
        id: s.id,
        profile_id: s.profile_id,
        started_at: s.started_at,
        ended_at: s.ended_at,
        duration_seconds: s.duration_seconds,
        status: s.status,
      })),
      { onConflict: 'id' },
    );
    if (error) {
      result.errors.push(`sessions: ${error.message}`);
      return result;
    }
    result.sessions = sessions.length;
  }

  // --- 3. telemetry --------------------------------------------------------
  // Restricted to sessions that just landed, so an event can never be uploaded
  // before the session it references.
  const syncedSessionIds = sessions.map((s) => s.id);
  for (const sessionId of syncedSessionIds) {
    let offset = 0;
    for (;;) {
      const events = await db.getAllAsync<TelemetryEvent>(
        `SELECT * FROM telemetry_events
         WHERE session_id = ? AND sync_status = 'local'
         ORDER BY sequence_number ASC
         LIMIT ? OFFSET ?`,
        [sessionId, BATCH_SIZE, offset],
      );
      if (events.length === 0) break;

      const { error } = await supabase.from('telemetry_events').upsert(
        events.map((e) => ({
          id: e.id,
          session_id: e.session_id,
          sequence_number: e.sequence_number,
          event_type: e.event_type,
          bpm: e.bpm,
          spo2: e.spo2,
          signal_quality: e.signal_quality,
          battery: e.battery,
          received_at: e.received_at,
        })),
        { onConflict: 'id' },
      );
      if (error) {
        result.errors.push(`telemetry (${sessionId}): ${error.message}`);
        return result;
      }

      // Marked only after the server confirms, so an interrupted sync resumes
      // from exactly where it stopped rather than silently skipping rows.
      await db.runAsync(
        `UPDATE telemetry_events SET sync_status = 'synced'
         WHERE id IN (${events.map(() => '?').join(',')})`,
        events.map((e) => e.id),
      );
      result.events += events.length;
      offset += events.length;
    }

    await db.runAsync(
      "UPDATE drive_sessions SET sync_status = 'synced' WHERE id = ?",
      [sessionId],
    );
  }

  return result;
}

/** How much is waiting to upload, for a "Sync (N)" button. */
export async function pendingCount(): Promise<{ sessions: number; events: number }> {
  const db = await getDatabase();
  const s = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM drive_sessions
     WHERE sync_status = 'local' AND status != 'active'`,
  );
  const e = await db.getFirstAsync<{ c: number }>(
    "SELECT COUNT(*) AS c FROM telemetry_events WHERE sync_status = 'local'",
  );
  return { sessions: s?.c ?? 0, events: e?.c ?? 0 };
}

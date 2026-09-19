/**
 * Streams the ACTIVE session to Supabase while the drive is in progress, so
 * the team website can show it live.
 *
 * Same rules as sync.ts, which this complements rather than replaces:
 * - Local SQLite stays the source of truth. A failed push changes nothing
 *   locally; the next tick re-sends whatever is still `local`.
 * - Upserts keyed on phone-generated UUIDs, so an overlap with a manual sync or
 *   a retried batch is harmless.
 * - Parents before children: profile, then session, then telemetry.
 *
 * The session row is pushed with status 'active' and is deliberately NOT
 * marked synced: when it ends, the normal sync (or this uploader's final
 * flush) upserts it again with ended_at and duration.
 */
import { supabase } from '../supabase';
import { getDatabase } from './database';
import type { DriveSession, DriverProfile, TelemetryEvent } from './repositories';

const INTERVAL_MS = 3000;
const BATCH_SIZE = 200;

export type LiveStatus = { ok: boolean; pushed: number; lastError: string | null; lastPushAt: Date | null };

export class LiveUploader {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> = Promise.resolve();
  private sessionId: string | null = null;
  private parentsPushed = false;
  readonly status: LiveStatus = { ok: true, pushed: 0, lastError: null, lastPushAt: null };

  constructor(private readonly onStatus?: (s: LiveStatus) => void) {}

  /** Begins streaming a session. Safe to call again for a new session. */
  follow(sessionId: string) {
    this.sessionId = sessionId;
    this.parentsPushed = false;
    if (!this.timer) this.timer = setInterval(() => void this.flush(), INTERVAL_MS);
    void this.flush();
  }

  /** Final flush for a session that just ended (pushes ended_at/duration). */
  async finish(sessionId: string): Promise<void> {
    if (this.sessionId === sessionId) this.sessionId = null;
    if (!this.sessionId && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.enqueue(() => this.push(sessionId, true));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sessionId = null;
  }

  private flush(): Promise<void> {
    const id = this.sessionId;
    return id ? this.enqueue(() => this.push(id, false)) : Promise.resolve();
  }

  /** One push at a time: ticks never overlap even on a slow network. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.running = this.running.then(fn).catch(() => undefined);
    return this.running;
  }

  private report(error: string | null, pushed = 0) {
    this.status.ok = error === null;
    this.status.lastError = error;
    this.status.pushed += pushed;
    if (error === null) this.status.lastPushAt = new Date();
    this.onStatus?.({ ...this.status });
  }

  private async push(sessionId: string, final: boolean): Promise<void> {
    try {
      const db = await getDatabase();
      const session = await db.getFirstAsync<DriveSession>('SELECT * FROM drive_sessions WHERE id = ?', [sessionId]);
      if (!session) return;

      if (!this.parentsPushed || final) {
        const profile = await db.getFirstAsync<DriverProfile>('SELECT * FROM driver_profiles WHERE id = ?', [
          session.profile_id,
        ]);
        if (!profile) return;
        let r = await supabase.from('driver_profiles').upsert(
          {
            id: profile.id,
            custom_id: profile.custom_id,
            display_name: profile.display_name,
            weight_kg: profile.weight_kg,
            age: profile.age,
            height_cm: profile.height_cm,
            gender: profile.gender,
            created_at: profile.created_at,
            updated_at: profile.updated_at,
          },
          { onConflict: 'id' },
        );
        if (r.error) return this.report(`profile: ${r.error.message}`);
        r = await supabase.from('drive_sessions').upsert(
          {
            id: session.id,
            profile_id: session.profile_id,
            started_at: session.started_at,
            ended_at: session.ended_at,
            duration_seconds: session.duration_seconds,
            status: session.status,
          },
          { onConflict: 'id' },
        );
        if (r.error) return this.report(`session: ${r.error.message}`);
        if (session.status === 'active') this.parentsPushed = true;
      }

      let pushed = 0;
      for (;;) {
        // Always from the start of what is still local: rows marked synced drop
        // out, so no OFFSET is needed and none can be skipped.
        const events = await db.getAllAsync<TelemetryEvent>(
          `SELECT * FROM telemetry_events
           WHERE session_id = ? AND sync_status = 'local'
           ORDER BY sequence_number ASC LIMIT ?`,
          [sessionId, BATCH_SIZE],
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
        if (error) return this.report(`telemetry: ${error.message}`, pushed);
        await db.runAsync(
          `UPDATE telemetry_events SET sync_status = 'synced'
           WHERE id IN (${events.map(() => '?').join(',')})`,
          events.map((e) => e.id),
        );
        pushed += events.length;
        if (events.length < BATCH_SIZE) break;
      }

      if (final && session.status !== 'active') {
        await db.runAsync("UPDATE drive_sessions SET sync_status = 'synced' WHERE id = ?", [sessionId]);
      }
      this.report(null, pushed);
    } catch (e) {
      // Offline or DNS failure: stay quiet, the next tick retries.
      this.report(e instanceof Error ? e.message : String(e));
    }
  }
}

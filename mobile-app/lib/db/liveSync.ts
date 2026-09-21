/**
 * Streams the ACTIVE session to Supabase while the drive is in progress, so
 * the website shows it live (typically within ~1-2 s of the sensor reading).
 *
 * Same rules as sync.ts, which this complements rather than replaces:
 * - Local SQLite stays the source of truth. A failed push changes nothing
 *   locally; the next tick re-sends whatever is still `local`.
 * - Upserts keyed on phone-generated UUIDs, so an overlap with a manual sync or
 *   a retried batch is harmless.
 * - Parents before children: profile, then session, then telemetry/alerts.
 *
 * Every tick (1 s) also upserts the session row as a heartbeat: last_seen_at
 * plus link_state ('streaming' | 'sensor_lost' | 'pi_lost'), so the dashboard
 * can tell "phone online but the wheel sensor dropped" from "phone went quiet".
 *
 * Schema tolerance: if the database hasn't had supabase/v3_dashboard.sql yet,
 * the v3 columns don't exist and PostgREST rejects the whole upsert. The first
 * such error switches this uploader to the v2 column set, so live upload keeps
 * working on an older database instead of silently stopping.
 */
import { supabase } from '../supabase';
import { getDatabase } from './database';
import type { DriveAlertRow, DriveSession, DriverProfile, TelemetryEvent } from './repositories';
import { archiveBytes, archiveInfo } from '../archive/archiveStore';

const INTERVAL_MS = 1000;
const BATCH_SIZE = 200;
export const ARCHIVE_BUCKET = 'session-archives';

export type LinkState = 'streaming' | 'sensor_lost' | 'pi_lost';

export type LiveStatus = {
  ok: boolean;
  /** Telemetry rows confirmed by the server this session. */
  pushed: number;
  /** Approximate request payload bytes sent (for the data-rate indicator). */
  bytesSent: number;
  lastError: string | null;
  lastPushAt: Date | null;
  legacySchema: boolean;
  archive: 'none' | 'uploading' | 'uploaded' | 'failed';
};

const isMissingColumn = (msg: string) =>
  /column .* does not exist|Could not find the .* column|schema cache|relation .* does not exist/i.test(msg);

export class LiveUploader {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> = Promise.resolve();
  private sessionId: string | null = null;
  private profilePushed: string | null = null;
  private v3 = true;
  readonly status: LiveStatus = {
    ok: true,
    pushed: 0,
    bytesSent: 0,
    lastError: null,
    lastPushAt: null,
    legacySchema: false,
    archive: 'none',
  };

  private readonly onStatus?: (s: LiveStatus) => void;
  private readonly linkState: () => LinkState;

  constructor(linkState: () => LinkState, onStatus?: (s: LiveStatus) => void) {
    this.linkState = linkState;
    this.onStatus = onStatus;
  }

  /** Begins streaming a session. Safe to call again for a new session. */
  follow(sessionId: string) {
    this.sessionId = sessionId;
    this.status.pushed = 0;
    this.status.archive = 'none';
    if (!this.timer) this.timer = setInterval(() => void this.flush(), INTERVAL_MS);
    void this.flush();
  }

  /** Final flush for a session that just ended: end time, remaining rows,
   *  alerts, and the folded archive if there is one. */
  async finish(sessionId: string): Promise<void> {
    if (this.sessionId === sessionId) this.sessionId = null;
    if (!this.sessionId && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.enqueue(() => this.push(sessionId, true));
  }

  /** Pushes something that happened outside the tick (e.g. an alert prompt)
   *  right away instead of waiting up to a second. */
  nudge() {
    void this.flush();
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
    this.status.legacySchema = !this.v3;
    if (error === null) this.status.lastPushAt = new Date();
    this.onStatus?.({ ...this.status });
  }

  /** Upsert with automatic fallback to the pre-v3 column set. */
  private async upsert(table: string, rows: Record<string, unknown>[], v3Keys: string[]) {
    const strip = (r: Record<string, unknown>) => {
      const c = { ...r };
      for (const k of v3Keys) delete c[k];
      return c;
    };
    const body = this.v3 ? rows : rows.map(strip);
    this.status.bytesSent += JSON.stringify(body).length;
    let r = await supabase.from(table).upsert(body, { onConflict: 'id' });
    if (r.error && this.v3 && v3Keys.length && isMissingColumn(r.error.message)) {
      this.v3 = false;
      r = await supabase.from(table).upsert(rows.map(strip), { onConflict: 'id' });
    }
    return r.error;
  }

  private async push(sessionId: string, final: boolean): Promise<void> {
    try {
      const db = await getDatabase();
      const session = await db.getFirstAsync<DriveSession>('SELECT * FROM drive_sessions WHERE id = ?', [sessionId]);
      if (!session) return;

      if (this.profilePushed !== session.profile_id || final) {
        const profile = await db.getFirstAsync<DriverProfile>('SELECT * FROM driver_profiles WHERE id = ?', [
          session.profile_id,
        ]);
        if (!profile) return;
        const err = await this.upsert(
          'driver_profiles',
          [
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
          ],
          [],
        );
        if (err) return this.report(`profile: ${err.message}`);
        this.profilePushed = profile.id;
      }

      // Session row every tick: it is the heartbeat.
      const err = await this.upsert(
        'drive_sessions',
        [
          {
            id: session.id,
            profile_id: session.profile_id,
            started_at: session.started_at,
            ended_at: session.ended_at,
            duration_seconds: session.duration_seconds,
            status: session.status,
            last_seen_at: new Date().toISOString(),
            link_state: session.status === 'active' ? this.linkState() : null,
            storage_mode: session.storage_mode ?? 'vitals',
            sample_rate_hz: session.sample_rate_hz ?? null,
          },
        ],
        ['last_seen_at', 'link_state', 'storage_mode', 'sample_rate_hz'],
      );
      if (err) return this.report(`session: ${err.message}`);

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
        const e2 = await this.upsert(
          'telemetry_events',
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
            finger: e.finger === null || e.finger === undefined ? null : e.finger === 1,
            quality: e.quality ?? null,
          })),
          ['finger', 'quality'],
        );
        if (e2) return this.report(`telemetry: ${e2.message}`, pushed);
        await db.runAsync(
          `UPDATE telemetry_events SET sync_status = 'synced'
           WHERE id IN (${events.map(() => '?').join(',')})`,
          events.map((e) => e.id),
        );
        pushed += events.length;
        if (events.length < BATCH_SIZE) break;
      }

      if (this.v3) await this.pushAlerts(sessionId);
      if (final && session.status !== 'active') {
        if (this.v3) await this.pushArchive(sessionId);
        await db.runAsync("UPDATE drive_sessions SET sync_status = 'synced' WHERE id = ?", [sessionId]);
      }
      this.report(null, pushed);
    } catch (e) {
      // Offline or DNS failure: stay quiet, the next tick retries.
      this.report(e instanceof Error ? e.message : String(e));
    }
  }

  private async pushAlerts(sessionId: string) {
    const db = await getDatabase();
    const alerts = await db.getAllAsync<DriveAlertRow>(
      "SELECT * FROM drive_alerts WHERE session_id = ? AND sync_status = 'local'",
      [sessionId],
    );
    if (!alerts.length) return;
    const body = alerts.map(({ sync_status: _s, escalated, ...a }) => ({ ...a, escalated: escalated === 1 }));
    this.status.bytesSent += JSON.stringify(body).length;
    const { error } = await supabase.from('drive_alerts').upsert(body, { onConflict: 'id' });
    if (error) return; // table missing on an old database: alerts stay local, retried later
    await db.runAsync(
      `UPDATE drive_alerts SET sync_status = 'synced' WHERE id IN (${alerts.map(() => '?').join(',')})`,
      alerts.map((a) => a.id),
    );
  }

  /** Off-site copy of the folded archive (Storage) + its metadata row. */
  private async pushArchive(sessionId: string) {
    const info = await archiveInfo(sessionId);
    if (!info || info.sync_status === 'synced') return;
    const bytes = await archiveBytes(sessionId);
    if (!bytes) return;
    this.status.archive = 'uploading';
    this.onStatus?.({ ...this.status });
    const path = `${sessionId}.ppga`;
    // React Native: supabase-js wants an ArrayBuffer (Blob/File/FormData do
    // not work reliably there -- see the Supabase JS storage upload docs).
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    this.status.bytesSent += bytes.byteLength;
    const up = await supabase.storage
      .from(ARCHIVE_BUCKET)
      .upload(path, buf, { contentType: 'application/octet-stream', upsert: true });
    if (up.error) {
      this.status.archive = 'failed';
      return;
    }
    const { error } = await supabase.from('session_archives').upsert(
      {
        session_id: sessionId,
        format: 'PPGA',
        format_version: info.format_version,
        sample_rate_hz: info.sample_rate_hz,
        sample_count: info.sample_count,
        frame_count: info.frame_count,
        raw_bytes: info.raw_bytes,
        packed_bytes: info.packed_bytes,
        sha256: info.sha256,
        storage_path: path,
      },
      { onConflict: 'session_id' },
    );
    if (error) {
      this.status.archive = 'failed';
      return;
    }
    const db = await getDatabase();
    await db.runAsync("UPDATE session_archives SET sync_status = 'synced' WHERE session_id = ?", [sessionId]);
    this.status.archive = 'uploaded';
  }
}

/**
 * Data access for the Smart Wheel tables.
 *
 * All SQL lives here. Nothing in components/ or hooks/ writes a query, so the
 * storage layer can change (or gain a Supabase sync step) without touching UI.
 */
import { getDatabase } from './database';
import { bytesToBase64, uuidv4, type Frame } from '../ble/protocol';
import { computeBaseline, type Baseline } from '../analysis/baseline';
import { robustStats, type RobustStats } from '../analysis/stats';

export type Gender = 'male' | 'female' | 'other' | 'prefer_not_to_say';

export type DriverProfile = {
  id: string;
  /** Team-assigned identifier (e.g. subject code), distinct from the UUID. */
  custom_id: string | null;
  display_name: string;
  weight_kg: number | null;
  age: number | null;
  height_cm: number | null;
  gender: Gender | null;
  created_at: string;
  updated_at: string;
};

export type NewProfileInput = {
  custom_id?: string | null;
  display_name: string;
  weight_kg?: number | null;
  age?: number | null;
  height_cm?: number | null;
  gender?: Gender | null;
};

export type SessionStatus = 'active' | 'completed' | 'interrupted';

export type DriveSession = {
  id: string;
  profile_id: string;
  started_at: string;
  ended_at: string | null;
  /** Wall-clock length, computed once on end so reports need no date math. */
  duration_seconds: number | null;
  status: SessionStatus;
  sync_status: string;
  /** 'vitals' (default, proposal: processed values only) or 'full' (every raw
   *  sample, folded into an archive when the session ends). */
  storage_mode?: StorageMode;
  sample_rate_hz?: number | null;
};

export type StorageMode = 'vitals' | 'full';

export type TelemetryEvent = {
  id: string;
  session_id: string;
  sequence_number: number | null;
  event_type: string;
  /** Promoted out of raw_payload so the dashboard can query without parsing. */
  bpm: number | null;
  spo2: number | null;
  signal_quality: number | null;
  battery: number | null;
  received_at: string;
  raw_payload: string | null;
  sync_status: string;
  finger?: number | null; // SQLite boolean
  quality?: number | null;
};

/** Aggregate physiological stats for one session. */
export type SessionStats = {
  samples: number;
  bpm_min: number | null;
  bpm_max: number | null;
  bpm_avg: number | null;
  spo2_min: number | null;
  spo2_max: number | null;
  spo2_avg: number | null;
};

export type SessionSummary = DriveSession & {
  driver_name: string;
  event_count: number;
};

/** 'stored' vs 'duplicate' so callers need not re-query to tell them apart. */
export type StoreResult = 'stored' | 'duplicate';

const nowIso = (): string => new Date().toISOString();

// --- profiles --------------------------------------------------------------

export async function listProfiles(): Promise<DriverProfile[]> {
  const db = await getDatabase();
  return db.getAllAsync<DriverProfile>(
    'SELECT * FROM driver_profiles ORDER BY display_name COLLATE NOCASE ASC',
  );
}

export async function createProfile(
  input: NewProfileInput,
): Promise<DriverProfile> {
  const name = input.display_name.trim();
  if (!name) {
    throw new Error('Driver name cannot be empty');
  }
  const db = await getDatabase();
  const profile: DriverProfile = {
    id: uuidv4(),
    custom_id: input.custom_id?.trim() || null,
    display_name: name,
    weight_kg: input.weight_kg ?? null,
    age: input.age ?? null,
    height_cm: input.height_cm ?? null,
    gender: input.gender ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await db.runAsync(
    `INSERT INTO driver_profiles
       (id, custom_id, display_name, weight_kg, age, height_cm, gender,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      profile.id,
      profile.custom_id,
      profile.display_name,
      profile.weight_kg,
      profile.age,
      profile.height_cm,
      profile.gender,
      profile.created_at,
      profile.updated_at,
    ],
  );
  return profile;
}

export async function deleteProfile(id: string): Promise<void> {
  const db = await getDatabase();
  // Cascades to sessions and their telemetry via the FK definitions.
  await db.runAsync('DELETE FROM driver_profiles WHERE id = ?', [id]);
}

// --- sessions --------------------------------------------------------------

export async function startSession(
  profileId: string,
  storageMode: StorageMode = 'vitals',
): Promise<DriveSession> {
  const db = await getDatabase();
  const session: DriveSession = {
    id: uuidv4(),
    profile_id: profileId,
    started_at: nowIso(),
    ended_at: null,
    duration_seconds: null,
    status: 'active',
    sync_status: 'local',
    storage_mode: storageMode,
    sample_rate_hz: null,
  };
  await db.runAsync(
    `INSERT INTO drive_sessions
       (id, profile_id, started_at, ended_at, status, sync_status, storage_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.profile_id,
      session.started_at,
      null,
      session.status,
      session.sync_status,
      storageMode,
    ],
  );
  return session;
}

/** Records the sensor's sample rate once the first v3 frame arrives. */
export async function setSessionSampleRate(sessionId: string, rateHz: number): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE drive_sessions SET sample_rate_hz = ? WHERE id = ? AND sample_rate_hz IS NULL', [
    rateHz,
    sessionId,
  ]);
}

export async function getSession(id: string): Promise<DriveSession | null> {
  const db = await getDatabase();
  return db.getFirstAsync<DriveSession>('SELECT * FROM drive_sessions WHERE id = ?', [id]);
}

// --- settings ----------------------------------------------------------------

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

export async function getStorageMode(): Promise<StorageMode> {
  return (await getSetting('storage_mode')) === 'full' ? 'full' : 'vitals';
}

export async function endSession(session: DriveSession): Promise<DriveSession> {
  const db = await getDatabase();
  const ended: DriveSession = {
    ...session,
    ended_at: nowIso(),
    status: 'completed',
    duration_seconds: null,
  };
  ended.duration_seconds = Math.max(
    0,
    Math.round(
      (new Date(ended.ended_at!).getTime() -
        new Date(ended.started_at).getTime()) / 1000,
    ),
  );
  await db.runAsync(
    `UPDATE drive_sessions
     SET ended_at = ?, status = ?, duration_seconds = ? WHERE id = ?`,
    [ended.ended_at, ended.status, ended.duration_seconds, ended.id],
  );
  return ended;
}

/**
 * Closes sessions left 'active' by a crash or force-quit.
 *
 * The session is deliberately not resumed: that would mean trusting that the
 * wheel's sequence counter had not restarted, which the phone cannot verify,
 * and a restarted counter would collide with stored sequences. `ended_at` is
 * set to the last telemetry timestamp so the recorded duration reflects real
 * data rather than when the app happened to relaunch. Telemetry is never
 * deleted.
 */
export async function recoverInterruptedSessions(): Promise<number> {
  const db = await getDatabase();
  const stale = await db.getAllAsync<DriveSession>(
    "SELECT * FROM drive_sessions WHERE status = 'active'",
  );
  for (const session of stale) {
    const last = await db.getFirstAsync<{ last: string | null }>(
      'SELECT MAX(received_at) AS last FROM telemetry_events WHERE session_id = ?',
      [session.id],
    );
    await db.runAsync(
      "UPDATE drive_sessions SET status = 'interrupted', ended_at = ? WHERE id = ?",
      [last?.last ?? session.started_at, session.id],
    );
  }
  return stale.length;
}

export async function listSessions(limit = 100): Promise<SessionSummary[]> {
  const db = await getDatabase();
  return db.getAllAsync<SessionSummary>(
    `SELECT s.*, p.display_name AS driver_name,
            (SELECT COUNT(*) FROM telemetry_events e WHERE e.session_id = s.id)
              AS event_count
     FROM drive_sessions s
     JOIN driver_profiles p ON p.id = s.profile_id
     ORDER BY s.started_at DESC
     LIMIT ?`,
    [limit],
  );
}

// --- telemetry -------------------------------------------------------------

/**
 * Persists one frame (one second of telemetry).
 *
 * `received_at` is stamped on the phone and is the authoritative reception
 * time. BPM and SpO2 are stored only when the frame is usable (finger on,
 * both values valid and plausible); otherwise they are NULL rather than the
 * wheel's -999 "no result" marker, so charts and averages never ingest it.
 * The verbatim frame is kept base64-encoded in raw_payload for re-analysis.
 *
 * INSERT OR IGNORE leans on the UNIQUE(session_id, sequence_number) index, so
 * a replayed sequence is dropped rather than raising.
 */
export async function storeFrame(
  sessionId: string,
  frame: Frame,
  receivedAt: Date = new Date(),
  keepRaw = false,
): Promise<StoreResult> {
  const db = await getDatabase();
  // raw_payload only in 'full' storage mode: the proposal commits to keeping
  // processed values, not raw PPG, unless the user opts in. Even then it is
  // temporary -- folded into the session archive when the session ends.
  const result = await db.runAsync(
    `INSERT OR IGNORE INTO telemetry_events
       (id, session_id, sequence_number, event_type, bpm, spo2,
        signal_quality, battery, received_at, raw_payload, sync_status, finger, quality)
     VALUES (?, ?, ?, 'vitals', ?, ?, ?, NULL, ?, ?, 'local', ?, ?)`,
    [
      uuidv4(),
      sessionId,
      frame.seq,
      frame.usable ? frame.heartRate : null,
      frame.usable ? frame.spo2 : null,
      frame.version >= 3 ? frame.quality : null,
      receivedAt.toISOString(),
      keepRaw ? bytesToBase64(frame.raw) : null,
      frame.finger ? 1 : 0,
      frame.version >= 3 ? frame.quality : null,
    ],
  );
  return result.changes > 0 ? 'stored' : 'duplicate';
}

/** The live counter is this number -- always derived, never stored. */
export async function countForSession(sessionId: string): Promise<number> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM telemetry_events WHERE session_id = ?',
    [sessionId],
  );
  return row?.c ?? 0;
}

export async function knownSequences(sessionId: string): Promise<Set<number>> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ sequence_number: number }>(
    `SELECT sequence_number FROM telemetry_events
     WHERE session_id = ? AND sequence_number IS NOT NULL`,
    [sessionId],
  );
  return new Set(rows.map((r) => r.sequence_number));
}

export async function eventsForSession(
  sessionId: string,
  limit = 200,
): Promise<TelemetryEvent[]> {
  const db = await getDatabase();
  return db.getAllAsync<TelemetryEvent>(
    `SELECT * FROM telemetry_events WHERE session_id = ?
     ORDER BY received_at DESC LIMIT ?`,
    [sessionId, limit],
  );
}


/** Min/max/average heart rate and SpO2 across a session. */
export async function sessionStats(sessionId: string): Promise<SessionStats> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<SessionStats>(
    `SELECT COUNT(bpm) AS samples,
            MIN(bpm) AS bpm_min,  MAX(bpm) AS bpm_max,
            ROUND(AVG(bpm), 1) AS bpm_avg,
            MIN(spo2) AS spo2_min, MAX(spo2) AS spo2_max,
            ROUND(AVG(spo2), 1) AS spo2_avg
     FROM telemetry_events
     WHERE session_id = ? AND bpm IS NOT NULL`,
    [sessionId],
  );
  return (
    row ?? {
      samples: 0,
      bpm_min: null,
      bpm_max: null,
      bpm_avg: null,
      spo2_min: null,
      spo2_max: null,
      spo2_avg: null,
    }
  );
}

// --- robust summaries & baselines ---------------------------------------------

export type RobustSessionStats = {
  frames: number;
  usablePct: number | null;
  bpm: RobustStats;
  spo2: RobustStats;
};

/** Percentile-based summary of a session (see lib/analysis/stats.ts). */
export async function robustSessionStats(sessionId: string): Promise<RobustSessionStats> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ bpm: number | null; spo2: number | null }>(
    'SELECT bpm, spo2 FROM telemetry_events WHERE session_id = ?',
    [sessionId],
  );
  const bpm = rows.map((r) => r.bpm).filter((v): v is number => v !== null);
  const spo2 = rows.map((r) => r.spo2).filter((v): v is number => v !== null);
  return {
    frames: rows.length,
    usablePct: rows.length ? (100 * bpm.length) / rows.length : null,
    bpm: robustStats(bpm),
    spo2: robustStats(spo2),
  };
}

/** The driver's usual range from their completed sessions on this phone. */
export async function driverBaseline(profileId: string): Promise<Baseline> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ bpm: number; spo2: number | null; session_id: string }>(
    `SELECT e.bpm, e.spo2, e.session_id FROM telemetry_events e
     JOIN drive_sessions s ON s.id = e.session_id
     WHERE s.profile_id = ? AND s.status = 'completed' AND e.bpm IS NOT NULL`,
    [profileId],
  );
  return computeBaseline(
    rows.map((r) => r.bpm),
    rows.map((r) => r.spo2).filter((v): v is number => v !== null),
    new Set(rows.map((r) => r.session_id)).size,
  );
}

// --- alerts --------------------------------------------------------------------

export type DriveAlertRow = {
  id: string;
  session_id: string;
  kind: string;
  value: number | null;
  threshold: number | null;
  started_at: string;
  prompted_at: string | null;
  response: string | null;
  responded_at: string | null;
  escalated: number;
  sync_status: string;
};

export async function saveAlert(a: Omit<DriveAlertRow, 'sync_status'>): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO drive_alerts (id, session_id, kind, value, threshold, started_at, prompted_at,
                               response, responded_at, escalated, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')
     ON CONFLICT(id) DO UPDATE SET response = excluded.response, responded_at = excluded.responded_at,
       escalated = excluded.escalated, sync_status = 'local'`,
    [a.id, a.session_id, a.kind, a.value, a.threshold, a.started_at, a.prompted_at, a.response,
     a.responded_at, a.escalated],
  );
}

export async function alertsForSession(sessionId: string): Promise<DriveAlertRow[]> {
  const db = await getDatabase();
  return db.getAllAsync<DriveAlertRow>('SELECT * FROM drive_alerts WHERE session_id = ? ORDER BY started_at', [
    sessionId,
  ]);
}


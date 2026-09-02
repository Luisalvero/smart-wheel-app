/**
 * Local offline database.
 *
 * Uses `expo-sqlite`, which is already declared in package.json and listed in
 * app.json's plugins array but not yet used by any code.
 *
 * The design is local-first on purpose: telemetry is written here the moment it
 * arrives over BLE, with no network involved, so a drive recorded in a parking
 * garage is never lost. `sync_status` is left at 'local' for a later step to
 * push rows to Supabase -- this module deliberately does no networking.
 */
import * as SQLite from 'expo-sqlite';

export const DB_NAME = 'smart_wheel.db';

/**
 * Bumped whenever the schema changes. Migrations run in order from whatever
 * version the device is on, so an existing install keeps its recorded drives
 * instead of being wiped.
 */
export const SCHEMA_VERSION = 2;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Opens (once) and migrates the database. Safe to call from anywhere. */
export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openAndMigrate();
  }
  return dbPromise;
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);

  // WAL keeps reads from blocking the notification write path.
  // Foreign keys are OFF by default in SQLite; without this the references
  // below would be decorative rather than enforced.
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS driver_profiles (
      id           TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drive_sessions (
      id          TEXT PRIMARY KEY NOT NULL,
      profile_id  TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      status      TEXT NOT NULL,
      sync_status TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES driver_profiles (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS telemetry_events (
      id              TEXT PRIMARY KEY NOT NULL,
      session_id      TEXT NOT NULL,
      sequence_number INTEGER,
      event_type      TEXT NOT NULL,
      received_at     TEXT NOT NULL,
      raw_payload     TEXT,
      sync_status     TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES drive_sessions (id) ON DELETE CASCADE
    );

    -- Durable duplicate protection. BLE notifications can be replayed, and a
    -- reconnect mid-session can re-deliver. The in-memory guard in the hook is
    -- the fast path; this index is what makes de-duplication survive a restart.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_session_sequence
      ON telemetry_events (session_id, sequence_number)
      WHERE sequence_number IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_telemetry_session
      ON telemetry_events (session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_profile
      ON drive_sessions (profile_id);
  `);

  await migrate(db);
  return db;
}

/**
 * Incremental migrations keyed on SQLite's own `user_version`.
 *
 * Additive only -- columns are added, never dropped or retyped -- so a phone
 * holding unsynced drives can upgrade without losing them.
 */
async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version',
  );
  const current = row?.user_version ?? 0;

  if (current < 2) {
    // v2: driver demographics, and physiological values promoted out of
    // raw_payload into real columns so the dashboard can query them directly
    // rather than parsing JSON on every read.
    const addColumn = async (table: string, ddl: string) => {
      try {
        await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      } catch {
        // Column already present (a partially-applied migration); safe to skip.
      }
    };

    await addColumn('driver_profiles', 'custom_id TEXT');
    await addColumn('driver_profiles', 'weight_kg REAL');
    await addColumn('driver_profiles', 'age INTEGER');
    await addColumn('driver_profiles', 'height_cm REAL');
    await addColumn('driver_profiles', 'gender TEXT');

    await addColumn('drive_sessions', 'duration_seconds INTEGER');

    await addColumn('telemetry_events', 'bpm INTEGER');
    await addColumn('telemetry_events', 'spo2 INTEGER');
    await addColumn('telemetry_events', 'signal_quality INTEGER');
    await addColumn('telemetry_events', 'battery INTEGER');

    await db.execAsync(
      'CREATE INDEX IF NOT EXISTS idx_profiles_custom_id ' +
        'ON driver_profiles (custom_id)',
    );
  }

  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Development helper: row counts for the debug panel. */
export async function tableCounts(): Promise<Record<string, number>> {
  const db = await getDatabase();
  const counts: Record<string, number> = {};
  for (const table of ['driver_profiles', 'drive_sessions', 'telemetry_events']) {
    const row = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${table}`,
    );
    counts[table] = row?.c ?? 0;
  }
  return counts;
}

/** Development helper: wipes local data without touching the schema. */
export async function resetDatabase(): Promise<void> {
  const db = await getDatabase();
  await db.execAsync(`
    DELETE FROM telemetry_events;
    DELETE FROM drive_sessions;
    DELETE FROM driver_profiles;
  `);
}

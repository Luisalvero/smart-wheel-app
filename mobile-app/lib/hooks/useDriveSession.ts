/**
 * Application state for one driver's drive.
 *
 * The only place BLE, the frame decoder and the database meet. Plain
 * useReducer rather than a state library: the reactive surface is a handful of
 * values on one screen.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { WheelConnection, type ConnectionState, type RelayStatus, type Source } from '../ble/bleService';
import { Deframer, SeqTracker, type Frame } from '../ble/protocol';
import * as repo from '../db/repositories';
import type { DriveSession, DriverProfile } from '../db/repositories';

/** Seconds of vitals kept for the on-screen charts. */
export const CHART_SECONDS = 120;
const AVG_WINDOW = 5;

export type Point = { t: number; v: number | null }; // v null = unusable second

export type LinkInfo = { source: Source; name: string; id: string; connectedAt: Date };

type State = {
  connection: ConnectionState;
  error: string | null;
  link: LinkInfo | null;
  relay: RelayStatus | null;
  driver: DriverProfile | null;
  session: DriveSession | null;
  bpm: number | null;
  spo2: number | null;
  avgBpm: number | null;
  avgSpo2: number | null;
  finger: boolean;
  bpmSeries: Point[];
  spo2Series: Point[];
  packets: number;
  stored: number;
  lastSeq: number | null;
  lastRx: Date | null;
  lost: number;
  crcErrors: number;
  duplicates: number;
  ignoredNoSession: number;
  /** Sessions auto-started because the ESP32 restarted (new ignition cycle). */
  rollovers: number;
  notice: string | null;
};

type Action =
  | { type: 'connection'; state: ConnectionState; error?: string }
  | { type: 'link'; link: LinkInfo }
  | { type: 'relay'; relay: RelayStatus }
  | { type: 'driver'; driver: DriverProfile }
  | { type: 'session'; session: DriveSession | null }
  | { type: 'frame'; frame: Frame; rx: Date; avgBpm: number | null; avgSpo2: number | null; lost: number; crc: number }
  | { type: 'stored' }
  | { type: 'duplicate' }
  | { type: 'ignored' }
  | { type: 'storeError'; error: string }
  | { type: 'rollover'; session: DriveSession }
  | { type: 'resetSession' };

const initial: State = {
  connection: 'idle',
  error: null,
  link: null,
  relay: null,
  driver: null,
  session: null,
  bpm: null,
  spo2: null,
  avgBpm: null,
  avgSpo2: null,
  finger: false,
  bpmSeries: [],
  spo2Series: [],
  packets: 0,
  stored: 0,
  lastSeq: null,
  lastRx: null,
  lost: 0,
  crcErrors: 0,
  duplicates: 0,
  ignoredNoSession: 0,
  rollovers: 0,
  notice: null,
};

const trim = (s: Point[], now: number) => s.filter((p) => now - p.t <= CHART_SECONDS * 1000);

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'connection':
      return {
        ...s,
        connection: a.state,
        error: a.error ?? null,
        link: a.state === 'disconnected' || a.state === 'failed' ? null : s.link,
        relay: a.state === 'disconnected' || a.state === 'failed' ? null : s.relay,
      };
    case 'link':
      return { ...s, link: a.link };
    case 'relay':
      return { ...s, relay: a.relay };
    case 'driver':
      return { ...initial, connection: s.connection, link: s.link, relay: s.relay, driver: a.driver };
    case 'session':
      return { ...s, session: a.session };
    case 'frame': {
      const t = a.rx.getTime();
      const f = a.frame;
      return {
        ...s,
        bpm: f.usable ? f.heartRate : null,
        spo2: f.usable ? f.spo2 : null,
        avgBpm: a.avgBpm,
        avgSpo2: a.avgSpo2,
        finger: f.finger,
        bpmSeries: trim([...s.bpmSeries, { t, v: f.usable ? f.heartRate : null }], t),
        spo2Series: trim([...s.spo2Series, { t, v: f.usable ? f.spo2 : null }], t),
        packets: s.packets + 1,
        lastSeq: f.seq,
        lastRx: a.rx,
        lost: a.lost,
        crcErrors: a.crc,
      };
    }
    case 'stored':
      return { ...s, stored: s.stored + 1 };
    case 'duplicate':
      return { ...s, duplicates: s.duplicates + 1 };
    case 'ignored':
      return { ...s, ignoredNoSession: s.ignoredNoSession + 1 };
    case 'storeError':
      return { ...s, error: a.error };
    case 'rollover':
      return {
        ...s,
        session: a.session,
        stored: 0,
        duplicates: 0,
        rollovers: s.rollovers + 1,
        notice: `Sensor restarted at ${new Date().toLocaleTimeString()} — continued in a new session.`,
      };
    case 'resetSession':
      return { ...s, stored: 0, duplicates: 0, ignoredNoSession: 0 };
    default:
      return s;
  }
}

export function useDriveSession() {
  const [state, dispatch] = useReducer(reducer, initial);

  // Refs: the BLE callback is created once and must see current values.
  const sessionRef = useRef<DriveSession | null>(null);
  const deframer = useRef(new Deframer());
  const seq = useRef(new SeqTracker());
  const avgBpm = useRef<number[]>([]);
  const avgSpo2 = useRef<number[]>([]);
  const seen = useRef<Set<number>>(new Set());
  // Serialises database writes so back-to-back frames cannot interleave.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const onBytes = useCallback((bytes: Uint8Array) => {
    const rx = new Date(); // stamped on arrival, before any queueing
    for (const f of deframer.current.feed(bytes)) {
      const resetsBefore = seq.current.resets;
      const lost = (seq.current.update(f.seq), seq.current.lost);
      // The ESP32's sequence restarts at 0 whenever it reboots -- every
      // ignition cycle in the car. Without handling this, the new numbers
      // collide with ones already stored in this session: the duplicate guard
      // and the UNIQUE(session_id, sequence_number) index would silently
      // discard every frame until the count passed the old maximum.
      const esp32Restarted = seq.current.resets > resetsBefore;
      if (f.usable) {
        avgBpm.current = [...avgBpm.current, f.heartRate].slice(-AVG_WINDOW);
        avgSpo2.current = [...avgSpo2.current, f.spo2].slice(-AVG_WINDOW);
      }
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      dispatch({
        type: 'frame',
        frame: f,
        rx,
        avgBpm: mean(avgBpm.current),
        avgSpo2: mean(avgSpo2.current),
        lost,
        crc: deframer.current.crcErrors,
      });

      queue.current = queue.current
        .then(async () => {
          if (esp32Restarted && sessionRef.current?.status === 'active') {
            // A restart is a new drive segment: close this session and carry on
            // in a fresh one for the same driver, so no data is dropped.
            const old = sessionRef.current;
            await repo.endSession(old);
            const next = await repo.startSession(old.profile_id);
            sessionRef.current = next;
            seen.current.clear();
            dispatch({ type: 'rollover', session: next });
          }
          const session = sessionRef.current;
          if (!session || session.status !== 'active') {
            // Never attribute data to no session or to a previous one.
            dispatch({ type: 'ignored' });
            return;
          }
          if (seen.current.has(f.seq)) {
            dispatch({ type: 'duplicate' });
            return;
          }
          seen.current.add(f.seq);
          try {
            const r = await repo.storeFrame(session.id, f, rx);
            dispatch({ type: r === 'stored' ? 'stored' : 'duplicate' });
          } catch {
            seen.current.delete(f.seq); // let a retry through
            dispatch({ type: 'storeError', error: 'Could not save telemetry locally.' });
          }
        })
        .catch(() => undefined);
    }
  }, []);

  const connection = useMemo(
    () =>
      new WheelConnection({
        onStateChange: (s, error) => {
          if (s === 'connected') {
            // A new link starts a fresh byte stream: no half-frame carries over.
            deframer.current = new Deframer();
          }
          dispatch({ type: 'connection', state: s, error });
        },
        onConnected: (i) => dispatch({ type: 'link', link: { ...i, connectedAt: i.at } }),
        onBytes,
        onRelayStatus: (relay) => dispatch({ type: 'relay', relay }),
      }),
    [onBytes],
  );

  useEffect(() => {
    void repo.recoverInterruptedSessions();
    return () => void connection.stop();
  }, [connection]);

  // In the car nobody should have to tap "connect": as soon as a driver is
  // chosen the app keeps a link to the Pi up, reconnecting on its own.
  const driverId = state.driver?.id;
  useEffect(() => {
    if (driverId) connection.start();
  }, [driverId, connection]);

  const selectDriver = useCallback((driver: DriverProfile) => {
    sessionRef.current = null;
    seen.current.clear();
    avgBpm.current = [];
    avgSpo2.current = [];
    dispatch({ type: 'driver', driver });
  }, []);

  const startSession = useCallback(async () => {
    if (sessionRef.current || !state.driver) return;
    seen.current.clear();
    dispatch({ type: 'resetSession' });
    const session = await repo.startSession(state.driver.id);
    sessionRef.current = session;
    dispatch({ type: 'session', session });
  }, [state.driver]);

  const endSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    const ended = await repo.endSession(session);
    sessionRef.current = null;
    dispatch({ type: 'session', session: ended });
  }, []);

  return {
    ...state,
    isConnected: state.connection === 'connected',
    hasActiveSession: state.session?.status === 'active',
    selectDriver,
    autoConnect: useCallback(() => connection.start(), [connection]),
    stopConnecting: useCallback(() => connection.stop(), [connection]),
    setAllowDirect: useCallback((v: boolean) => connection.setAllowDirect(v), [connection]),
    startSession,
    endSession,
  };
}

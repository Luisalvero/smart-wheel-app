/**
 * Application state for one driver's drive.
 *
 * The only place BLE, the frame decoder, the database, the alert logic and
 * the live uploader meet. Plain useReducer rather than a state library: the
 * reactive surface is a handful of values on a few screens.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import * as Haptics from 'expo-haptics';

import { WheelConnection, type ConnectionState, type RelayStatus, type Source } from '../ble/bleService';
import { Deframer, SeqTracker, uuidv4 } from '../ble/protocol';
import { LiveUploader, type LinkState, type LiveStatus } from '../db/liveSync';
import * as repo from '../db/repositories';
import { syncToSupabase } from '../db/sync';
import type { DriveSession, DriverProfile, StorageMode } from '../db/repositories';
import { foldSession, type ArchiveInfo } from '../archive/archiveStore';
import type { Baseline } from '../analysis/baseline';
import { SafetyController, initialSafety, type DemoScenario, type SafetyState } from '../analysis/safetyController';
import { phoneVoiceIO, prepareVoice, releaseAudio, resetVoiceCache } from '../voice/speechIO';

/** Seconds of vitals kept for the on-screen charts. */
export const CHART_SECONDS = 120;
/** Seconds of throughput history for the data-rate indicator. */
export const RATE_SECONDS = 60;
const AVG_WINDOW = 5;

export type Point = { t: number; v: number | null }; // v null = unusable second
export type LinkInfo = { source: Source; name: string; id: string; connectedAt: Date };
export type RatePoint = { t: number; rx: number; tx: number }; // bytes/s in from the Pi, out to Supabase

export type FoldState =
  | { state: 'idle' }
  | { state: 'folding' }
  | { state: 'done'; info: ArchiveInfo }
  | { state: 'failed'; error: string };

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
  quality: number | null;
  sampleRate: number | null;
  samplesPerPacket: number | null;
  bpmSeries: Point[];
  spo2Series: Point[];
  rateSeries: RatePoint[];
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
  live: LiveStatus | null;
  storageMode: StorageMode;
  baseline: Baseline | null;
  /** Flags, the voice check and the rhythm advisory (lib/analysis/safetyController.ts). */
  safety: SafetyState;
  voice: { granted: boolean; onDevice: boolean } | null;
  fold: FoldState;
};

type Action =
  | { type: 'connection'; state: ConnectionState; error?: string }
  | { type: 'link'; link: LinkInfo }
  | { type: 'relay'; relay: RelayStatus }
  | { type: 'driver'; driver: DriverProfile | null }
  | { type: 'session'; session: DriveSession | null }
  | { type: 'frame'; frame: import('../ble/protocol').Frame; rx: Date; avgBpm: number | null; avgSpo2: number | null; lost: number; crc: number }
  | { type: 'stored' }
  | { type: 'duplicate' }
  | { type: 'ignored' }
  | { type: 'storeError'; error: string }
  | { type: 'rollover'; session: DriveSession }
  | { type: 'resetSession' }
  | { type: 'live'; live: LiveStatus }
  | { type: 'rate'; point: RatePoint }
  | { type: 'storageMode'; mode: StorageMode }
  | { type: 'baseline'; baseline: Baseline | null }
  | { type: 'safety'; safety: SafetyState }
  | { type: 'voice'; voice: State['voice'] }
  | { type: 'fold'; fold: FoldState };

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
  quality: null,
  sampleRate: null,
  samplesPerPacket: null,
  bpmSeries: [],
  spo2Series: [],
  rateSeries: [],
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
  live: null,
  storageMode: 'vitals',
  baseline: null,
  safety: initialSafety,
  voice: null,
  fold: { state: 'idle' },
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
      // Keep the link and preferences; everything about the previous driver goes.
      return {
        ...initial,
        connection: s.connection,
        link: s.link,
        relay: s.relay,
        storageMode: s.storageMode,
        rateSeries: s.rateSeries,
        voice: s.voice,
        driver: a.driver,
      };
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
        quality: f.version >= 3 ? f.quality : null,
        sampleRate: f.rateHz || s.sampleRate,
        samplesPerPacket: f.samples.length,
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
      return { ...s, stored: 0, duplicates: 0, ignoredNoSession: 0, fold: { state: 'idle' } };
    case 'live':
      return { ...s, live: a.live };
    case 'rate':
      return { ...s, rateSeries: [...s.rateSeries, a.point].slice(-RATE_SECONDS) };
    case 'storageMode':
      return { ...s, storageMode: a.mode };
    case 'baseline':
      return { ...s, baseline: a.baseline };
    case 'safety':
      return { ...s, safety: a.safety };
    case 'voice':
      return { ...s, voice: a.voice };
    case 'fold':
      return { ...s, fold: a.fold };
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
  const connected = useRef(false);
  const lastRx = useRef(0);
  const espOnPi = useRef(true);
  const rxBytes = useRef(0);
  // Serialises database writes so back-to-back frames cannot interleave.
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Flags → voice check. Created once; reports its state into the reducer.
  const safety = useMemo(
    () =>
      new SafetyController({
        voiceIO: phoneVoiceIO,
        releaseAudio,
        save: repo.saveAlert,
        saveAck: repo.setAck,
        haptic: (k) =>
          void Haptics.notificationAsync(
            k === 'error' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Warning,
          ),
        onChange: (st) => dispatch({ type: 'safety', safety: st }),
        newId: uuidv4,
      }),
    [],
  );

  // What the dashboard's "link" pill shows, reported with every heartbeat.
  const linkState = useCallback((): LinkState => {
    if (!connected.current) return 'pi_lost';
    if (!espOnPi.current || Date.now() - lastRx.current > 3000) return 'sensor_lost';
    return 'streaming';
  }, []);

  // Streams the active session to Supabase; local storage never waits on it.
  const live = useMemo(() => new LiveUploader(linkState, (l) => dispatch({ type: 'live', live: l })), [linkState]);

  // Throughput for the moving-dot indicator: bytes/s received from the Pi and
  // sent to Supabase, sampled once a second.
  useEffect(() => {
    let lastTx = 0;
    const t = setInterval(() => {
      const tx = live.status.bytesSent;
      dispatch({ type: 'rate', point: { t: Date.now(), rx: rxBytes.current, tx: Math.max(0, tx - lastTx) } });
      rxBytes.current = 0;
      lastTx = tx;
    }, 1000);
    return () => clearInterval(t);
  }, [live]);

  const onBytes = useCallback(
    (bytes: Uint8Array) => {
      const rx = new Date(); // stamped on arrival, before any queueing
      rxBytes.current += bytes.length;
      for (const f of deframer.current.feed(bytes)) {
        lastRx.current = rx.getTime();
        const resetsBefore = seq.current.resets;
        const missingNow = seq.current.update(f.seq); // frames lost just before this one
        const lost = seq.current.lost;
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
        if (sessionRef.current?.status === 'active') {
          safety.onFrame(f, rx, missingNow);
          live.nudge(); // flags and answers reach the dashboard without waiting for the tick
        }

        queue.current = queue.current
          .then(async () => {
            if (esp32Restarted && sessionRef.current?.status === 'active') {
              // A restart is a new drive segment: close this session and carry on
              // in a fresh one for the same driver, so no data is dropped.
              const old = sessionRef.current;
              await repo.endSession(old);
              const next = await repo.startSession(old.profile_id, old.storage_mode ?? 'vitals');
              sessionRef.current = next;
              seen.current.clear();
              dispatch({ type: 'rollover', session: next });
              void (async () => {
                if (old.storage_mode === 'full') await foldSession(old.id, 'smart-wheel-app').catch(() => null);
                await live.finish(old.id);
              })();
              live.follow(next.id);
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
              if (f.rateHz && !session.sample_rate_hz) {
                session.sample_rate_hz = f.rateHz;
                await repo.setSessionSampleRate(session.id, f.rateHz);
              }
              const r = await repo.storeFrame(session.id, f, rx, session.storage_mode === 'full');
              dispatch({ type: r === 'stored' ? 'stored' : 'duplicate' });
            } catch {
              seen.current.delete(f.seq); // let a retry through
              dispatch({ type: 'storeError', error: 'Could not save telemetry locally.' });
            }
          })
          .catch(() => undefined);
      }
    },
    [live, safety],
  );

  const connection = useMemo(
    () =>
      new WheelConnection({
        onStateChange: (s, error) => {
          connected.current = s === 'connected';
          if (s === 'connected') {
            // A new link starts a fresh byte stream: no half-frame carries over.
            deframer.current = new Deframer();
          }
          dispatch({ type: 'connection', state: s, error });
        },
        onConnected: (i) => dispatch({ type: 'link', link: { ...i, connectedAt: i.at } }),
        onBytes,
        onRelayStatus: (relay) => {
          espOnPi.current = relay.esp;
          dispatch({ type: 'relay', relay });
        },
      }),
    [onBytes],
  );

  useEffect(() => {
    void (async () => {
      // Sessions a crash left open: close them locally, then publish that.
      const closed = await repo.recoverInterruptedSessions();
      if (closed) void syncToSupabase().catch(() => undefined);
      dispatch({ type: 'storageMode', mode: await repo.getStorageMode() });
    })();
    return () => {
      void connection.stop();
      live.stop();
    };
  }, [connection, live]);

  // In the car nobody should have to tap "connect": as soon as a driver is
  // chosen the app keeps a link to the Pi up, reconnecting on its own.
  const driverId = state.driver?.id;
  useEffect(() => {
    if (driverId) connection.start();
  }, [driverId, connection]);

  const loadBaseline = useCallback(
    async (driver: DriverProfile) => {
      const b = await repo.driverBaseline(driver.id);
      safety.configure(driver, b, await repo.getAck(driver.id));
      dispatch({ type: 'baseline', baseline: b });
    },
    [safety],
  );

  const selectDriver = useCallback(
    (driver: DriverProfile) => {
      sessionRef.current = null;
      seen.current.clear();
      avgBpm.current = [];
      avgSpo2.current = [];
      dispatch({ type: 'driver', driver });
      void loadBaseline(driver);
    },
    [loadBaseline],
  );

  const startSession = useCallback(async () => {
    if (sessionRef.current || !state.driver) return;
    seen.current.clear();
    dispatch({ type: 'resetSession' });
    const session = await repo.startSession(state.driver.id, state.storageMode);
    sessionRef.current = session;
    safety.startSession(session.id);
    dispatch({ type: 'session', session });
    live.follow(session.id);
    // Microphone + speech permission now, so an emergency is never blocked by a dialog.
    if (!state.voice?.granted) dispatch({ type: 'voice', voice: await prepareVoice() });
  }, [state.driver, state.storageMode, state.voice, live, safety]);

  const endSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    safety.endSession();
    const ended = await repo.endSession(session);
    sessionRef.current = null;
    dispatch({ type: 'session', session: ended });
    await queue.current; // every frame of this session is stored before folding
    if (ended.storage_mode === 'full') {
      dispatch({ type: 'fold', fold: { state: 'folding' } });
      try {
        const info = await foldSession(ended.id, 'smart-wheel-app');
        dispatch({ type: 'fold', fold: info ? { state: 'done', info } : { state: 'idle' } });
      } catch (e) {
        dispatch({ type: 'fold', fold: { state: 'failed', error: e instanceof Error ? e.message : String(e) } });
      }
    }
    await live.finish(ended.id);
    if (state.driver) void loadBaseline(state.driver); // this drive now counts toward the baseline
  }, [live, safety, loadBaseline, state.driver]);

  /** Back to the driver list. An active session is ended first, never dropped. */
  const leaveDriver = useCallback(async () => {
    if (sessionRef.current) await endSession();
    dispatch({ type: 'driver', driver: null });
  }, [endSession]);

  const setStorageMode = useCallback(async (mode: StorageMode) => {
    await repo.setSetting('storage_mode', mode);
    dispatch({ type: 'storageMode', mode });
  }, []);

  /** Settings: hear and answer the real voice check once (nothing recorded). */
  const rehearseVoice = useCallback(async () => {
    if (!state.voice?.granted) dispatch({ type: 'voice', voice: await prepareVoice() });
    resetVoiceCache(); // pick up a voice downloaded since the app started
    return safety.rehearse();
  }, [safety, state.voice]);

  /** On-screen answer to the voice check (always available). */
  const respondAlert = useCallback((response: 'ok' | 'not_ok') => safety.answer(response), [safety]);

  return {
    ...state,
    isConnected: state.connection === 'connected',
    hasActiveSession: state.session?.status === 'active',
    selectDriver,
    leaveDriver,
    autoConnect: useCallback(() => connection.start(), [connection]),
    stopConnecting: useCallback(() => connection.stop(), [connection]),
    setAllowDirect: useCallback((v: boolean) => connection.setAllowDirect(v), [connection]),
    startSession,
    endSession,
    setStorageMode,
    respondAlert,
    rehearseVoice,
    /** Demo: fabricated readings through the real engine + voice check. Nothing saved. */
    simulate: useCallback(
      async (scenario: DemoScenario) => {
        if (!state.voice?.granted) dispatch({ type: 'voice', voice: await prepareVoice() });
        return safety.simulate(scenario);
      },
      [safety, state.voice],
    ),
    resetAck: useCallback(() => safety.resetAck(), [safety]),
  };
}

/**
 * Application state for one driver's drive.
 *
 * This is the only place BLE, the protocol parser and the database meet. It is
 * a plain hook rather than a state-management library: the reactive surface is
 * a handful of counters on one screen, and useReducer covers that without
 * adding a dependency to the team's app.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { WheelConnection, type ConnectionState } from '../ble/bleService';
import { ProtocolError, decodePacket } from '../ble/protocol';
import * as repo from '../db/repositories';
import type { DriveSession, DriverProfile } from '../db/repositories';
import { recoverInterruptedSessions } from '../db/repositories';

type State = {
  connection: ConnectionState;
  error: string | null;
  driver: DriverProfile | null;
  session: DriveSession | null;
  pingCount: number;
  lastSequence: number | null;
  lastReceivedAt: string | null;
  duplicateCount: number;
  rejectedCount: number;
  ignoredNoSessionCount: number;
};

type Action =
  | { type: 'connection'; state: ConnectionState; error?: string }
  | { type: 'driver'; driver: DriverProfile }
  | { type: 'session'; session: DriveSession | null }
  | { type: 'stored'; sequence: number; receivedAt: string }
  | { type: 'duplicate' }
  | { type: 'rejected'; error: string }
  | { type: 'ignored' }
  | { type: 'resetCounters' };

const initialState: State = {
  connection: 'idle',
  error: null,
  driver: null,
  session: null,
  pingCount: 0,
  lastSequence: null,
  lastReceivedAt: null,
  duplicateCount: 0,
  rejectedCount: 0,
  ignoredNoSessionCount: 0,
};

const emptyCounters = {
  pingCount: 0,
  lastSequence: null,
  lastReceivedAt: null,
  duplicateCount: 0,
  rejectedCount: 0,
  ignoredNoSessionCount: 0,
  error: null,
} satisfies Partial<State>;

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.state, error: action.error ?? null };
    case 'driver':
      return { ...state, driver: action.driver, ...emptyCounters };
    case 'session':
      return { ...state, session: action.session };
    case 'stored':
      return {
        ...state,
        pingCount: state.pingCount + 1,
        // Never let the displayed "last ping" go backwards.
        lastSequence:
          state.lastSequence === null || action.sequence > state.lastSequence
            ? action.sequence
            : state.lastSequence,
        lastReceivedAt: action.receivedAt,
        error: null,
      };
    case 'duplicate':
      return { ...state, duplicateCount: state.duplicateCount + 1 };
    case 'rejected':
      return {
        ...state,
        rejectedCount: state.rejectedCount + 1,
        error: action.error,
      };
    case 'ignored':
      return {
        ...state,
        ignoredNoSessionCount: state.ignoredNoSessionCount + 1,
      };
    case 'resetCounters':
      return { ...state, ...emptyCounters };
    default:
      return state;
  }
}

export function useDriveSession() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Refs, not state: the notification callback is created once and must read
  // the *current* session without being re-subscribed on every render.
  const sessionRef = useRef<DriveSession | null>(null);
  const seenSequences = useRef<Set<number>>(new Set());
  // Serialises writes so two notifications arriving back-to-back cannot
  // interleave their inserts.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const handlePayload = useCallback((base64Value: string) => {
    // Stamp at arrival, before queueing, so a backlog cannot distort the
    // recorded reception time.
    const receivedAt = new Date();
    queue.current = queue.current
      .then(async () => {
        let packet;
        try {
          packet = decodePacket(base64Value);
        } catch (err) {
          const message =
            err instanceof ProtocolError ? err.message : String(err);
          dispatch({ type: 'rejected', error: `Malformed packet: ${message}` });
          return;
        }

        const session = sessionRef.current;
        if (!session || session.status !== 'active') {
          // Attributing a packet to no session, or to the previous one, would
          // corrupt the record. Drop it but surface the count so a developer
          // can still see that BLE transport itself is working.
          dispatch({ type: 'ignored' });
          return;
        }

        if (seenSequences.current.has(packet.sequence)) {
          dispatch({ type: 'duplicate' });
          return;
        }
        seenSequences.current.add(packet.sequence);

        try {
          const result = await repo.storePacket(session.id, packet, receivedAt);
          if (result === 'duplicate') {
            dispatch({ type: 'duplicate' });
            return;
          }
        } catch {
          // Roll back the guard so a retry is not misread as a duplicate.
          seenSequences.current.delete(packet.sequence);
          dispatch({
            type: 'rejected',
            error: 'Could not save telemetry locally.',
          });
          return;
        }

        dispatch({
          type: 'stored',
          sequence: packet.sequence,
          receivedAt: receivedAt.toISOString(),
        });
      })
      // A failure must not poison the chain and stall every later packet.
      .catch(() => undefined);
  }, []);

  const connection = useMemo(
    () =>
      new WheelConnection({
        onStateChange: (s, error) => dispatch({ type: 'connection', state: s, error }),
        onPayload: handlePayload,
      }),
    [handlePayload],
  );

  // Close any session the app was killed in the middle of, before anything can
  // attach new telemetry to it.
  useEffect(() => {
    void recoverInterruptedSessions();
    return () => {
      void connection.disconnect();
    };
  }, [connection]);

  const selectDriver = useCallback((driver: DriverProfile) => {
    sessionRef.current = null;
    seenSequences.current.clear();
    dispatch({ type: 'driver', driver });
  }, []);

  const connect = useCallback(() => connection.connect(), [connection]);
  const disconnect = useCallback(() => connection.disconnect(), [connection]);

  const startSession = useCallback(async () => {
    if (sessionRef.current) {
      return; // a session is already running
    }
    const driver = state.driver;
    if (!driver) {
      return;
    }
    seenSequences.current.clear();
    dispatch({ type: 'resetCounters' });
    const session = await repo.startSession(driver.id);
    sessionRef.current = session;
    dispatch({ type: 'session', session });
  }, [state.driver]);

  const endSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    const ended = await repo.endSession(session);
    sessionRef.current = null;
    dispatch({ type: 'session', session: ended });
  }, []);

  return {
    ...state,
    isConnected: state.connection === 'connected',
    hasActiveSession: state.session?.status === 'active',
    selectDriver,
    connect,
    disconnect,
    startSession,
    endSession,
  };
}

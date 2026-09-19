/**
 * Smart Wheel drive screen.
 *
 * Self-contained so it can be mounted without altering the existing Supabase
 * test screen -- see the README in this folder for the one-line change.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  ScrollView,
  Switch,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CHART_SECONDS, useDriveSession, type Point } from '../lib/hooks/useDriveSession';
import * as repo from '../lib/db/repositories';
import type { DriverProfile, Gender } from '../lib/db/repositories';
import { pendingCount, syncToSupabase } from '../lib/db/sync';

const CONNECTION_LABEL: Record<string, string> = {
  idle: 'Disconnected',
  scanning: 'Scanning…',
  connecting: 'Connecting…',
  discovering: 'Discovering services…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  failed: 'Not found',
  waiting: 'Searching…',
};

const fmtTime = (d: Date) =>
  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDuration = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
};

/**
 * One bar per second over the last CHART_SECONDS, drawn with plain Views so no
 * native charting module is needed. A missing bar is a second with no usable
 * reading (no finger, or the estimator rejected a noisy window) -- shown as a
 * gap rather than a misleading zero.
 */
function VitalChart(props: {
  title: string;
  points: Point[];
  color: string;
  min: number;
  max: number;
}) {
  const H = 84;
  const slots: (number | null)[] = new Array(CHART_SECONDS).fill(null);
  const pts = props.points.slice(-CHART_SECONDS);
  pts.forEach((p, i) => {
    slots[CHART_SECONDS - pts.length + i] = p.v;
  });
  const vals = pts.map((p) => p.v).filter((v): v is number => v !== null);
  const range = vals.length ? `${Math.min(...vals)}–${Math.max(...vals)}` : '—';
  return (
    <View style={styles.chart}>
      <View style={styles.chartHead}>
        <Text style={styles.chartTitle}>{props.title}</Text>
        <Text style={styles.chartRange}>last {CHART_SECONDS / 60} min · {range}</Text>
      </View>
      <View style={[styles.chartBody, { height: H }]}>
        {slots.map((v, i) => {
          const f = v === null ? 0 : Math.min(1, Math.max(0, (v - props.min) / (props.max - props.min)));
          return (
            <View
              key={i}
              style={{ flex: 1, height: v === null ? 0 : Math.max(2, f * H), backgroundColor: props.color }}
            />
          );
        })}
      </View>
      <View style={styles.chartAxis}>
        <Text style={styles.axisText}>{props.min}</Text>
        <Text style={styles.axisText}>{props.max}</Text>
      </View>
    </View>
  );
}

export default function SmartWheelScreen() {
  const drive = useDriveSession();
  const [profiles, setProfiles] = useState<DriverProfile[]>([]);
  const [form, setForm] = useState({
    custom_id: '',
    display_name: '',
    weight_kg: '',
    age: '',
    height_cm: '',
  });
  const [gender, setGender] = useState<Gender | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [autoOn, setAutoOn] = useState(true);
  const [direct, setDirect] = useState(false);
  // Re-render once a second so "connected for" and "last packet" stay current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const reload = useCallback(async () => {
    setProfiles(await repo.listProfiles());
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }, []);

  // Blank stays null rather than becoming 0: an unrecorded weight and a weight
  // of zero are different facts, and the dashboard must be able to tell them
  // apart.
  function optionalNumber(raw: string, label: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${label} must be a positive number.`);
    }
    return n;
  }

  async function addProfile() {
    try {
      setFormError(null);
      if (!form.display_name.trim()) {
        setFormError('Name is required.');
        return;
      }
      await repo.createProfile({
        custom_id: form.custom_id,
        display_name: form.display_name,
        weight_kg: optionalNumber(form.weight_kg, 'Weight'),
        age: optionalNumber(form.age, 'Age'),
        height_cm: optionalNumber(form.height_cm, 'Height'),
        gender,
      });
      setForm({ custom_id: '', display_name: '', weight_kg: '', age: '', height_cm: '' });
      setGender(null);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  const field = (
    key: keyof typeof form,
    placeholder: string,
    numeric = false,
  ) => (
    <TextInput
      key={key}
      style={styles.input}
      placeholder={placeholder}
      keyboardType={numeric ? 'decimal-pad' : 'default'}
      value={form[key]}
      onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
    />
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  // --- driver picker -------------------------------------------------------
  if (!drive.driver) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>SELECT DRIVER</Text>
        {profiles.length === 0 && (
          <Text style={styles.muted}>No drivers yet. Create one to begin.</Text>
        )}
        {profiles.map((p) => (
          <View key={p.id} style={styles.row}>
            <Button title={p.display_name} onPress={() => drive.selectDriver(p)} />
            <Text style={styles.uuid}>
              {p.custom_id ? `${p.custom_id} · ` : ''}
              {[
                p.age ? `${p.age}y` : null,
                p.weight_kg ? `${p.weight_kg}kg` : null,
                p.height_cm ? `${p.height_cm}cm` : null,
                p.gender,
              ]
                .filter(Boolean)
                .join(' · ') || p.id}
            </Text>
          </View>
        ))}

        <Text style={styles.sectionTitle}>NEW DRIVER</Text>
        {field('custom_id', 'Custom ID (e.g. SUBJ-001)')}
        {field('display_name', 'Name *')}
        {field('age', 'Age (years)', true)}
        {field('weight_kg', 'Weight (kg)', true)}
        {field('height_cm', 'Height (cm)', true)}

        <Text style={styles.inlineLabel}>Gender</Text>
        <View style={styles.genderRow}>
          {(['male', 'female', 'other', 'prefer_not_to_say'] as Gender[]).map(
            (g) => (
              <View key={g} style={styles.genderBtn}>
                <Button
                  title={g === 'prefer_not_to_say' ? 'n/a' : g}
                  color={gender === g ? '#2563eb' : '#9ca3af'}
                  onPress={() => setGender(gender === g ? null : g)}
                />
              </View>
            ),
          )}
        </View>

        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Button title="+ Create Profile" onPress={addProfile} />
      </ScrollView>
    );
  }

  // --- drive screen --------------------------------------------------------
  const now = Date.now();
  const link = drive.link;
  const viaPi = link?.source === 'relay';
  const lastAge = drive.lastRx ? (now - drive.lastRx.getTime()) / 1000 : null;
  const signal = !drive.lastRx
    ? { text: 'Waiting for data', color: '#6b7280' }
    : !drive.finger
      ? { text: 'No finger on sensor', color: '#b45309' }
      : drive.bpm === null
        ? { text: 'Reading pulse…', color: '#b45309' }
        : { text: 'Good signal', color: '#15803d' };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>SMART WHEEL</Text>
      <Text style={styles.field}>Driver: {drive.driver.display_name}</Text>

      {/* ---- connection ---- */}
      <View style={styles.card}>
        <View style={styles.cardRow}>
          <Text style={[styles.pill, { color: drive.isConnected ? '#15803d' : '#b91c1c' }]}>
            ● {CONNECTION_LABEL[drive.connection] ?? drive.connection}
          </Text>
          {link ? (
            <Text style={[styles.source, { color: viaPi ? '#1d4ed8' : '#b45309' }]}>
              {viaPi ? 'via Raspberry Pi' : 'ESP32 direct (no Pi)'}
            </Text>
          ) : null}
        </View>
        {link ? (
          <>
            <Text style={styles.kv}>Device   {link.name}</Text>
            <Text style={styles.kv}>Connected at   {link.connectedAt.toLocaleString()}</Text>
            <Text style={styles.kv}>Connected for   {fmtDuration(now - link.connectedAt.getTime())}</Text>
            {viaPi ? (
              <Text style={[styles.kv, { color: drive.relay?.esp ? '#15803d' : '#b91c1c' }]}>
                ESP32 → Pi   {drive.relay?.esp
                  ? `up since ${drive.relay.espSince ? fmtTime(new Date(drive.relay.espSince * 1000)) : '?'}`
                  : 'ESP32 not connected to Pi'}
              </Text>
            ) : null}
            <Text style={[styles.kv, { color: lastAge !== null && lastAge < 2.5 ? '#15803d' : '#b91c1c' }]}>
              Last packet   {lastAge === null ? '—' : `${lastAge.toFixed(1)} s ago (#${drive.lastSeq})`}
            </Text>
          </>
        ) : null}
        {drive.error ? <Text style={styles.error}>{drive.error}</Text> : null}
      </View>

      {/* Connection is automatic: the app keeps looking for the Pi and
          reconnects by itself. The button only pauses/resumes that. */}
      <Text style={styles.kv}>
        {autoOn
          ? drive.isConnected
            ? 'Auto-connect on · reconnects by itself if the link drops'
            : 'Auto-connect on · looking for the Raspberry Pi…'
          : 'Auto-connect paused'}
      </Text>
      <Button
        title={autoOn ? 'PAUSE CONNECTION' : 'RESUME AUTO-CONNECT'}
        color={autoOn ? '#6b7280' : undefined}
        onPress={() => {
          if (autoOn) void drive.stopConnecting();
          else drive.autoConnect();
          setAutoOn(!autoOn);
        }}
      />
      {drive.notice ? <Text style={styles.notice}>{drive.notice}</Text> : null}

      {/* ---- vitals ---- */}
      <Text style={[styles.signal, { color: signal.color }]}>{signal.text}</Text>
      <View style={styles.vitalsRow}>
        <View style={styles.vitalBox}>
          <Text style={styles.vitalLabel}>HEART RATE</Text>
          <Text style={[styles.vitalValue, styles.bpm, drive.bpm === null && styles.dim]}>
            {drive.bpm ?? '--'}
          </Text>
          <Text style={styles.vitalUnit}>
            BPM · avg {drive.avgBpm === null ? '--' : drive.avgBpm.toFixed(0)}
          </Text>
        </View>
        <View style={styles.vitalBox}>
          <Text style={styles.vitalLabel}>OXYGEN</Text>
          <Text style={[styles.vitalValue, styles.spo2, drive.spo2 === null && styles.dim]}>
            {drive.spo2 ?? '--'}
          </Text>
          <Text style={styles.vitalUnit}>
            % SpO₂ · avg {drive.avgSpo2 === null ? '--' : drive.avgSpo2.toFixed(0)}
          </Text>
        </View>
      </View>

      <VitalChart title="HEART RATE (BPM)" points={drive.bpmSeries} color="#dc2626" min={40} max={140} />
      <VitalChart title="SpO₂ (%)" points={drive.spo2Series} color="#2563eb" min={85} max={100} />

      {/* ---- session ---- */}
      <Text style={styles.sectionTitle}>SESSION</Text>
      {!drive.hasActiveSession ? (
        <Button
          title="START SESSION"
          disabled={busy || !drive.isConnected}
          onPress={() => guard(drive.startSession)}
        />
      ) : (
        <Button title="END SESSION" color="#b91c1c" disabled={busy} onPress={() => guard(drive.endSession)} />
      )}
      <Text style={styles.kv}>
        {drive.hasActiveSession ? `Recording · ${drive.stored} readings saved` : 'Not recording'}
      </Text>
      {drive.ignoredNoSession > 0 && !drive.hasActiveSession ? (
        <Text style={styles.notice}>
          Data is arriving ({drive.ignoredNoSession} packets) but is not saved until you start a session.
        </Text>
      ) : null}

      <View style={styles.syncBox}>
        <Button
          title={busy ? 'WORKING…' : 'UPLOAD TO SUPABASE'}
          disabled={busy}
          onPress={() =>
            guard(async () => {
              const pending = await pendingCount();
              if (pending.sessions === 0 && pending.events === 0) {
                setSyncStatus('Nothing to upload — end a session first.');
                return;
              }
              setSyncStatus(`Uploading ${pending.events} readings…`);
              const r = await syncToSupabase();
              setSyncStatus(
                r.errors.length
                  ? `Upload failed: ${r.errors[0]}`
                  : `Uploaded ${r.sessions} session(s), ${r.events} readings.`,
              );
            })
          }
        />
        {syncStatus ? <Text style={styles.field}>{syncStatus}</Text> : null}
      </View>

      {/* ---- link health ---- */}
      <View style={styles.debug}>
        <Text style={styles.debugTitle}>LINK HEALTH</Text>
        <View style={styles.cardRow}>
          <Text style={styles.uuid}>
            Direct to ESP32 (bench testing only — never in the car: it locks the Pi out)
          </Text>
          <Switch
            value={direct}
            onValueChange={(v) => {
              setDirect(v);
              drive.setAllowDirect(v);
            }}
          />
        </View>
        {drive.rollovers > 0 ? (
          <Text style={styles.uuid}>sensor restarts this drive: {drive.rollovers} (new session each time)</Text>
        ) : null}
        <Text style={styles.uuid}>
          packets {drive.packets} · lost {drive.lost} · CRC errors {drive.crcErrors} · duplicates {drive.duplicates}
        </Text>
        {viaPi && drive.relay ? (
          <Text style={styles.uuid}>
            Pi: received {drive.relay.rx} from ESP32 · lost {drive.relay.lost} · CRC errors {drive.relay.crc}
          </Text>
        ) : null}
        <Text style={styles.uuid}>Driver {drive.driver.id}</Text>
        <Text style={styles.uuid}>Session {drive.session?.id ?? '--'}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 10, paddingTop: 64 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 8 },
  field: { fontSize: 15 },
  caption: { fontSize: 12, letterSpacing: 2, color: '#666', marginTop: 16 },
  counter: { fontSize: 56, fontWeight: 'bold', color: '#9ca3af' },
  vitalsRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 18 },
  vitalBox: { alignItems: 'center', flex: 1 },
  vitalLabel: { fontSize: 11, letterSpacing: 1.5, color: '#6b7280' },
  vitalValue: { fontSize: 64, fontWeight: 'bold', lineHeight: 70 },
  vitalUnit: { fontSize: 12, color: '#6b7280' },
  bpm: { color: '#dc2626' },
  spo2: { color: '#2563eb' },
  counterActive: { color: '#16a34a' },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginTop: 12,
  },
  row: { marginVertical: 4 },
  sectionTitle: {
    fontSize: 12, letterSpacing: 2, color: '#6b7280', marginTop: 20,
  },
  inlineLabel: { fontSize: 12, color: '#6b7280', marginTop: 6 },
  genderRow: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  genderBtn: { flex: 1, minWidth: 70 },
  syncBox: { marginTop: 20, gap: 6 },
  uuid: { fontSize: 10, color: '#6b7280' },
  muted: { color: '#6b7280' },
  error: { color: '#b91c1c', fontSize: 13 },
  notice: { color: '#92400e', fontSize: 13 },
  debug: { marginTop: 28, borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 12 },
  debugTitle: { fontSize: 11, letterSpacing: 2, color: '#666', marginBottom: 6 },
  card: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 12, gap: 4 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pill: { fontSize: 15, fontWeight: '700' },
  source: { fontSize: 12, fontWeight: '600' },
  kv: { fontSize: 13, color: '#374151', fontVariant: ['tabular-nums'] },
  signal: { fontSize: 15, fontWeight: '700', marginTop: 12, textAlign: 'center' },
  dim: { color: '#d1d5db' },
  chart: { marginTop: 14 },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  chartTitle: { fontSize: 11, letterSpacing: 1.5, color: '#6b7280', fontWeight: '600' },
  chartRange: { fontSize: 11, color: '#6b7280', fontVariant: ['tabular-nums'] },
  chartBody: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 1,
    backgroundColor: '#f9fafb', borderRadius: 6, overflow: 'hidden',
  },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { fontSize: 9, color: '#9ca3af' },
});

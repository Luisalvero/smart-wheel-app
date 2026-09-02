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
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useDriveSession } from '../lib/hooks/useDriveSession';
import * as repo from '../lib/db/repositories';
import type { DriverProfile, Gender } from '../lib/db/repositories';
import {
  SMART_WHEEL_SERVICE_UUID,
  TELEMETRY_CHAR_UUID,
} from '../lib/ble/protocol';
import { pendingCount, syncToSupabase } from '../lib/db/sync';

const CONNECTION_LABEL: Record<string, string> = {
  idle: 'Disconnected',
  scanning: 'Scanning…',
  connecting: 'Connecting…',
  discovering: 'Discovering services…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  failed: 'Error',
};

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
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>SMART WHEEL</Text>

      <Text style={styles.field}>Driver: {drive.driver.display_name}</Text>
      <Text style={styles.field}>
        Bluetooth: {CONNECTION_LABEL[drive.connection] ?? drive.connection}
      </Text>
      {drive.error ? <Text style={styles.error}>{drive.error}</Text> : null}

      <View style={styles.vitalsRow}>
        <View style={styles.vitalBox}>
          <Text style={styles.vitalLabel}>HEART RATE</Text>
          <Text style={[styles.vitalValue, styles.bpm]}>
            {drive.vitals.bpm ?? '--'}
          </Text>
          <Text style={styles.vitalUnit}>BPM</Text>
        </View>
        <View style={styles.vitalBox}>
          <Text style={styles.vitalLabel}>OXYGEN</Text>
          <Text style={[styles.vitalValue, styles.spo2]}>
            {drive.vitals.spo2 ?? '--'}
          </Text>
          <Text style={styles.vitalUnit}>% SpO2</Text>
        </View>
      </View>

      <Text style={styles.field}>
        Signal quality:{' '}
        {drive.vitals.signalQuality === null
          ? '--'
          : `${drive.vitals.signalQuality}%`}
        {'   '}Battery:{' '}
        {drive.vitals.battery === null ? '--' : `${drive.vitals.battery}%`}
      </Text>

      <Text style={styles.caption}>PACKETS RECEIVED</Text>
      <Text
        style={[styles.counter, drive.hasActiveSession && styles.counterActive]}
      >
        {drive.pingCount}
      </Text>

      <Text style={styles.field}>
        Last ping: {drive.lastSequence === null ? '--' : `#${drive.lastSequence}`}
      </Text>
      <Text style={styles.field}>
        Session: {drive.hasActiveSession ? 'Active' : 'Not started'}
      </Text>

      {!drive.isConnected ? (
        <Button
          title={busy ? 'WORKING…' : 'CONNECT TO WHEEL'}
          disabled={busy}
          onPress={() => guard(drive.connect)}
        />
      ) : !drive.hasActiveSession ? (
        <Button
          title="START SESSION"
          disabled={busy}
          onPress={() => guard(drive.startSession)}
        />
      ) : (
        <Button
          title="END SESSION"
          color="#b91c1c"
          disabled={busy}
          onPress={() => guard(drive.endSession)}
        />
      )}

      <View style={styles.syncBox}>
        <Button
          title={busy ? 'SYNCING…' : 'UPLOAD TO SUPABASE'}
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

      {drive.ignoredNoSessionCount > 0 && !drive.hasActiveSession ? (
        <Text style={styles.notice}>
          BLE is working: {drive.ignoredNoSessionCount} ping(s) arrived before a
          session started, so they were not recorded.
        </Text>
      ) : null}

      <View style={styles.debug}>
        <Text style={styles.debugTitle}>DEVELOPER</Text>
        <Text style={styles.uuid}>Service: {SMART_WHEEL_SERVICE_UUID}</Text>
        <Text style={styles.uuid}>Char: {TELEMETRY_CHAR_UUID}</Text>
        <Text style={styles.uuid}>Driver UUID: {drive.driver.id}</Text>
        <Text style={styles.uuid}>Session UUID: {drive.session?.id ?? '--'}</Text>
        <Text style={styles.uuid}>Duplicates dropped: {drive.duplicateCount}</Text>
        <Text style={styles.uuid}>Malformed rejected: {drive.rejectedCount}</Text>
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
});

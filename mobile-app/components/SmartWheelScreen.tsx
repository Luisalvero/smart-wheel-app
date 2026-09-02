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
import type { DriverProfile } from '../lib/db/repositories';
import {
  SMART_WHEEL_SERVICE_UUID,
  TELEMETRY_CHAR_UUID,
} from '../lib/ble/protocol';

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
  const [newName, setNewName] = useState('');
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

  async function addProfile() {
    if (!newName.trim()) return;
    await repo.createProfile(newName);
    setNewName('');
    await reload();
  }

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
            <Text style={styles.uuid}>{p.id}</Text>
          </View>
        ))}
        <TextInput
          style={styles.input}
          placeholder="New driver name"
          value={newName}
          onChangeText={setNewName}
          onSubmitEditing={addProfile}
        />
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

      <Text style={styles.caption}>PINGS RECEIVED</Text>
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
  counter: { fontSize: 72, fontWeight: 'bold', color: '#9ca3af' },
  counterActive: { color: '#16a34a' },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginTop: 12,
  },
  row: { marginVertical: 4 },
  uuid: { fontSize: 10, color: '#6b7280' },
  muted: { color: '#6b7280' },
  error: { color: '#b91c1c', fontSize: 13 },
  notice: { color: '#92400e', fontSize: 13 },
  debug: { marginTop: 28, borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 12 },
  debugTitle: { fontSize: 11, letterSpacing: 2, color: '#666', marginBottom: 6 },
});

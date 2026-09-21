/**
 * Smart Wheel app shell: driver picker, then three tabs (Drive, History,
 * Settings) under a header that always shows who is driving and lets you
 * switch drivers.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { useDriveSession } from '../lib/hooks/useDriveSession';
import * as repo from '../lib/db/repositories';
import type { DriverProfile } from '../lib/db/repositories';
import { C } from './ui';
import { DriverPicker } from './DriverPicker';
import { DriveView, VoiceCheckModal } from './DriveView';
import { HistoryView } from './HistoryView';
import { SettingsView } from './SettingsView';

type Tab = 'drive' | 'history' | 'settings';

export default function SmartWheelScreen() {
  const drive = useDriveSession();
  const [profiles, setProfiles] = useState<DriverProfile[] | null>(null);
  const [tab, setTab] = useState<Tab>('drive');
  const [busy, setBusy] = useState(false);
  const [autoOn, setAutoOn] = useState(true);
  // Re-render once a second so timers and "x s ago" stay current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const reload = useCallback(async () => setProfiles(await repo.listProfiles()), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const guard = useCallback((fn: () => Promise<unknown>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  }, []);

  function switchDriver() {
    if (!drive.hasActiveSession) {
      void drive.leaveDriver();
      return;
    }
    Alert.alert('End this drive?', 'Switching drivers ends and saves the current drive first.', [
      { text: 'Keep driving', style: 'cancel' },
      { text: 'End & switch', style: 'destructive', onPress: () => guard(drive.leaveDriver) },
    ]);
  }

  if (!profiles) {
    return (
      <View style={st.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!drive.driver) {
    return (
      <>
        <StatusBar style="dark" />
        <DriverPicker profiles={profiles} onPick={drive.selectDriver} onCreated={reload} />
      </>
    );
  }

  return (
    <View style={st.root}>
      <StatusBar style="dark" />
      <View style={st.header}>
        <View style={{ flex: 1 }}>
          <Text style={st.brand}>Smart Wheel</Text>
          <Text style={st.driver} numberOfLines={1}>
            {drive.driver.display_name}
            {drive.driver.custom_id ? <Text style={st.cid}>  {drive.driver.custom_id}</Text> : null}
          </Text>
        </View>
        <Pressable onPress={switchDriver} style={st.switch} accessibilityRole="button" accessibilityLabel="Switch driver">
          <Text style={st.switchText}>Switch driver</Text>
        </Pressable>
      </View>

      <View style={{ flex: 1 }}>
        {tab === 'drive' ? <DriveView drive={drive} busy={busy} guard={guard} /> : null}
        {tab === 'history' ? <HistoryView refreshKey={`${drive.session?.id ?? ''}:${drive.session?.status ?? ''}:${drive.fold.state}`} /> : null}
        {tab === 'settings' ? <SettingsView drive={drive} autoOn={autoOn} setAutoOn={setAutoOn} /> : null}
      </View>

      <VoiceCheckModal drive={drive} />

      <View style={st.tabs}>
        {(
          [
            ['drive', 'Drive'],
            ['history', 'History'],
            ['settings', 'Settings'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            style={st.tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
          >
            <View style={[st.tabBar, tab === key && { backgroundColor: C.brand }]} />
            <Text style={[st.tabText, tab === key && { color: C.brand }]}>{label}</Text>
            {key === 'drive' && drive.hasActiveSession ? <View style={st.recDot} /> : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 18,
    paddingBottom: 12,
    backgroundColor: C.card,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  brand: { fontSize: 12, fontWeight: '800', color: C.brand, letterSpacing: 1, textTransform: 'uppercase' },
  driver: { fontSize: 22, fontWeight: '800', color: C.ink },
  cid: { fontSize: 14, fontWeight: '600', color: C.sub },
  switch: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: C.brandSoft },
  switchText: { color: C.brand, fontWeight: '700' },
  tabs: {
    flexDirection: 'row',
    backgroundColor: C.card,
    borderTopWidth: 1,
    borderTopColor: C.line,
    paddingBottom: 28,
  },
  tab: { flex: 1, alignItems: 'center', paddingTop: 0, gap: 8 },
  tabBar: { height: 3, width: '60%', borderRadius: 2, backgroundColor: 'transparent' },
  tabText: { fontSize: 15, fontWeight: '700', color: C.faint },
  recDot: { position: 'absolute', top: 10, right: '28%', width: 8, height: 8, borderRadius: 4, backgroundColor: C.heart },
});

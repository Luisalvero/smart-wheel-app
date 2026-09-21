/**
 * Storage choice, cloud backlog, and the technical link details that used to
 * crowd the drive screen.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { StorageMode } from '../lib/db/repositories';
import { pendingCount, syncToSupabase } from '../lib/db/sync';
import { Btn, C, Card, Row, SectionTitle, fmtClock, fmtDuration } from './ui';

type Drive = ReturnType<typeof useDriveSession>;

const MODES: { key: StorageMode; title: string; body: string }[] = [
  {
    key: 'vitals',
    title: 'Vitals only (recommended)',
    body:
      'Heart rate and oxygen once per second. This is the project proposal\'s data policy: keep processed values, not raw sensor signals.',
  },
  {
    key: 'full',
    title: 'Vitals + full waveform',
    body:
      'Also keeps every raw sensor sample (100 per second) for research. When the drive ends it is folded into a compact, checksummed archive — about 4× smaller, and it unfolds exactly — then backed up to the cloud. Use only with the driver\'s consent.',
  },
];

export function SettingsView(props: { drive: Drive; autoOn: boolean; setAutoOn: (v: boolean) => void }) {
  const d = props.drive;
  const [direct, setDirect] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [syncing, setSyncing] = useState(false);
  const now = Date.now();

  async function uploadBacklog() {
    setSyncing(true);
    try {
      const p = await pendingCount();
      if (p.sessions === 0) {
        setSyncMsg('Everything is already in the cloud.');
        return;
      }
      setSyncMsg(`Uploading ${p.sessions} drive(s)…`);
      const r = await syncToSupabase();
      setSyncMsg(r.errors.length ? `Couldn't reach the cloud: ${r.errors[0]}` : `Uploaded ${r.sessions} drive(s), ${r.events} readings.`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={st.container}>
      <Card>
        <SectionTitle>What to save</SectionTitle>
        {MODES.map((m) => (
          <Pressable
            key={m.key}
            accessibilityRole="radio"
            accessibilityState={{ selected: d.storageMode === m.key, disabled: d.hasActiveSession }}
            disabled={d.hasActiveSession}
            onPress={() => void d.setStorageMode(m.key)}
            style={[st.mode, d.storageMode === m.key && st.modeOn, d.hasActiveSession && { opacity: 0.6 }]}
          >
            <View style={[st.radio, d.storageMode === m.key && st.radioOn]} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={st.modeTitle}>{m.title}</Text>
              <Text style={st.modeBody}>{m.body}</Text>
            </View>
          </Pressable>
        ))}
        {d.hasActiveSession ? <Text style={st.note}>Applies from the next drive.</Text> : null}
      </Card>

      <Card>
        <SectionTitle>Cloud</SectionTitle>
        <Text style={st.note}>
          Drives stream to the dashboard live while you have signal. Anything recorded offline waits on the phone; upload it here.
        </Text>
        {d.live?.legacySchema ? (
          <Text style={[st.note, { color: C.warn }]}>
            The database is missing the v3 update, so some live details (link state, alerts, archives) aren't uploaded yet.
          </Text>
        ) : null}
        <Btn title="Upload waiting drives" kind="ghost" busy={syncing} onPress={uploadBacklog} />
        {syncMsg ? <Text style={st.note}>{syncMsg}</Text> : null}
      </Card>

      <Card>
        <SectionTitle>Connection</SectionTitle>
        <Row label="Auto-connect to the Pi" value={<Switch value={props.autoOn} onValueChange={(v) => {
          if (v) d.autoConnect();
          else void d.stopConnecting();
          props.setAutoOn(v);
        }} />} />
        <Row label="Status" value={d.connection} />
        {d.link ? (
          <>
            <Row label="Device" value={`${d.link.name} (${d.link.source === 'relay' ? 'Pi relay' : 'ESP32 direct'})`} />
            <Row label="Connected at" value={fmtClock(d.link.connectedAt)} />
            <Row label="Connected for" value={fmtDuration(now - d.link.connectedAt.getTime())} />
          </>
        ) : null}
        {d.relay ? (
          <Row
            label="Wheel → Pi"
            value={d.relay.esp ? `up since ${d.relay.espSince ? fmtClock(new Date(d.relay.espSince * 1000)) : '?'}` : 'not connected'}
            tone={d.relay.esp ? 'good' : 'bad'}
          />
        ) : null}
        <Row
          label="Last packet"
          value={d.lastRx ? `${((now - d.lastRx.getTime()) / 1000).toFixed(1)} s ago (#${d.lastSeq})` : '—'}
        />
      </Card>

      <Card>
        <SectionTitle>Link health</SectionTitle>
        <Row label="Packets received" value={String(d.packets)} />
        <Row label="Samples per packet" value={d.samplesPerPacket ? `${d.samplesPerPacket} @ ${d.sampleRate ?? '?'} Hz` : '—'} />
        <Row label="Lost packets" value={String(d.lost)} tone={d.lost ? 'warn' : 'good'} />
        <Row label="CRC errors" value={String(d.crcErrors)} tone={d.crcErrors ? 'bad' : 'good'} />
        <Row label="Duplicates ignored" value={String(d.duplicates)} />
        {d.relay ? <Row label="Pi: from wheel / lost / CRC" value={`${d.relay.rx} / ${d.relay.lost} / ${d.relay.crc}`} /> : null}
        {d.rollovers ? <Row label="Sensor restarts this drive" value={String(d.rollovers)} /> : null}
        <Row label="Rows in cloud (this drive)" value={String(d.live?.pushed ?? 0)} />
        <View style={st.bench}>
          <Text style={[st.note, { flex: 1 }]}>
            Bench testing: connect straight to the ESP32 when no Pi is around. Never in the car — it locks the Pi out.
          </Text>
          <Switch
            value={direct}
            onValueChange={(v) => {
              setDirect(v);
              d.setAllowDirect(v);
            }}
          />
        </View>
        {d.driver ? <Text style={st.id}>driver {d.driver.id}</Text> : null}
        {d.session ? <Text style={st.id}>session {d.session.id}</Text> : null}
      </Card>
      <Text style={st.disclaimer}>Prototype — not a medical device. Alerts use prototype thresholds and escalation is simulated.</Text>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  container: { padding: 16, gap: 14, paddingBottom: 40 },
  mode: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1.5, borderColor: C.line },
  modeOn: { borderColor: C.brand, backgroundColor: '#f0fdfa' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.faint, marginTop: 2 },
  radioOn: { borderColor: C.brand, backgroundColor: C.brand },
  modeTitle: { fontSize: 16, fontWeight: '700', color: C.ink },
  modeBody: { fontSize: 13, color: C.sub, lineHeight: 18 },
  note: { fontSize: 13, color: C.sub, lineHeight: 18 },
  bench: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  id: { fontSize: 10, color: C.faint },
  disclaimer: { fontSize: 12, color: C.faint, textAlign: 'center' },
});

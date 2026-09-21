/**
 * The in-car screen: is everything connected, what are the vitals, is data
 * flowing, and one big start/stop button. Technical detail lives in Settings.
 */
import { Modal, ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';

import type { useDriveSession } from '../lib/hooks/useDriveSession';
import { CHART_SECONDS } from '../lib/hooks/useDriveSession';
import { RESPONSE_S } from '../lib/analysis/alerts';
import { Btn, C, Card, Pill, Row, SectionTitle, fmtBytes, fmtClock, fmtDuration, fmtNum, type Tone } from './ui';
import { RateDot, VitalChart } from './charts';

type Drive = ReturnType<typeof useDriveSession>;

const ALERT_TEXT: Record<string, string> = {
  bpm_high: 'Your heart rate has been higher than usual',
  bpm_low: 'Your heart rate has been lower than usual',
  spo2_low: 'Your oxygen level has been lower than usual',
};

/** Phone → Pi → wheel sensor, each hop with its own state. */
function Chain(props: { drive: Drive }) {
  const d = props.drive;
  const now = Date.now();
  const fresh = d.lastRx !== null && now - d.lastRx.getTime() < 3000;
  const piOk = d.isConnected;
  const espOk = piOk && (d.link?.source === 'esp32' || d.relay?.esp === true);
  const hop = (ok: boolean, label: string, detail: string) => (
    <View style={st.hop}>
      <View style={[st.hopDot, { backgroundColor: ok ? C.good : C.faint }]} />
      <Text style={[st.hopLabel, !ok && { color: C.faint }]}>{label}</Text>
      <Text style={st.hopDetail} numberOfLines={1}>
        {detail}
      </Text>
    </View>
  );
  const searching =
    d.connection === 'scanning' || d.connection === 'connecting' || d.connection === 'discovering' || d.connection === 'waiting';
  return (
    <Card>
      <View style={st.chain}>
        {hop(true, 'Phone', d.live?.ok === false ? 'offline' : 'online')}
        <View style={[st.link, { backgroundColor: piOk ? C.good : C.line }]} />
        {hop(piOk, 'Pi', piOk ? 'connected' : searching ? 'searching…' : 'not found')}
        <View style={[st.link, { backgroundColor: espOk ? C.good : C.line }]} />
        {hop(espOk && fresh, 'Wheel', espOk ? (fresh ? 'streaming' : 'quiet') : 'waiting')}
      </View>
      {d.error && !piOk ? <Text style={st.subtle}>{d.error}</Text> : null}
      {d.notice ? <Text style={[st.subtle, { color: C.warn }]}>{d.notice}</Text> : null}
    </Card>
  );
}

function VitalTile(props: { label: string; value: number | null; unit: string; avg: number | null; color: string; soft: string }) {
  return (
    <View style={[st.tile, { backgroundColor: props.soft }]}>
      <Text style={[st.tileLabel, { color: props.color }]}>{props.label}</Text>
      <Text style={[st.tileValue, { color: props.value === null ? C.faint : props.color }]} accessibilityLiveRegion="polite">
        {props.value ?? '--'}
      </Text>
      <Text style={st.tileUnit}>
        {props.unit} · avg {fmtNum(props.avg)}
      </Text>
    </View>
  );
}

export function DriveView(props: { drive: Drive; busy: boolean; guard: (fn: () => Promise<unknown>) => void }) {
  const d = props.drive;
  const now = Date.now();

  const signal: { tone: Tone; text: string } = !d.lastRx
    ? { tone: 'neutral', text: 'Waiting for the wheel' }
    : now - d.lastRx.getTime() > 3000
      ? { tone: 'warn', text: 'Wheel went quiet' }
      : !d.finger
        ? { tone: 'warn', text: 'Place your hand on the sensor' }
        : d.bpm === null
          ? { tone: 'brand', text: 'Reading your pulse…' }
          : { tone: 'good', text: 'Good signal' };

  const inBand =
    d.band && d.bpm !== null ? (d.bpm < d.band.low ? 'below' : d.bpm > d.band.high ? 'above' : 'in') : null;

  return (
    <ScrollView contentContainerStyle={st.container}>
      <Chain drive={d} />

      <Card>
        <View style={st.between}>
          <Pill tone={signal.tone}>{signal.text}</Pill>
          {d.quality !== null && d.finger ? <Text style={st.subtle}>quality {d.quality}%</Text> : null}
        </View>
        <View style={st.tiles}>
          <VitalTile label="Heart rate" value={d.bpm} unit="BPM" avg={d.avgBpm} color={C.heart} soft={C.heartSoft} />
          <VitalTile label="Oxygen" value={d.spo2} unit="% SpO₂" avg={d.avgSpo2} color={C.oxygen} soft={C.oxygenSoft} />
        </View>
        {d.band ? (
          <Text style={st.subtle}>
            {d.band.personal ? 'Your usual range' : 'Safe range (learning your baseline)'}: {Math.round(d.band.low)}–
            {Math.round(d.band.high)} BPM
            {inBand === 'in' ? ' · within range' : inBand ? ` · ${inBand} range` : ''}
          </Text>
        ) : null}
        <SectionTitle>Heart rate · last {CHART_SECONDS / 60} min</SectionTitle>
        <VitalChart points={d.bpmSeries} seconds={CHART_SECONDS} color={C.heart} min={40} max={160} band={d.band} />
        <SectionTitle>Oxygen · last {CHART_SECONDS / 60} min</SectionTitle>
        <VitalChart points={d.spo2Series} seconds={CHART_SECONDS} color={C.oxygen} min={85} max={100} height={52} />
      </Card>

      <Card>
        <SectionTitle>Drive</SectionTitle>
        {!d.hasActiveSession ? (
          <>
            <Text style={st.body}>
              {d.storageMode === 'full'
                ? 'Saving vitals + full waveform (folded into a compact archive when you finish).'
                : 'Saving vitals only (heart rate and oxygen each second).'}{' '}
              Change this in Settings.
            </Text>
            <Btn
              title={d.isConnected ? 'Start drive' : 'Start drive (waiting for the Pi)'}
              disabled={!d.isConnected}
              busy={props.busy}
              onPress={() => props.guard(d.startSession)}
            />
          </>
        ) : (
          <>
            <Row label="Recording since" value={d.session ? fmtClock(new Date(d.session.started_at)) : '—'} />
            <Row label="Duration" value={d.session ? fmtDuration(now - new Date(d.session.started_at).getTime()) : '—'} />
            <Row label="Readings saved" value={String(d.stored)} />
            <Row
              label="Live on the dashboard"
              value={
                d.live?.ok === false
                  ? 'queued (offline)'
                  : d.live?.lastPushAt
                    ? `${Math.max(0, Math.round((now - d.live.lastPushAt.getTime()) / 1000))} s ago`
                    : 'starting…'
              }
              tone={d.live?.ok === false ? 'warn' : 'good'}
            />
            <Btn title="End drive" kind="danger" busy={props.busy} onPress={() => props.guard(d.endSession)} />
          </>
        )}
        {!d.hasActiveSession && d.fold.state === 'folding' ? <Text style={st.body}>Folding the waveform archive…</Text> : null}
        {!d.hasActiveSession && d.fold.state === 'done' ? (
          <Text style={st.body}>
            Waveform folded: {d.fold.info.sample_count.toLocaleString()} samples → {fmtBytes(d.fold.info.packed_bytes)} (×
            {(d.fold.info.raw_bytes / d.fold.info.packed_bytes).toFixed(1)} smaller, verified).{' '}
            {d.live?.archive === 'uploaded' ? 'Backed up to the cloud.' : d.live?.archive === 'failed' ? 'Cloud backup will retry.' : ''}
          </Text>
        ) : null}
        {d.fold.state === 'failed' ? <Text style={[st.body, { color: C.bad }]}>Archive not created: {d.fold.error}. Raw data kept.</Text> : null}
        {d.lastAlert ? (
          <Text style={[st.body, { color: d.lastAlert.escalated ? C.bad : C.sub }]}>
            Last alert at {fmtClock(d.lastAlert.at)}:{' '}
            {d.lastAlert.response === 'ok'
              ? 'you said you were OK.'
              : d.lastAlert.response === 'unwell'
                ? 'you reported feeling unwell — escalation (simulated).'
                : 'no answer — escalation (simulated).'}
          </Text>
        ) : null}
      </Card>

      <Card>
        <SectionTitle right={d.sampleRate ? <Text style={st.subtle}>{d.samplesPerPacket} samples/packet @ {d.sampleRate} Hz</Text> : null}>
          Data flow
        </SectionTitle>
        <RateDot series={d.rateSeries} />
      </Card>

      <Modal visible={d.alert !== null} transparent animationType="fade">
        <View style={st.scrim}>
          <View style={st.alertBox}>
            <Text style={st.alertTitle}>Are you feeling OK?</Text>
            <Text style={st.alertBody}>
              {d.alert ? ALERT_TEXT[d.alert.kind] : ''} ({d.alert ? Math.round(d.alert.value) : ''}
              {d.alert?.kind === 'spo2_low' ? '%' : ' BPM'}). If you're driving, pull over safely first.
            </Text>
            <Text style={st.alertHint}>
              No answer in {RESPONSE_S} s counts as "not well" (prototype: escalation is simulated, nobody is contacted).
            </Text>
            <Btn title="I'm OK" onPress={() => d.respondAlert('ok')} />
            <Pressable onPress={() => d.respondAlert('unwell')} style={st.unwell} accessibilityRole="button">
              <Text style={st.unwellText}>I don't feel well</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  container: { padding: 16, gap: 14, paddingBottom: 40 },
  chain: { flexDirection: 'row', alignItems: 'center' },
  hop: { alignItems: 'center', width: 78 },
  hopDot: { width: 14, height: 14, borderRadius: 7, marginBottom: 4 },
  hopLabel: { fontSize: 14, fontWeight: '700', color: C.ink },
  hopDetail: { fontSize: 11, color: C.sub },
  link: { flex: 1, height: 3, borderRadius: 2, marginBottom: 30 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, borderRadius: 16, padding: 14, alignItems: 'center' },
  tileLabel: { fontSize: 13, fontWeight: '700' },
  tileValue: { fontSize: 56, fontWeight: '800', lineHeight: 64, fontVariant: ['tabular-nums'] },
  tileUnit: { fontSize: 12, color: C.sub },
  subtle: { fontSize: 12, color: C.sub },
  body: { fontSize: 14, color: C.sub, lineHeight: 20 },
  scrim: { flex: 1, backgroundColor: 'rgba(15,23,42,0.55)', justifyContent: 'center', padding: 24 },
  alertBox: { backgroundColor: '#fff', borderRadius: 24, padding: 22, gap: 12 },
  alertTitle: { fontSize: 24, fontWeight: '800', color: C.ink },
  alertBody: { fontSize: 16, color: C.ink, lineHeight: 22 },
  alertHint: { fontSize: 12, color: C.sub },
  unwell: { paddingVertical: 14, alignItems: 'center', borderRadius: 14, backgroundColor: C.badSoft },
  unwellText: { color: C.bad, fontWeight: '700', fontSize: 16 },
});

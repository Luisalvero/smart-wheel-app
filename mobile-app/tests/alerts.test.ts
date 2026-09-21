import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AlertMonitor, SUSTAIN_S, RESPONSE_S, COOLDOWN_S, LIMITS } from '../lib/analysis/alerts.ts';
import { computeBaseline } from '../lib/analysis/baseline.ts';
import { percentile, robustStats } from '../lib/analysis/stats.ts';

let n = 0;
const id = () => `a${++n}`;
const T0 = 1_000_000;

function run(m: AlertMonitor, from: number, seconds: number, bpm: number | null, spo2: number | null = 97) {
  const events = [];
  for (let s = 0; s < seconds; s += 1) {
    const e = m.feed(T0 + (from + s) * 1000, bpm, spo2);
    if (e) events.push({ at: from + s, ...e });
  }
  return events;
}

test('percentile matches Postgres percentile_cont', () => {
  // Same data as the SQL check: 0..19 cycle + one 190 outlier (see pg test).
  const xs = [...Array.from({ length: 100 }, (_, i) => (i === 5 ? 190 : 60 + (i % 20)))].sort((a, b) => a - b);
  assert.equal(percentile(xs, 0.05), 60.95);
  assert.equal(percentile(xs, 0.5), 70);
  assert.equal(percentile(xs, 0.95), 79);
  const r = robustStats(xs);
  assert.deepEqual([r.min, r.max], [60, 190]); // min/max dragged by one artifact; p95 is not
});

test('no baseline: fixed limits, prompt after sustained breach, "I\'m OK" -> cooldown', () => {
  const m = new AlertMonitor(null, id);
  assert.equal(run(m, 0, 60, 80).length, 0);
  const ev = run(m, 60, 40, 165);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.type, 'prompt');
  // window fills (~6 s of the 10-s window) then must hold for SUSTAIN_S
  assert.ok(ev[0]!.at - 60 >= SUSTAIN_S && ev[0]!.at - 60 <= SUSTAIN_S + 10, `prompt at +${ev[0]!.at - 60}s`);
  const r = m.respond(T0 + 101_000, 'ok');
  assert.equal(r?.type, 'resolved');
  assert.equal(r?.type === 'resolved' && r.escalated, false);
  assert.equal(run(m, 102, COOLDOWN_S - 5, 165).length, 0, 'quiet during cooldown');
});

test('no answer escalates (simulated) after RESPONSE_S', () => {
  const m = new AlertMonitor(null, id);
  const ev = run(m, 0, 60 + RESPONSE_S, null, 85); // SpO2 85% sustained
  assert.equal(ev[0]!.type, 'prompt');
  assert.equal(ev[0]!.type === 'prompt' && ev[0]!.alert.kind, 'spo2_low');
  const last = ev[ev.length - 1]!;
  assert.equal(last.type, 'resolved');
  assert.ok(last.type === 'resolved' && last.response === 'no_response' && last.escalated);
});

test('personal baseline narrows the band; single spikes and dropouts do not alert', () => {
  const bpm = Array.from({ length: 600 }, (_, i) => 62 + (i % 10));
  const b = computeBaseline(bpm, bpm.map(() => 98), 3);
  assert.ok(b.established);
  const m = new AlertMonitor(b, id);
  const band = m.band();
  assert.ok(band.personal && band.high < LIMITS.bpmHigh, JSON.stringify(band));
  // one 180-bpm second every 5 s: the 10-s median never moves
  const events = [];
  for (let s = 0; s < 120; s += 1) {
    const e = m.feed(T0 + s * 1000, s % 5 === 0 ? 180 : 66, 98);
    if (e) events.push(e);
  }
  assert.equal(events.length, 0);
  // mostly no signal: not enough readings in the window to judge
  assert.equal(run(m, 200, 60, null).length, 0);
  // sustained 100 bpm is above this driver's band (p90 71 + 15 = 86)
  assert.equal(run(m, 300, 40, 100)[0]?.type, 'prompt');
});

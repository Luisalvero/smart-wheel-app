import { test } from 'node:test';
import assert from 'node:assert/strict';

import { percentile, robustStats } from '../lib/analysis/stats.ts';
import { computeBaseline } from '../lib/analysis/baseline.ts';

test('percentile matches Postgres percentile_cont (same data as the SQL check)', () => {
  const xs = Array.from({ length: 100 }, (_, i) => (i === 5 ? 190 : 60 + (i % 20))).sort((a, b) => a - b);
  assert.equal(percentile(xs, 0.05), 60.95);
  assert.equal(percentile(xs, 0.5), 70);
  assert.equal(percentile(xs, 0.95), 79);
  const r = robustStats(xs);
  assert.deepEqual([r.min, r.max], [60, 190]); // min/max dragged by one artifact; p95 is not
});

test('baseline is established after 60 readings', () => {
  assert.equal(computeBaseline(new Array(59).fill(70), [], 1).established, false);
  const b = computeBaseline(Array.from({ length: 600 }, (_, i) => 62 + (i % 10)), [], 3);
  assert.ok(b.established);
  [62.9, 66.5, 70.1].forEach((want, i) => assert.ok(Math.abs([b.bpmP10, b.bpmMedian, b.bpmP90][i]! - want) < 1e-9));
});

import { learnBaseline } from '../lib/analysis/baseline.ts';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const drive = (daysAgo: number, bpm: number, n = 600, good: boolean | null = true) =>
  Array.from({ length: n }, (_, i) => ({ t: NOW - daysAgo * DAY + i * 1000, bpm: bpm + (i % 5) - 2, spo2: 97, session: `d${daysAgo}`, good }));

test('learning: a "not OK" episode is never learned as normal', () => {
  const normal = drive(1, 70);
  const episode = Array.from({ length: 120 }, (_, i) => ({ t: NOW - 2 * DAY + i * 1000, bpm: 140, spo2: 90, session: 'bad', good: true }));
  const b = learnBaseline([...normal, ...episode], [{ from: NOW - 2 * DAY + 10_000, to: NOW - 2 * DAY + 60_000 }], NOW);
  assert.ok(Math.abs(b.bpmMedian! - 70) < 1, String(b.bpmMedian));
  assert.equal(b.excluded, 120);
});

test('learning: unreliable seconds are ignored', () => {
  const b = learnBaseline([...drive(1, 70), ...drive(1, 150, 300, false)], [], NOW);
  assert.ok(b.bpmP90! < 80, String(b.bpmP90));
});

test('learning: 28-day window; old drives drop out once there are 10 recent ones', () => {
  const recent = Array.from({ length: 12 }, (_, k) => drive(1 + k, 65, 120)).flat();
  const b = learnBaseline([...drive(120, 85), ...drive(90, 85), ...recent], [], NOW);
  assert.ok(Math.abs(b.bpmMedian! - 65) < 1, String(b.bpmMedian));
  assert.ok(b.windowDays <= 28);
  // With only 2 recent drives, it reaches back to the last 10 (here: all 4).
  const few = learnBaseline([...drive(120, 85), ...drive(90, 85), ...drive(2, 65), ...drive(3, 65)], [], NOW);
  assert.equal(few.sessions, 4);
});

import { computeTrend } from '../lib/analysis/trend.ts';

test('trend: a week running ≥4 bpm above the usual is flagged; ordinary variation is not', () => {
  const past = Array.from({ length: 14 }, (_, k) => ({ start: NOW - (9 + k * 2) * DAY, bpm: 72 + (k % 3) - 1 }));
  const normalWeek = [1, 3, 5].map((d) => ({ start: NOW - d * DAY, bpm: 73 }));
  const highWeek = [1, 3, 5].map((d) => ({ start: NOW - d * DAY, bpm: 79 }));
  assert.equal(computeTrend([...past, ...normalWeek], NOW).status, 'normal');
  const t = computeTrend([...past, ...highWeek], NOW);
  assert.equal(t.status, 'elevated');
  assert.ok('delta' in t && t.delta >= 4);
  assert.equal(computeTrend(highWeek, NOW).status, 'insufficient'); // no baseline yet
});

import { computeCalibration, applyCalibration, accumulate } from '../lib/analysis/calibration.ts';

test('calibration: small HR offsets accepted, large refused, too few clean seconds refused; SpO2 never corrected', () => {
  const wheel = { bpm: new Array(50).fill(70), spo2: new Array(50).fill(95) };
  const ok = computeCalibration(wheel, { bpm: 74, spo2: 97 });
  assert.ok(ok.ok && ok.hr === 4 && ok.spo2 === 2);
  assert.equal(computeCalibration(wheel, { bpm: 90, spo2: null }).ok, false);
  assert.equal(computeCalibration({ bpm: [70, 71], spo2: [] }, { bpm: 72, spo2: null }).ok, false);
  assert.deepEqual(applyCalibration(70, 95, { hr: 4, spo2: 2 }), { bpm: 74, spo2: 95 });
  assert.deepEqual(accumulate({ hr: 4, n: 50 }, { hr: 2, n: 50 }), { hr: 3, n: 100 });
});

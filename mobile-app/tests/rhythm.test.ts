import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RhythmMonitor, detectBeats, segmentMetrics } from '../lib/analysis/rhythm.ts';

const FS = 100;
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

/** Reflectance-PPG-like raw IR (dips at each beat) from a list of intervals. */
function synth(ibisMs: number[], noise = 15) {
  const total = Math.ceil(ibisMs.reduce((a, b) => a + b, 0) / 10) + 200;
  const x = new Array(total).fill(0).map((_, i) => 240000 + 300 * Math.sin((2 * Math.PI * 0.25 * i) / FS)); // breathing drift
  let t = 50;
  const beats: number[] = [];
  for (const ibi of ibisMs) {
    beats.push(Math.round(t));
    for (let k = -30; k < 60; k += 1) {
      const i = Math.round(t) + k;
      if (i < 0 || i >= total) continue;
      const sys = Math.exp(-((k - 8) ** 2) / 40); // systolic upstroke/peak
      const dic = 0.35 * Math.exp(-((k - 32) ** 2) / 60); // dicrotic wave
      x[i] -= 1500 * (sys + dic);
    }
    t += ibi / 10;
  }
  return { x: x.map((v) => Math.round(v + (rnd() - 0.5) * noise)), beats };
}

test('beat detector finds the beats of a clean PPG', () => {
  const ibis = Array.from({ length: 60 }, (_, i) => 800 + 40 * Math.sin(i / 3));
  const { x, beats } = synth(ibis);
  const found = detectBeats(x, FS);
  const matched = beats.filter((b) => found.some((f) => Math.abs(f - b) <= 15)).length;
  assert.ok(matched / beats.length > 0.95, `matched ${matched}/${beats.length}, found ${found.length}`);
  assert.ok(found.length <= beats.length + 2, `extra detections: ${found.length} vs ${beats.length}`);
});

test('metrics: sinus rhythm is regular, AF-like intervals are irregular', () => {
  const sinus = Array.from({ length: 128 }, (_, i) => 850 + 30 * Math.sin((2 * Math.PI * i) / 5) + (rnd() - 0.5) * 10);
  const af = Array.from({ length: 128 }, () => 450 + rnd() * 650);
  const s = segmentMetrics(sinus);
  const a = segmentMetrics(af);
  assert.equal(s.irregular, false, JSON.stringify(s));
  assert.equal(a.irregular, true, JSON.stringify(a));
});

function feed(m: RhythmMonitor, x: number[], okEvery = () => true) {
  const events = [];
  for (let i = 0; i + FS <= x.length; i += FS) events.push(...m.feed(x.slice(i, i + FS), FS, okEvery()));
  return events;
}

test('monitor: 10 minutes of sinus rhythm never advises', () => {
  const ibis = Array.from({ length: 800 }, (_, i) => 780 + 35 * Math.sin((2 * Math.PI * i) / 4.5) + (rnd() - 0.5) * 12);
  const ev = feed(new RhythmMonitor(), synth(ibis).x);
  assert.ok(ev.filter((e) => e.type === 'segment').length >= 5);
  assert.ok(!ev.some((e) => e.type === 'advisory'));
});

test('monitor: sustained irregular rhythm advises after 5 of 6 segments', () => {
  const ibis = Array.from({ length: 900 }, () => 420 + rnd() * 700);
  const ev = feed(new RhythmMonitor(), synth(ibis).x);
  const segs = ev.filter((e) => e.type === 'segment');
  assert.ok(ev.some((e) => e.type === 'advisory'), JSON.stringify(segs.map((s) => s.type === 'segment' && s.metrics.irregular)));
});

test('monitor: poor-signal seconds break the stretch (no analysis of bad data)', () => {
  const ibis = Array.from({ length: 900 }, () => 420 + rnd() * 700);
  let i = 0;
  const ev = feed(new RhythmMonitor(), synth(ibis).x, () => ++i % 15 !== 0); // a bad second every 15 s
  assert.ok(!ev.some((e) => e.type === 'segment'));
});

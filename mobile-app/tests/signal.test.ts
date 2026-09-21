import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SignalAnalyzer, analyseWindow } from '../lib/analysis/signal.ts';

const FS = 100;
let seed = 5;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;

/** Reflectance PPG (dips at each beat) at a given bpm, with noise and optional motion bursts. */
function ppg(seconds: number, bpm: number, opts: { noise?: number; motion?: boolean; dc?: number; amp?: number } = {}) {
  const n = seconds * FS;
  const x = new Array(n).fill(opts.dc ?? 240000);
  const period = (60 / bpm) * FS;
  for (let t = 20; t < n; t += period) {
    for (let k = -30; k < 60; k += 1) {
      const i = Math.round(t) + k;
      if (i < 0 || i >= n) continue;
      x[i] -= (opts.amp ?? 1500) * (Math.exp(-((k - 8) ** 2) / 40) + 0.35 * Math.exp(-((k - 32) ** 2) / 60));
    }
  }
  return x.map((v, i) => v + rnd() * (opts.noise ?? 20) + (opts.motion ? 4000 * Math.sin(i / 7) * (Math.sin(i / 90) > 0.3 ? 1 : 0) : 0));
}

test('clean pulse: beat HR matches, feasible, template-consistent, positively skewed, good', () => {
  const q = analyseWindow(ppg(10, 72), FS, 71);
  assert.ok((q.skewness ?? -1) > 0, `skewness ${q.skewness}`);
  assert.ok(q.hrBeats !== null && Math.abs(q.hrBeats - 72) < 3, String(q.hrBeats));
  assert.ok(q.feasible && q.good, JSON.stringify(q));
  assert.ok((q.templateR ?? 0) > 0.9);
  assert.ok((q.perfusion ?? 0) > 0.2);
});

test('estimators disagree by more than 5 bpm (Gao 2025) → not good', () => {
  const q = analyseWindow(ppg(10, 72), FS, 80); // 8 bpm apart: beyond ±5
  assert.equal(q.agree, false);
  assert.equal(q.good, false);
});

test('motion artifact → not good', () => {
  const q = analyseWindow(ppg(10, 72, { motion: true }), FS, 72);
  assert.equal(q.good, false, JSON.stringify(q));
});

test('weak but clean pulse: labelled (low perfusion) but not vetoed; pure noise is rejected', () => {
  const weak = analyseWindow(ppg(10, 72, { amp: 60, noise: 10 }), FS, 72);
  assert.ok((weak.perfusion ?? 1) < 0.2, String(weak.perfusion));
  const noise = Array.from({ length: 10 * FS }, () => 240000 + rnd() * 400);
  assert.equal(analyseWindow(noise, FS, 72).good, false);
});

test('analyzer needs 10 s of continuous signal and resets on a gap', () => {
  const a = new SignalAnalyzer();
  const x = ppg(14, 80);
  const out = [];
  for (let s = 0; s < 14; s += 1) out.push(a.feed(x.slice(s * FS, (s + 1) * FS), FS, s !== 11, 80));
  assert.equal(out[8]!.good, false); // not enough yet
  assert.equal(out[10]!.good, true);
  assert.equal(out[11]!.good, false); // gap resets
  assert.equal(out[13]!.good, false);
});

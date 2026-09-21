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

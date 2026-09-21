// Run: node --test tests/   (Node >= 22.6 strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { foldArchive, unfoldArchive, unfoldedSize, ArchiveError, type ArchiveFrame } from '../lib/archive/codec.ts';

const z = { deflate: (d: Uint8Array) => new Uint8Array(deflateRawSync(d, { level: 9 })), inflate: (d: Uint8Array) => new Uint8Array(inflateRawSync(d)) };

/** 100 Hz synthetic PPG: DC + pulse at 72 bpm + noise, 18-bit range. */
function synth(seconds: number, rate = 100) {
  const frames: ArchiveFrame[] = [];
  const red: number[] = [];
  const ir: number[] = [];
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5);
  for (let s = 0; s < seconds; s += 1) {
    for (let j = 0; j < rate; j += 1) {
      const t = s + j / rate;
      const pulse = Math.sin(2 * Math.PI * 1.2 * t) + 0.3 * Math.sin(4 * Math.PI * 1.2 * t);
      red.push(Math.round(180000 + 900 * pulse + 40 * rnd()));
      ir.push(Math.round(240000 + 1400 * pulse + 40 * rnd()));
    }
    frames.push({ seq: 1000 + s + (s > 30 ? 3 : 0), espT0Ms: 5000 + s * 1000, receivedAtMs: 1789857000000 + s * 1000 + (s % 7),
      sampleCount: rate, heartRate: s < 8 ? -999 : 72, spo2: s < 8 ? -999 : 98, flags: s < 8 ? 4 : 15, quality: s < 8 ? 0 : 85 });
  }
  return { frames, red, ir };
}

const meta = { sessionId: 'b2c1', profileId: 'p1', startedAt: '2026-09-20T10:00:00Z', endedAt: null, sampleRateHz: 100, createdBy: 'test', driver: 'Joss ñ 🚗' };

test('fold/unfold is lossless', () => {
  const { frames, red, ir } = synth(120);
  const file = foldArchive(meta, frames, red, ir, z);
  const back = unfoldArchive(file, z);
  assert.deepEqual(back.frames, frames);
  assert.deepEqual(back.red, red);
  assert.deepEqual(back.ir, ir);
  assert.equal(back.meta.driver, 'Joss ñ 🚗');
  assert.equal(back.meta.sampleCount, 12000);
  const ratio = unfoldedSize(red.length) / file.length;
  console.log(`  120 s @100 Hz: ${unfoldedSize(red.length)} B -> ${file.length} B (x${ratio.toFixed(1)})`);
  assert.ok(ratio > 3, `ratio ${ratio}`);
});

test('edge cases: empty session, one sample, extreme values', () => {
  const empty = unfoldArchive(foldArchive(meta, [], [], [], z), z);
  assert.equal(empty.frames.length, 0);
  const f: ArchiveFrame = { seq: 0xffffffff, espT0Ms: 0, receivedAtMs: 2 ** 53 - 1, sampleCount: 1, heartRate: -999, spo2: -999, flags: 255, quality: 0 };
  const one = unfoldArchive(foldArchive(meta, [f], [262143], [0], z), z);
  assert.deepEqual(one.frames[0], f);
  assert.deepEqual([one.red, one.ir], [[262143], [0]]);
});

test('rejects corruption and mismatches', () => {
  const { frames, red, ir } = synth(5);
  const file = foldArchive(meta, frames, red, ir, z);
  assert.throws(() => unfoldArchive(file.slice(0, 10), z), ArchiveError);
  const bad = file.slice(); bad[0] = 0x58;
  assert.throws(() => unfoldArchive(bad, z), /not a PPGA/);
  const flipped = file.slice(); flipped[file.length - 5] ^= 0xff;
  assert.throws(() => unfoldArchive(flipped, z));
  assert.throws(() => foldArchive(meta, frames, red.slice(1), ir, z), /mismatch/);
  assert.throws(() => foldArchive(meta, frames, red.map((v, i) => (i === 3 ? 1.5 : v)), ir, z), /non-integer/);
});

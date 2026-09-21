// Decodes frames produced by the ESP32's own encoder (ppg_frame.h, compiled
// with the host g++), so the phone can't drift from the firmware unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Deframer, decodeFrame, v3FrameSize, crc16 } from '../lib/ble/protocol.ts';

const root = join(import.meta.dirname, '..', '..', 'system');
const exe = join(mkdtempSync(join(tmpdir(), 'ppg-')), 'frame_host');
execFileSync('g++', ['-std=c++17', '-O2', join(root, 'tests/test_frame_host.cpp'), '-o', exe]);
const lines = execFileSync(exe, { encoding: 'utf8' }).trim().split('\n');
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const v2 = lines.filter((l) => /^[0-9a-f]+$/.test(l)).map(hex);
const v3 = lines.filter((l) => l.startsWith('V3 ')).map((l) => hex(l.slice(3)));

test('CRC check value', () => assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29b1));

test('v3 frame from the firmware encoder', () => {
  assert.equal(v3.length, 2);
  const f = decodeFrame(v3[0]!);
  assert.equal(v3[0]!.length, 472);
  assert.deepEqual([f.version, f.seq, f.rateHz, f.quality, f.heartRate, f.spo2, f.samples.length], [3, 7, 100, 87, 64, 97, 100]);
  assert.deepEqual([f.startMs, f.endMs], [0xffffff9c, 900]);
  assert.ok(f.usable);
  const red = Array.from({ length: 100 }, (_, i) => (i === 0 ? 0x3ffff : i === 1 ? 0 : ((i % 2 ? 0x2aaaa : 0x15555) ^ (i * 977))));
  const ir = Array.from({ length: 100 }, (_, i) => (200000 + i * 613) & 0x3ffff);
  assert.deepEqual(f.samples.map((s) => s.red), red);
  assert.deepEqual(f.samples.map((s) => s.ir), ir);
  assert.equal(f.samples[99]!.dtMs, 990);
  const g = decodeFrame(v3[1]!);
  assert.deepEqual(g.samples.map((s) => [s.red, s.ir]), [[1, 0x3ffff], [2, 5], [0x3ffff, 6]]);
  assert.equal(g.usable, false);
});

test('v2 frames still decode', () => {
  const a = decodeFrame(v2[0]!);
  assert.deepEqual([a.version, a.seq, a.heartRate, a.samples.length], [2, 42, 72, 8]);
});

test('every single-bit flip in a v3 frame is rejected', () => {
  const good = v3[0]!;
  for (let i = 0; i < good.length; i += 1) {
    for (let b = 0; b < 8; b += 1) {
      const bad = good.slice();
      bad[i]! ^= 1 << b;
      assert.throws(() => decodeFrame(bad));
    }
  }
});

test('mixed v2/v3 stream at BLE-sized chunkings', () => {
  const stream = new Uint8Array([...v2[0]!, ...v3[0]!, ...v3[1]!, ...v2[1]!, ...v3[0]!]);
  for (const size of [1, 20, 182, 244, 509, stream.length]) {
    const d = new Deframer();
    const got = [];
    for (let o = 0; o < stream.length; o += size) got.push(...d.feed(stream.subarray(o, o + size)));
    assert.deepEqual(got.map((f) => f.seq), [42, 7, 8, 0xffffffff, 7], `chunk ${size}`);
    assert.equal(d.crcErrors, 0);
    assert.equal(d.bytesIn, stream.length);
  }
});

test('a plausible false header does not hold back real frames', () => {
  const fake = new Uint8Array([0x5a, 0xa5, 3, 0, ...new Array(8).fill(0), 100, 0, 255]);
  const d = new Deframer();
  const got = d.feed(new Uint8Array([...fake, ...v3[0]!, ...v3[1]!]));
  assert.deepEqual(got.map((f) => f.seq), [7, 8]);
  assert.equal(v3FrameSize(255), 1170);
});

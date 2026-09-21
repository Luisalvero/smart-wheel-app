/**
 * PPGA — the "folded" session archive.
 *
 * A full-waveform drive is ~100 samples/s x 2 channels. Kept as-is that is
 * about 2.9 MB per hour of plain numbers; folded it is a fraction of that, and
 * it unfolds bit-for-bit (lossless) whenever someone needs the waveform again.
 *
 * How it folds (the same idea as FLAC's "fixed" predictors + entropy coding):
 *   1. Each column is predicted from its own previous values with a fixed
 *      polynomial predictor of order 0..3; the order that leaves the smallest
 *      residuals is chosen per column and stored in one byte.
 *   2. Residuals are zigzag-mapped to non-negative integers and written as
 *      LEB128 varints: a smooth PPG waveform leaves small residuals, most of
 *      which fit in one or two bytes instead of four.
 *   3. The whole body is DEFLATE-compressed (LZ77 + Huffman), which squeezes
 *      the remaining redundancy out of the varint stream.
 *
 * File layout (little-endian):
 *   0  4  magic "PPGA"
 *   4  1  format version (1)
 *   5  1  codec (1 = fixed-predictor + zigzag + LEB128, then DEFLATE-raw)
 *   6  2  reserved (0)
 *   8  4  body length before DEFLATE
 *  12  …  DEFLATE-raw(body)
 * Body:
 *   u32 meta length, meta JSON (UTF-8)
 *   frame columns, each frameCount values:  seq, espT0Ms, receivedAtMs,
 *     sampleCount, heartRate, spo2, flags, quality
 *   sample columns, each sampleCount values: red, ir
 *   every column = u8 predictor order, then zigzag-LEB128 residuals.
 *
 * This module is pure: no imports, no platform APIs. DEFLATE is injected so
 * the phone (fflate) and the website (fflate) and the Node tests (zlib) share
 * one implementation. The website keeps a byte-identical copy of this file,
 * checked by mobile-app/tests/shared-sync.test.ts.
 */

export const PPGA_MAGIC = 'PPGA';
export const PPGA_VERSION = 1;
export const PPGA_CODEC_FIXED_PRED = 1;
const HEADER = 12;

export type Deflate = {
  deflate: (data: Uint8Array) => Uint8Array;
  inflate: (data: Uint8Array) => Uint8Array;
};

export type ArchiveMeta = {
  sessionId: string;
  profileId: string;
  startedAt: string; // ISO 8601
  endedAt: string | null;
  sampleRateHz: number;
  createdBy: string;
  /** Free-form extras (driver name, firmware version…). */
  [key: string]: unknown;
};

export type ArchiveFrame = {
  seq: number;
  espT0Ms: number;
  receivedAtMs: number;
  sampleCount: number;
  heartRate: number; // -999 = no result, as on the wire
  spo2: number;
  flags: number;
  quality: number;
};

export type Archive = {
  meta: ArchiveMeta & { frameCount: number; sampleCount: number };
  frames: ArchiveFrame[];
  red: number[];
  ir: number[];
};

export class ArchiveError extends Error {}

// ----------------------------------------------------------- byte writer --
class Writer {
  private buf = new Uint8Array(1 << 16);
  length = 0;

  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  byte(v: number) {
    this.ensure(1);
    this.buf[this.length++] = v;
  }

  u32(v: number) {
    this.ensure(4);
    for (let i = 0; i < 4; i += 1) this.buf[this.length++] = (v >>> (8 * i)) & 0xff;
  }

  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  /** LEB128 for non-negative integers up to 2^53 (arithmetic, not bitwise:
   *  timestamps in ms exceed 32 bits). */
  varint(v: number) {
    this.ensure(8);
    while (v >= 128) {
      this.buf[this.length++] = (v % 128) + 128;
      v = Math.floor(v / 128);
    }
    this.buf[this.length++] = v;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

class Reader {
  pos = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new ArchiveError('truncated');
    return this.buf[this.pos++]!;
  }

  u32(): number {
    let v = 0;
    for (let i = 0; i < 4; i += 1) v += this.byte() * 2 ** (8 * i);
    return v;
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new ArchiveError('truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  varint(): number {
    let v = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      v += (b % 128) * scale;
      if (b < 128) return v;
      scale *= 128;
      if (scale > 2 ** 56) throw new ArchiveError('varint overflow');
    }
  }
}

// ------------------------------------------------------------- predictors --
const zig = (r: number) => (r >= 0 ? 2 * r : -2 * r - 1);
const unzig = (z: number) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

/** Fixed polynomial predictors (as in FLAC). Early samples use the highest
 *  order their history allows. */
function predict(x: ArrayLike<number>, i: number, order: number): number {
  const k = Math.min(order, i);
  switch (k) {
    case 0:
      return 0;
    case 1:
      return x[i - 1]!;
    case 2:
      return 2 * x[i - 1]! - x[i - 2]!;
    default:
      return 3 * x[i - 1]! - 3 * x[i - 2]! + x[i - 3]!;
  }
}

function bestOrder(x: ArrayLike<number>): number {
  let best = 0;
  let bestCost = Infinity;
  for (let order = 0; order <= 3; order += 1) {
    let cost = 0;
    for (let i = 0; i < x.length && cost < bestCost; i += 1) cost += Math.abs(x[i]! - predict(x, i, order));
    if (cost < bestCost) {
      bestCost = cost;
      best = order;
    }
  }
  return best;
}

function writeColumn(w: Writer, x: ArrayLike<number>) {
  const order = bestOrder(x);
  w.byte(order);
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i]!;
    if (!Number.isSafeInteger(v)) throw new ArchiveError(`non-integer value ${v}`);
    w.varint(zig(v - predict(x, i, order)));
  }
}

function readColumn(r: Reader, n: number): number[] {
  const order = r.byte();
  if (order > 3) throw new ArchiveError(`predictor order ${order}`);
  const x: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) x[i] = unzig(r.varint()) + predict(x, i, order);
  return x;
}

// ------------------------------------------------------------------ utf-8 --
function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return Uint8Array.from(out);
}

function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    let cp: number;
    if (c < 0x80) {
      cp = c;
      i += 1;
    } else if (c < 0xe0) {
      cp = ((c & 31) << 6) | (b[i + 1]! & 63);
      i += 2;
    } else if (c < 0xf0) {
      cp = ((c & 15) << 12) | ((b[i + 1]! & 63) << 6) | (b[i + 2]! & 63);
      i += 3;
    } else {
      cp = ((c & 7) << 18) | ((b[i + 1]! & 63) << 12) | ((b[i + 2]! & 63) << 6) | (b[i + 3]! & 63);
      i += 4;
    }
    s += String.fromCodePoint(cp);
  }
  return s;
}

// ------------------------------------------------------------------- API --
const FRAME_FIELDS: (keyof ArchiveFrame)[] = [
  'seq',
  'espT0Ms',
  'receivedAtMs',
  'sampleCount',
  'heartRate',
  'spo2',
  'flags',
  'quality',
];

/** Folds a session. `red`/`ir` hold every sample of every frame, in frame
 *  order; each frame's sampleCount says how many belong to it. */
export function foldArchive(
  meta: ArchiveMeta,
  frames: ArchiveFrame[],
  red: ArrayLike<number>,
  ir: ArrayLike<number>,
  z: Deflate,
): Uint8Array {
  const sampleCount = frames.reduce((a, f) => a + f.sampleCount, 0);
  if (red.length !== sampleCount || ir.length !== sampleCount) {
    throw new ArchiveError(`sample count mismatch: frames say ${sampleCount}, got ${red.length}/${ir.length}`);
  }
  const body = new Writer();
  const metaBytes = utf8Encode(JSON.stringify({ ...meta, frameCount: frames.length, sampleCount }));
  body.u32(metaBytes.length);
  body.bytes(metaBytes);
  for (const field of FRAME_FIELDS) writeColumn(body, frames.map((f) => f[field]));
  writeColumn(body, red);
  writeColumn(body, ir);
  const raw = body.done();

  const packed = z.deflate(raw);
  const out = new Writer();
  for (const ch of PPGA_MAGIC) out.byte(ch.charCodeAt(0));
  out.byte(PPGA_VERSION);
  out.byte(PPGA_CODEC_FIXED_PRED);
  out.byte(0);
  out.byte(0);
  out.u32(raw.length);
  out.bytes(packed);
  return out.done();
}

/** Unfolds an archive produced by foldArchive, verifying its structure. */
export function unfoldArchive(file: Uint8Array, z: Deflate): Archive {
  if (file.length < HEADER) throw new ArchiveError('too short');
  const magic = String.fromCharCode(file[0]!, file[1]!, file[2]!, file[3]!);
  if (magic !== PPGA_MAGIC) throw new ArchiveError('not a PPGA archive');
  if (file[4] !== PPGA_VERSION) throw new ArchiveError(`unsupported version ${file[4]}`);
  if (file[5] !== PPGA_CODEC_FIXED_PRED) throw new ArchiveError(`unsupported codec ${file[5]}`);
  const head = new Reader(file.subarray(8, 12));
  const rawLen = head.u32();
  const raw = z.inflate(file.subarray(HEADER));
  if (raw.length !== rawLen) throw new ArchiveError(`body length ${raw.length}, expected ${rawLen}`);

  const r = new Reader(raw);
  const meta = JSON.parse(utf8Decode(r.bytes(r.u32()))) as Archive['meta'];
  const cols = FRAME_FIELDS.map(() => readColumn(r, meta.frameCount));
  const frames: ArchiveFrame[] = [];
  for (let i = 0; i < meta.frameCount; i += 1) {
    const f = {} as ArchiveFrame;
    FRAME_FIELDS.forEach((field, c) => (f[field] = cols[c]![i]!));
    frames.push(f);
  }
  const red = readColumn(r, meta.sampleCount);
  const ir = readColumn(r, meta.sampleCount);
  if (r.pos !== raw.length) throw new ArchiveError('trailing bytes');
  return { meta, frames, red, ir };
}

/** Bytes the samples would take unfolded (2 channels x u32), for the ratio. */
export function unfoldedSize(sampleCount: number): number {
  return sampleCount * 8;
}

/**
 * PPG telemetry frame protocol v2 -- TypeScript twin of
 * PPG_System/common/ppg_protocol.py and the ESP32's ppg_frame.h.
 *
 * Frame: 104 bytes, little-endian, packed.
 *   0  u16 magic 0xA55A      2 u8 version (2)     3 u8 sample_count
 *   4  u32 seq               8 u32 start_ms      12 u32 end_ms
 *  16  i16 heart_rate       18 i16 spo2          (-999 = no result)
 *  20  u8 flags             21 u8 reserved
 *  22  8 x { u16 dt_ms, u32 red, u32 ir }
 * 102  u16 CRC-16/CCITT-FALSE over bytes 0..101
 *
 * The Pi relay forwards the ESP32's frames byte-for-byte, so the CRC checked
 * here is the one the ESP32 computed: corruption anywhere on the
 * ESP32 -> Pi -> phone path is detected.
 *
 * Transport-free: no react-native-ble-plx, no React, no storage.
 */

// ESP32 (Nordic UART Service UUIDs).
export const ESP32_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const ESP32_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
// Raspberry Pi relay.
export const RELAY_SERVICE_UUID = '5b1e0001-7c2d-4f6a-9e3b-8a4c2d1f6e01';
export const RELAY_FRAME_UUID = '5b1e0002-7c2d-4f6a-9e3b-8a4c2d1f6e01';
export const RELAY_STATUS_UUID = '5b1e0003-7c2d-4f6a-9e3b-8a4c2d1f6e01';
export const RELAY_NAME = 'PPG-Relay-Pi';

export const MAGIC = 0xa55a;
export const VERSION = 2;
export const SAMPLES_PER_FRAME = 8;
export const HEADER_SIZE = 22;
export const SAMPLE_SIZE = 10;
export const FRAME_SIZE = HEADER_SIZE + SAMPLES_PER_FRAME * SAMPLE_SIZE + 2; // 104

export const FLAG_HR_VALID = 0x01;
export const FLAG_SPO2_VALID = 0x02;
export const FLAG_FINGER = 0x04;
export const FLAG_IN_RANGE = 0x08;

export type Sample = { dtMs: number; red: number; ir: number };

export type Frame = {
  seq: number;
  startMs: number;
  endMs: number;
  heartRate: number;
  spo2: number;
  flags: number;
  samples: Sample[];
  finger: boolean;
  /** Both vitals valid, physiologically plausible, finger on the sensor. */
  usable: boolean;
  raw: Uint8Array;
};

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF. Check("123456789") = 0x29B1. */
export function crc16(data: Uint8Array, len = data.length): number {
  let crc = 0xffff;
  for (let i = 0; i < len; i += 1) {
    crc ^= data[i]! << 8;
    for (let b = 0; b < 8; b += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** react-native-ble-plx delivers values as base64; RN has no reliable atob. */
export function base64ToBytes(input: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < chars.length; i += 1) lookup[chars.charCodeAt(i)] = i;
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lookup[clean.charCodeAt(i)]!;
    const b = lookup[clean.charCodeAt(i + 1)]!;
    const c = i + 2 < clean.length ? lookup[clean.charCodeAt(i + 2)]! : -1;
    const d = i + 3 < clean.length ? lookup[clean.charCodeAt(i + 3)]! : -1;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += chars[(n >> 18) & 63]! + chars[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? chars[(n >> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? chars[n & 63]! : '=';
  }
  return out;
}

export class FrameError extends Error {}

/** Decodes and verifies exactly one frame. Throws FrameError on any defect. */
export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length !== FRAME_SIZE) throw new FrameError(`length ${buf.length}`);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint16(0, true) !== MAGIC) throw new FrameError('bad magic');
  if (v.getUint8(2) !== VERSION) throw new FrameError(`version ${v.getUint8(2)}`);
  const sent = v.getUint16(FRAME_SIZE - 2, true);
  if (sent !== crc16(buf, FRAME_SIZE - 2)) throw new FrameError('CRC mismatch');
  const count = v.getUint8(3);
  if (count > SAMPLES_PER_FRAME) throw new FrameError(`sample_count ${count}`);

  const samples: Sample[] = [];
  for (let i = 0; i < count; i += 1) {
    const o = HEADER_SIZE + i * SAMPLE_SIZE;
    samples.push({ dtMs: v.getUint16(o, true), red: v.getUint32(o + 2, true), ir: v.getUint32(o + 6, true) });
  }
  const flags = v.getUint8(20);
  const finger = (flags & FLAG_FINGER) !== 0;
  const usable =
    finger && (flags & FLAG_HR_VALID) !== 0 && (flags & FLAG_SPO2_VALID) !== 0 && (flags & FLAG_IN_RANGE) !== 0;
  return {
    seq: v.getUint32(4, true),
    startMs: v.getUint32(8, true),
    endMs: v.getUint32(12, true),
    heartRate: v.getInt16(16, true),
    spo2: v.getInt16(18, true),
    flags,
    samples,
    finger,
    usable,
    raw: buf.slice(),
  };
}

/**
 * Reassembles frames from an arbitrarily chunked stream. The frame is larger
 * than a default BLE notification, so it may arrive in pieces; after a corrupt
 * candidate the deframer advances one byte and resynchronises on the magic.
 */
export class Deframer {
  private buf = new Uint8Array(0);
  framesOk = 0;
  crcErrors = 0;

  feed(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    let data = merged;
    const out: Frame[] = [];
    for (;;) {
      let idx = -1;
      for (let i = 0; i + 1 < data.length; i += 1) {
        if (data[i] === 0x5a && data[i + 1] === 0xa5) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        data = data.length && data[data.length - 1] === 0x5a ? data.slice(-1) : new Uint8Array(0);
        break;
      }
      data = data.slice(idx);
      if (data.length < FRAME_SIZE) break;
      try {
        out.push(decodeFrame(data.slice(0, FRAME_SIZE)));
        this.framesOk += 1;
        data = data.slice(FRAME_SIZE);
      } catch {
        this.crcErrors += 1;
        data = data.slice(1);
      }
    }
    this.buf = data.length > FRAME_SIZE * 8 ? data.slice(-FRAME_SIZE) : data;
    return out;
  }
}

/** Counts frames lost between received sequence numbers; a drop to a lower
 *  number means the ESP32 rebooted, which is not loss. */
export class SeqTracker {
  last: number | null = null;
  lost = 0;
  resets = 0;

  update(seq: number): number {
    let missing = 0;
    if (this.last !== null) {
      const delta = (seq - this.last) >>> 0;
      if (delta === 0) missing = 0;
      else if (delta < 0x80000000) missing = delta - 1;
      else this.resets += 1;
    }
    this.lost += missing;
    this.last = seq;
    return missing;
  }
}

/**
 * RFC 4122 v4 UUID, generated on the phone so the same primary key can later
 * land in Supabase unchanged.
 */
export function uuidv4(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Smart Wheel BLE telemetry protocol.
 *
 * This is the TypeScript twin of the laptop simulator's `ble_protocol.py`.
 * It owns the *meaning* of the bytes only -- it knows nothing about
 * react-native-ble-plx, SQLite or React. Keeping it transport-free is what
 * lets it be unit tested, and what lets the ESP32 firmware later replace the
 * simulator without a single change here.
 */

/** Shared with the simulator. Changing either constant breaks discovery. */
export const SMART_WHEEL_SERVICE_UUID = '7a1f0001-6e2b-4c91-9d5a-2f3c4b5a6001';
export const TELEMETRY_CHAR_UUID = '7a1f0002-6e2b-4c91-9d5a-2f3c4b5a6001';
export const SIMULATOR_ADVERTISED_NAME = 'SmartWheel-Simulator';

/** Highest protocol version this build understands. */
export const SUPPORTED_PROTOCOL_VERSION = 1;

export const EVENT_PING = 'ping';
export const EVENT_VITALS = 'vitals';

export type TelemetryPacket = {
  protocolVersion: number;
  type: string;
  sequence: number;
  /** Wheel-side send time. Advisory only -- never used as reception time. */
  sentAt: Date | null;
  /** Everything else, so future vitals fields survive without a change here. */
  extra: Record<string, unknown>;
  /** Exact decoded text, kept for debugging bad packets. */
  rawPayload: string;
};

export class ProtocolError extends Error {
  readonly raw?: string;
  constructor(message: string, raw?: string) {
    super(message);
    this.name = 'ProtocolError';
    this.raw = raw;
  }
}

/**
 * Decodes a base64 characteristic value into UTF-8 text.
 *
 * react-native-ble-plx hands notification values back as base64 strings, and
 * React Native has no dependable global `atob`. Implemented here rather than
 * pulling in a dependency, since it is a dozen lines.
 */
export function base64ToUtf8(input: string): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i += 4) {
    const e1 = chars.indexOf(clean[i]!);
    const e2 = chars.indexOf(clean[i + 1]!);
    const e3 = chars.indexOf(clean[i + 2]!);
    const e4 = chars.indexOf(clean[i + 3]!);

    bytes.push((e1 << 2) | (e2 >> 4));
    if (e3 !== -1 && clean[i + 2] !== '=') {
      bytes.push(((e2 & 15) << 4) | (e3 >> 2));
    }
    if (e4 !== -1 && clean[i + 3] !== '=') {
      bytes.push(((e3 & 3) << 6) | e4);
    }
  }

  // Minimal UTF-8 decode. The payload is ASCII JSON in practice, but decoding
  // properly means a stray multi-byte character cannot corrupt the parse.
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i]! & 0x3f));
      } else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[++i]! & 0x3f) << 6) | (bytes[++i]! & 0x3f),
      );
    }
  }
  return out;
}

/**
 * Parses one notification payload.
 *
 * Throws {@link ProtocolError} for anything malformed. Callers are expected to
 * catch it and count the packet as rejected -- one bad packet must never tear
 * down an active drive session.
 */
export function decodePacket(base64Value: string): TelemetryPacket {
  if (!base64Value) {
    throw new ProtocolError('empty notification payload');
  }

  const text = base64ToUtf8(base64Value);
  if (!text) {
    throw new ProtocolError('payload decoded to empty text', base64Value);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolError('payload is not valid JSON', text);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('payload is not a JSON object', text);
  }

  const obj = parsed as Record<string, unknown>;

  const type = obj.type;
  if (typeof type !== 'string' || type.length === 0) {
    throw new ProtocolError('missing or non-string "type"', text);
  }

  const sequence = obj.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence)) {
    throw new ProtocolError('missing or non-integer "sequence"', text);
  }
  if (sequence < 0) {
    throw new ProtocolError(`negative sequence: ${sequence}`, text);
  }

  // An absent version means v1: the field shipped with it, so a payload
  // without it can only have come from a v1 peer.
  const rawVersion = obj.protocol_version;
  const protocolVersion =
    typeof rawVersion === 'number' ? rawVersion : SUPPORTED_PROTOCOL_VERSION;
  if (protocolVersion > SUPPORTED_PROTOCOL_VERSION) {
    throw new ProtocolError(
      `unsupported protocol_version ${protocolVersion} (this build understands ` +
        `up to ${SUPPORTED_PROTOCOL_VERSION})`,
      text,
    );
  }

  // A bad clock on the wheel must not reject an otherwise valid packet.
  let sentAt: Date | null = null;
  if (typeof obj.sent_at === 'string') {
    const parsedDate = new Date(obj.sent_at);
    sentAt = Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  const extra: Record<string, unknown> = { ...obj };
  delete extra.protocol_version;
  delete extra.type;
  delete extra.sequence;
  delete extra.sent_at;

  return { protocolVersion, type, sequence, sentAt, extra, rawPayload: text };
}

/**
 * RFC 4122 v4 UUID.
 *
 * Generated on the phone so the same primary key can later land in Supabase
 * unchanged -- the sync step never has to invent replacement IDs. Uses the
 * platform CSPRNG when one is present and falls back to Math.random, which is
 * adequate for local record identity in a prototype.
 */
export function uuidv4(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;

  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

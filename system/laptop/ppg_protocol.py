"""PPG telemetry frame protocol (v2 + v3) -- shared by the Pi relay and the laptop.

The ESP32 builds one frame per second in esp32/ppg_transmitter/ppg_frame.h.
This module is the Python side of that exact byte layout. Keep the two in
lock-step: tests/test_protocol.py decodes a frame produced by the compiled C++
encoder, so any drift fails the test suite rather than failing silently on the
bench.

Frame layout, little-endian, packed, 104 bytes total:

    off  size  field          type  notes
    0    2     magic          u16   0xA55A  (on the wire: 5A A5)
    2    1     version        u8    2
    3    1     sample_count   u8    0..8 valid entries in samples[]
    4    4     seq            u32   increments by 1 per frame, wraps at 2^32
    8    4     start_ms       u32   ESP32 millis() when the 1 s window opened
    12   4     end_ms         u32   ESP32 millis() when the window closed
    16   2     heart_rate     i16   BPM from the Maxim algorithm (-999 = none)
    18   2     spo2           i16   % from the Maxim algorithm (-999 = none)
    20   1     flags          u8    see FLAG_* below
    21   1     reserved       u8    0
    22   80    samples[8]           each: u16 dt_ms, u32 red, u32 ir
    102  2     crc16          u16   CRC-16/CCITT-FALSE over bytes 0..101

Protocol v3 (what the firmware sends since 2026-09-20) -- every raw sample of
the 1 s window, bit-packed at the sensor's native 18 bits, variable length:

    off  size          field          type  notes
    0    2             magic          u16   0xA55A
    2    1             version        u8    3
    3    1             flags          u8    FLAG_* below
    4    4             seq            u32
    8    4             t0_ms          u32   ESP32 millis() at the first sample
    12   2             rate_hz        u16   sample rate (100)
    14   1             sample_count   u8    n (0..255)
    15   1             quality        u8    0..100 periodicity of the pulse
    16   2             heart_rate     i16   BPM (-999 = none)
    18   2             spo2           i16   % (-999 = none)
    20   ceil(36n/8)   samples              n x {red:18, ir:18}, LSB-first bits
    ..   2             crc16          u16   over everything before it

At 100 Hz that is 472 bytes for 100 samples; v2 carried 8 samples in 104.
Sample i is at t0_ms + i * 1000 / rate_hz on the sensor's clock. Decoders
accept both versions, so old captures still read.

CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
Check value for b"123456789" is 0x29B1. Python's binascii.crc_hqx computes
exactly this when seeded with 0xFFFF, and it is implemented in C, so
verification costs nothing measurable at one frame per second.

Why a stream deframer instead of "one notification == one frame": the frame is
larger than the 20-byte payload of a default BLE link. The ESP32 sends it in
MTU-sized chunks; with the MTU the firmware requests it arrives in one
notification, but correctness never depends on that negotiation succeeding.
"""

from __future__ import annotations

import binascii
import struct
from collections import deque
from dataclasses import dataclass, field

MAGIC = 0xA55A
MAGIC_BYTES = struct.pack("<H", MAGIC)  # b"\x5a\xa5"
VERSION = 2
SAMPLES_PER_FRAME = 8

_HEADER = struct.Struct("<HBBIIIhhBB")        # 22 bytes
_SAMPLE = struct.Struct("<HII")               # 10 bytes
_CRC = struct.Struct("<H")                    # 2 bytes

HEADER_SIZE = _HEADER.size
SAMPLE_SIZE = _SAMPLE.size
FRAME_SIZE = HEADER_SIZE + SAMPLES_PER_FRAME * SAMPLE_SIZE + _CRC.size
assert HEADER_SIZE == 22 and SAMPLE_SIZE == 10 and FRAME_SIZE == 104

VERSION_3 = 3
V3_HEADER = struct.Struct("<HBBIIHBBhh")      # 20 bytes
V3_HEADER_SIZE = V3_HEADER.size
assert V3_HEADER_SIZE == 20
V3_MAX_SAMPLES = 255


def v3_frame_size(n: int) -> int:
    return V3_HEADER_SIZE + (n * 36 + 7) // 8 + 2


V3_MAX_FRAME_SIZE = v3_frame_size(V3_MAX_SAMPLES)   # 1170
MAX_FRAME_SIZE = max(FRAME_SIZE, V3_MAX_FRAME_SIZE)

FLAG_HR_VALID = 0x01      # Maxim algorithm reported a valid heart rate
FLAG_SPO2_VALID = 0x02    # Maxim algorithm reported a valid SpO2
FLAG_FINGER = 0x04        # IR DC level indicates tissue on the sensor
FLAG_IN_RANGE = 0x08      # both values inside physiological limits below

# Physiological plausibility limits; same limits as the original firmware.
BPM_MIN, BPM_MAX = 30, 220
SPO2_MIN, SPO2_MAX = 70, 100

# BLE UUIDs. The ESP32 keeps the Nordic UART Service UUIDs it already used, so
# generic tools (nRF Connect, LightBlue) recognise it. The Pi relay exposes its
# own service to the laptop.
ESP32_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
ESP32_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"      # notify, ESP32 -> Pi
ESP32_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"      # write, reserved

RELAY_SERVICE_UUID = "5b1e0001-7c2d-4f6a-9e3b-8a4c2d1f6e01"
RELAY_FRAME_UUID = "5b1e0002-7c2d-4f6a-9e3b-8a4c2d1f6e01"   # notify: verbatim frames
RELAY_STATUS_UUID = "5b1e0003-7c2d-4f6a-9e3b-8a4c2d1f6e01"  # read/notify: JSON status
RELAY_NAME = "PPG-Relay-Pi"


def crc16(data: bytes | bytearray | memoryview) -> int:
    """CRC-16/CCITT-FALSE."""
    return binascii.crc_hqx(data, 0xFFFF)


@dataclass(frozen=True, slots=True)
class Sample:
    dt_ms: int      # offset from Frame.start_ms
    red: int
    ir: int


@dataclass(frozen=True, slots=True)
class Frame:
    seq: int
    start_ms: int
    end_ms: int
    heart_rate: int
    spo2: int
    flags: int
    samples: tuple[Sample, ...]
    raw: bytes = field(repr=False)
    version: int = VERSION
    rate_hz: int = 0        # v3: samples per second; v2: 0 (times are per-sample)
    quality: int = 0        # v3: 0..100 pulse periodicity; v2: 0

    @property
    def hr_valid(self) -> bool:
        return bool(self.flags & FLAG_HR_VALID)

    @property
    def spo2_valid(self) -> bool:
        return bool(self.flags & FLAG_SPO2_VALID)

    @property
    def finger(self) -> bool:
        return bool(self.flags & FLAG_FINGER)

    @property
    def in_range(self) -> bool:
        return bool(self.flags & FLAG_IN_RANGE)

    @property
    def usable(self) -> bool:
        """True when both vitals are valid and physiologically plausible."""
        return self.hr_valid and self.spo2_valid and self.in_range and self.finger


class FrameError(ValueError):
    pass


def frame_length(buf: bytes | bytearray | memoryview) -> int | None:
    """Total length of the frame starting at buf[0] (which must be the magic),
    or None if more bytes are needed to tell. Raises FrameError for an
    unknown version, so the deframer can skip a false magic."""
    if len(buf) < 3:
        return None
    version = buf[2]
    if version == VERSION:
        return FRAME_SIZE
    if version == VERSION_3:
        if len(buf) < 15:
            return None
        rate = buf[12] | (buf[13] << 8)
        if not 1 <= rate <= 1000:
            raise FrameError(f"implausible rate_hz {rate}")
        return v3_frame_size(buf[14])
    raise FrameError(f"unsupported version {version}")


def decode(buf: bytes | bytearray | memoryview) -> Frame:
    """Decode and verify exactly one frame (v2 or v3). Raises FrameError on
    any defect."""
    if len(buf) >= 3 and buf[2] == VERSION_3:
        return _decode_v3(bytes(buf))
    if len(buf) != FRAME_SIZE:
        raise FrameError(f"length {len(buf)} != {FRAME_SIZE}")
    buf = bytes(buf)
    (magic, version, count, seq, start_ms, end_ms,
     hr, spo2, flags, _reserved) = _HEADER.unpack_from(buf, 0)
    if magic != MAGIC:
        raise FrameError(f"bad magic 0x{magic:04X}")
    if version != VERSION:
        raise FrameError(f"unsupported version {version}")
    (sent_crc,) = _CRC.unpack_from(buf, FRAME_SIZE - 2)
    calc_crc = crc16(buf[:-2])
    if sent_crc != calc_crc:
        raise FrameError(f"CRC mismatch sent=0x{sent_crc:04X} calc=0x{calc_crc:04X}")
    if count > SAMPLES_PER_FRAME:
        raise FrameError(f"sample_count {count} > {SAMPLES_PER_FRAME}")
    samples = tuple(
        Sample(*_SAMPLE.unpack_from(buf, HEADER_SIZE + i * SAMPLE_SIZE))
        for i in range(count)
    )
    return Frame(seq, start_ms, end_ms, hr, spo2, flags, samples, buf)


def _decode_v3(buf: bytes) -> Frame:
    if len(buf) < V3_HEADER_SIZE + 2:
        raise FrameError(f"length {len(buf)} too short for v3")
    (magic, _version, flags, seq, t0_ms, rate_hz, count, quality,
     hr, spo2) = V3_HEADER.unpack_from(buf, 0)
    if magic != MAGIC:
        raise FrameError(f"bad magic 0x{magic:04X}")
    size = v3_frame_size(count)
    if len(buf) != size:
        raise FrameError(f"length {len(buf)} != {size} for {count} samples")
    (sent_crc,) = _CRC.unpack_from(buf, size - 2)
    calc_crc = crc16(buf[:-2])
    if sent_crc != calc_crc:
        raise FrameError(f"CRC mismatch sent=0x{sent_crc:04X} calc=0x{calc_crc:04X}")
    if rate_hz == 0 and count:
        raise FrameError("rate_hz 0")
    bits = int.from_bytes(buf[V3_HEADER_SIZE:size - 2], "little")
    samples = []
    for i in range(count):
        red = (bits >> (36 * i)) & 0x3FFFF
        ir = (bits >> (36 * i + 18)) & 0x3FFFF
        samples.append(Sample(i * 1000 // rate_hz, red, ir))
    end_ms = (t0_ms + (count * 1000) // rate_hz) & 0xFFFFFFFF if rate_hz else t0_ms
    return Frame(seq, t0_ms, end_ms, hr, spo2, flags, tuple(samples), buf,
                 version=VERSION_3, rate_hz=rate_hz, quality=quality)


def encode_v3(seq: int, t0_ms: int, rate_hz: int, heart_rate: int, spo2: int,
              flags: int, quality: int, red: list[int] | tuple[int, ...],
              ir: list[int] | tuple[int, ...]) -> bytes:
    """Python v3 encoder, byte-identical to ppg::encodeV3 (tests check this)."""
    n = len(red)
    if n != len(ir) or n > V3_MAX_SAMPLES:
        raise ValueError("bad sample count")
    header = V3_HEADER.pack(MAGIC, VERSION_3, flags, seq & 0xFFFFFFFF,
                            t0_ms & 0xFFFFFFFF, rate_hz, n, quality, heart_rate, spo2)
    bits = 0
    for i, (r, v) in enumerate(zip(red, ir)):
        bits |= (r & 0x3FFFF) << (36 * i)
        bits |= (v & 0x3FFFF) << (36 * i + 18)
    body = header + bits.to_bytes((n * 36 + 7) // 8, "little")
    return body + _CRC.pack(crc16(body))


def encode(seq: int, start_ms: int, end_ms: int, heart_rate: int, spo2: int,
           flags: int, samples: list[Sample] | tuple[Sample, ...]) -> bytes:
    """Python encoder. Used by tests and the viewer's --demo mode."""
    if len(samples) > SAMPLES_PER_FRAME:
        raise ValueError("too many samples")
    out = bytearray(FRAME_SIZE)
    _HEADER.pack_into(out, 0, MAGIC, VERSION, len(samples), seq & 0xFFFFFFFF,
                      start_ms & 0xFFFFFFFF, end_ms & 0xFFFFFFFF,
                      heart_rate, spo2, flags, 0)
    for i, s in enumerate(samples):
        _SAMPLE.pack_into(out, HEADER_SIZE + i * SAMPLE_SIZE, s.dt_ms, s.red, s.ir)
    _CRC.pack_into(out, FRAME_SIZE - 2, crc16(out[:-2]))
    return bytes(out)


class Deframer:
    """Reassembles frames from an arbitrarily chunked byte stream.

    Resynchronises on corruption: after a bad candidate it advances one byte
    past the false magic and searches again, so a single damaged frame never
    takes down the frames that follow it.
    """

    MAX_BUFFER = MAX_FRAME_SIZE * 4

    def __init__(self) -> None:
        self._buf = bytearray()
        self.frames_ok = 0
        self.crc_errors = 0
        self.bytes_dropped = 0

    def feed(self, chunk: bytes | bytearray) -> list[Frame]:
        self._buf += chunk
        out: list[Frame] = []
        while True:
            idx = self._buf.find(MAGIC_BYTES)
            if idx < 0:
                # Keep a possible trailing half-magic byte.
                keep = 1 if self._buf[-1:] == MAGIC_BYTES[:1] else 0
                self.bytes_dropped += len(self._buf) - keep
                del self._buf[: len(self._buf) - keep]
                break
            if idx:
                self.bytes_dropped += idx
                del self._buf[:idx]
            try:
                size = frame_length(self._buf)
                if size is None or len(self._buf) < size:
                    # Incomplete. If this is a false magic claiming a long
                    # frame, waiting for all of it would hold back the real
                    # frames already buffered behind it -- so if a complete,
                    # valid frame starts later, the candidate was garbage.
                    later = self._valid_frame_after(1)
                    if later is None:
                        break
                    self.crc_errors += 1
                    self.bytes_dropped += later
                    del self._buf[:later]
                    continue
                out.append(decode(self._buf[:size]))
                self.frames_ok += 1
                del self._buf[:size]
            except FrameError:
                self.crc_errors += 1
                self.bytes_dropped += 1
                del self._buf[:1]
        if len(self._buf) > self.MAX_BUFFER:
            self.bytes_dropped += len(self._buf) - MAX_FRAME_SIZE
            del self._buf[:-MAX_FRAME_SIZE]
        return out


    def _valid_frame_after(self, start: int) -> int | None:
        """Offset of the first complete, CRC-valid frame at or after `start`."""
        idx = self._buf.find(MAGIC_BYTES, start)
        while idx >= 0:
            try:
                size = frame_length(self._buf[idx:])
                if size is not None and idx + size <= len(self._buf):
                    decode(self._buf[idx:idx + size])
                    return idx
            except FrameError:
                pass
            idx = self._buf.find(MAGIC_BYTES, idx + 1)
        return None


class SeqTracker:
    """Counts frames lost between two received sequence numbers."""

    def __init__(self) -> None:
        self.last: int | None = None
        self.lost = 0
        self.resets = 0

    def update(self, seq: int) -> int:
        """Returns the number of frames missing before this one."""
        missing = 0
        if self.last is not None:
            delta = (seq - self.last) & 0xFFFFFFFF
            if delta == 0:
                missing = 0                     # duplicate
            elif delta < 0x8000_0000:
                missing = delta - 1
            else:
                self.resets += 1                # went backwards: ESP32 rebooted
        self.lost += missing
        self.last = seq
        return missing


class MovingAverage:
    """N-point moving average fed only with usable readings.

    Mirrors the original firmware's 5-point filter: invalid or implausible
    readings never enter the window, so one bad second cannot drag the average.
    """

    def __init__(self, size: int = 5) -> None:
        self._w: deque[float] = deque(maxlen=size)

    def add(self, value: float) -> float:
        self._w.append(value)
        return self.value  # type: ignore[return-value]

    @property
    def value(self) -> float | None:
        return sum(self._w) / len(self._w) if self._w else None

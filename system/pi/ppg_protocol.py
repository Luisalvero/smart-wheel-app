"""PPG telemetry frame protocol (v2) -- shared by the Pi relay and the laptop.

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


def decode(buf: bytes | bytearray | memoryview) -> Frame:
    """Decode and verify exactly one frame. Raises FrameError on any defect."""
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

    MAX_BUFFER = FRAME_SIZE * 8

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
            if len(self._buf) < FRAME_SIZE:
                break
            try:
                out.append(decode(self._buf[:FRAME_SIZE]))
                self.frames_ok += 1
                del self._buf[:FRAME_SIZE]
            except FrameError:
                self.crc_errors += 1
                self.bytes_dropped += 1
                del self._buf[:1]
        if len(self._buf) > self.MAX_BUFFER:
            self.bytes_dropped += len(self._buf) - FRAME_SIZE
            del self._buf[:-FRAME_SIZE]
        return out


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

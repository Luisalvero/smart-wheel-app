// PPG telemetry frame (protocol v2) -- ESP32 encoder.
//
// Byte layout is defined in common/ppg_protocol.py and PROTOCOL.md. This file
// is pure C++ with no Arduino dependencies, so tests/test_frame_host.cpp
// compiles the identical code on the laptop and the Python decoder checks it.
//
// Fields are written byte-by-byte in little-endian order rather than by
// memcpy'ing a struct: a C struct's padding is compiler-defined, and the
// original firmware's PPGPacket had implicit padding after `version`, after
// `sampleCount`, and at the tail -- so its wire size was not what the source
// suggested.

#pragma once
#include <stdint.h>
#include <stddef.h>

namespace ppg {

constexpr uint16_t kMagic = 0xA55A;
constexpr uint8_t  kVersion = 2;
constexpr uint8_t  kSamplesPerFrame = 8;
constexpr size_t   kHeaderSize = 22;
constexpr size_t   kSampleSize = 10;
constexpr size_t   kFrameSize = kHeaderSize + kSamplesPerFrame * kSampleSize + 2;  // 104
static_assert(kFrameSize == 104, "frame size drifted from protocol v2");

enum Flags : uint8_t {
  kHrValid   = 0x01,
  kSpo2Valid = 0x02,
  kFinger    = 0x04,
  kInRange   = 0x08,
};

struct Sample {
  uint16_t dtMs;   // offset from startMs
  uint32_t red;    // 18-bit ADC count
  uint32_t ir;     // 18-bit ADC count
};

struct Frame {
  uint32_t seq;
  uint32_t startMs;
  uint32_t endMs;
  int16_t  heartRate;
  int16_t  spo2;
  uint8_t  flags;
  uint8_t  sampleCount;
  Sample   samples[kSamplesPerFrame];
};

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
// Bitwise rather than table-driven: 102 bytes once per second is ~1k shifts,
// and it avoids spending 512 bytes of RAM/flash on a table.
inline uint16_t crc16(const uint8_t* data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; ++i) {
    crc ^= static_cast<uint16_t>(data[i]) << 8;
    for (int b = 0; b < 8; ++b) {
      crc = (crc & 0x8000) ? static_cast<uint16_t>((crc << 1) ^ 0x1021)
                           : static_cast<uint16_t>(crc << 1);
    }
  }
  return crc;
}

namespace detail {
inline uint8_t* put16(uint8_t* p, uint16_t v) { p[0] = v; p[1] = v >> 8; return p + 2; }
inline uint8_t* put32(uint8_t* p, uint32_t v) {
  p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; return p + 4;
}
}  // namespace detail

// Serialises `f` into `out` (must hold kFrameSize bytes). Unused sample slots
// are zeroed so the frame is fixed-size and the CRC is deterministic.
inline size_t encode(const Frame& f, uint8_t* out) {
  using namespace detail;
  const uint8_t count = f.sampleCount > kSamplesPerFrame ? kSamplesPerFrame : f.sampleCount;
  uint8_t* p = out;
  p = put16(p, kMagic);
  *p++ = kVersion;
  *p++ = count;
  p = put32(p, f.seq);
  p = put32(p, f.startMs);
  p = put32(p, f.endMs);
  p = put16(p, static_cast<uint16_t>(f.heartRate));
  p = put16(p, static_cast<uint16_t>(f.spo2));
  *p++ = f.flags;
  *p++ = 0;  // reserved
  for (uint8_t i = 0; i < kSamplesPerFrame; ++i) {
    if (i < count) {
      p = put16(p, f.samples[i].dtMs);
      p = put32(p, f.samples[i].red);
      p = put32(p, f.samples[i].ir);
    } else {
      for (size_t k = 0; k < kSampleSize; ++k) *p++ = 0;
    }
  }
  put16(p, crc16(out, kFrameSize - 2));
  return kFrameSize;
}

}  // namespace ppg

// Compiles the ESP32's ppg_frame.h on the host and writes frames to stdout as
// hex, one per line, for tests/test_protocol.py to decode.
#include <cstdio>
#include "../esp32/ppg_transmitter/ppg_frame.h"

static void emit(const ppg::Frame& f) {
  uint8_t buf[ppg::kFrameSize];
  ppg::encode(f, buf);
  for (size_t i = 0; i < ppg::kFrameSize; ++i) std::printf("%02x", buf[i]);
  std::printf("\n");
}

int main() {
  const uint8_t check[] = "123456789";
  std::printf("CRC %04x\n", ppg::crc16(check, 9));

  ppg::Frame f{};
  f.seq = 42; f.startMs = 123456; f.endMs = 124456;
  f.heartRate = 72; f.spo2 = 98;
  f.flags = ppg::kHrValid | ppg::kSpo2Valid | ppg::kFinger | ppg::kInRange;
  f.sampleCount = 8;
  for (int i = 0; i < 8; ++i) f.samples[i] = {uint16_t(i * 125), uint32_t(100000 + i), uint32_t(200000 + i * 7)};
  emit(f);

  ppg::Frame g{};                       // invalid reading, partial samples, wrap edge
  g.seq = 0xFFFFFFFFu; g.startMs = 0xFFFFFF00u; g.endMs = 0x000002E8u;
  g.heartRate = -999; g.spo2 = -999; g.flags = 0; g.sampleCount = 3;
  for (int i = 0; i < 3; ++i) g.samples[i] = {uint16_t(i * 130), 0x3FFFFu, 1u};
  emit(g);

  // Protocol v3: 100 samples at 100 Hz, values chosen to exercise every bit
  // position of the 18-bit packing (0, max, alternating patterns, a ramp).
  static uint32_t red[100], ir[100];
  for (int i = 0; i < 100; ++i) {
    red[i] = (i == 0) ? 0x3FFFFu : (i == 1) ? 0u : (i % 2 ? 0x2AAAAu : 0x15555u) ^ uint32_t(i * 977);
    ir[i] = uint32_t(200000 + i * 613) & 0x3FFFFu;
  }
  ppg::FrameV3 v{};
  v.seq = 7; v.t0Ms = 0xFFFFFF9Cu; v.rateHz = 100; v.sampleCount = 100; v.quality = 87;
  v.heartRate = 64; v.spo2 = 97;
  v.flags = ppg::kHrValid | ppg::kSpo2Valid | ppg::kFinger | ppg::kInRange;
  v.red = red; v.ir = ir;
  uint8_t out[ppg::kV3MaxFrameSize];
  size_t n = ppg::encodeV3(v, out);
  std::printf("V3 ");
  for (size_t i = 0; i < n; ++i) std::printf("%02x", out[i]);
  std::printf("\n");

  ppg::FrameV3 w{};                     // odd sample count: last byte half-used
  static uint32_t r3[3] = {1, 2, 0x3FFFFu}, i3[3] = {0x3FFFFu, 5, 6};
  w.seq = 8; w.t0Ms = 1000; w.rateHz = 100; w.sampleCount = 3; w.heartRate = -999; w.spo2 = -999;
  w.red = r3; w.ir = i3;
  n = ppg::encodeV3(w, out);
  std::printf("V3 ");
  for (size_t i = 0; i < n; ++i) std::printf("%02x", out[i]);
  std::printf("\n");
  return 0;
}

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
  return 0;
}

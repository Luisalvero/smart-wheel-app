// Steering Wheel PPG transmitter -- ESP32 + MAX30102, protocol v3.
//
// Once per second: 100 raw Red/IR samples at 100 Hz -> 25 Hz decimation for
// the vitals estimator, ALL 100 raw samples bit-packed into the frame (18 bits
// each, the sensor's native resolution), CRC-16 appended, frame notified to
// the Raspberry Pi over BLE.
//
// v3 vs v2: v2 kept 8 of the 100 samples (92% of the waveform was discarded)
// in a fixed 104-byte frame. v3 sends every sample in 472 bytes -- 12.5x the
// samples for 4.5x the bytes -- so later algorithms (HRV, morphology, motion
// rejection) get the full 100 Hz signal. Nothing about acquisition changed:
// the sensor was already sampling at 100 Hz with 0 FIFO overflows measured.
//
// Changes from the previous sketch (#include Wire.h.txt), and why:
//  * The packet is actually transmitted. Before, it was built and printed but
//    never sent, and the sequence number never advanced.
//  * Explicit little-endian serialisation (ppg_frame.h) instead of sending a
//    C struct, whose padding made the on-air layout compiler-dependent.
//  * CRC-16/CCITT-FALSE on every frame; the Pi and laptop both verify it.
//  * Frames are chunked to the negotiated MTU. BLECharacteristic::notify()
//    silently truncates to MTU-3 (BLECharacteristic.cpp in core 3.3.12), which
//    on a default link would have cut the packet to 20 bytes.
//  * Sample times come from the sensor's own 100 Hz clock, not millis() at the
//    moment each sample is drained from the FIFO. Samples queue in the FIFO
//    while the algorithm runs and are then read in a burst, so read-time
//    timestamps bunched together and misrepresented the waveform.
//  * No delay() inside BLE callbacks; advertising restarts from loop().
//  * A missing sensor is retried rather than hanging forever, so reseating a
//    loose wire recovers without a reset.
//  * One compact serial line per frame instead of ~30 lines, which blocked
//    loop() on the UART for tens of milliseconds every second.
//  * Samples are read from the sensor FIFO directly (see drainFifo). The
//    SparkFun getRed()/getIR() path used before -- here and in both previous
//    sketches -- ran acquisition 2.5x slower than configured and paired red and
//    IR values from different samples, which corrupts SpO2.

#include <Wire.h>
#include <MAX30105.h>
#include "spo2_algorithm.h"

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#include "ppg_frame.h"
#include "ppg_vitals.h"

// ---------------------------------------------------------------- pins ----
#define SDA_PIN 21
#define SCL_PIN 22

// ---------------------------------------------------------------- BLE -----
// Nordic UART Service UUIDs, unchanged from the previous firmware so existing
// tools and the Pi's scan filter keep working.
#define DEVICE_NAME  "SteeringWheelESP32"
#define SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define RX_UUID      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define TX_UUID      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// Requested ATT MTU. 247 carries a 472-byte v3 frame in two notifications;
// chunking below keeps the link correct whatever the Pi negotiates.
static constexpr uint16_t kRequestedMtu = 247;

// ---------------------------------------------------------- acquisition ---
static constexpr int kRawRateHz = 100;          // MAX30102 sample rate
static constexpr int kDecimation = 4;           // 100 Hz -> 25 Hz for Maxim
static constexpr int kAlgoLen = 100;            // Maxim buffer (4 s at 25 Hz)
static constexpr int kAlgoNewPerSecond = kRawRateHz / kDecimation;  // 25
static constexpr int kRawPerFrame = kRawRateHz; // one frame per second

// IR DC level below which no finger is on the sensor. Measured on this module
// at LED amplitude 0x3C (2026-09-18):
//   finger on           ~242,000
//   object resting on    ~50,400  (flat, no pulse -- must NOT count as a finger)
//   open air              ~1,100
// 100,000 sits roughly midway on a log scale between the last two cases that
// matter. The SparkFun examples' 50,000 gave a false "finger" at ~50,400.
// Re-measure if the LED current, enclosure or sensor module changes.
static constexpr uint32_t kFingerIrThreshold = 100000;

// Plausibility limits, same as the previous firmware.
static constexpr int32_t kBpmMin = 30, kBpmMax = 220;
static constexpr int32_t kSpo2Min = 70, kSpo2Max = 100;

// ---------------------------------------------------------------- state ---
MAX30105 sensor;

uint32_t irBuffer[kAlgoLen];
uint32_t redBuffer[kAlgoLen];
int32_t spo2 = -999, heartRate = -999;
int8_t validSpo2 = 0, validHeartRate = 0;

BLEServer* server = nullptr;
BLECharacteristic* txChar = nullptr;
volatile bool clientConnected = false;
volatile bool restartAdvertising = false;

// 8 s of 25 Hz history for ppg::estimate (the Maxim buffer above is only 4 s).
static constexpr int kHistLen = 200;
static constexpr float kAlgoFs = 25.0f;
float histRed[kHistLen], histIr[kHistLen], scratchRed[kHistLen], scratchIr[kHistLen];
int histFilled = 0;

// Appends one 25 Hz sample, dropping the oldest once the window is full.
static void pushHistory(uint32_t red, uint32_t ir) {
  if (histFilled == kHistLen) {
    memmove(histRed, histRed + 1, (kHistLen - 1) * sizeof(float));
    memmove(histIr, histIr + 1, (kHistLen - 1) * sizeof(float));
    histFilled = kHistLen - 1;
  }
  histRed[histFilled] = static_cast<float>(red);
  histIr[histFilled] = static_cast<float>(ir);
  ++histFilled;
}

uint32_t frameSeq = 0;
uint8_t frameBytes[ppg::v3FrameSize(kRawPerFrame)];
uint32_t frameRed[kRawPerFrame], frameIr[kRawPerFrame];  // every raw sample of the window
static_assert(kRawPerFrame <= ppg::kV3MaxSamples, "a v3 frame holds at most 255 samples");

// ------------------------------------------------------------ callbacks ---
// Only flags are set here: these run in the BLE stack's task, and blocking in
// them (the old code called delay(500)) stalls the stack.
// Connection parameters requested from every central right after it connects.
// The ESP32 core requests none itself (BLEServer.cpp, ESP_GATTS_CONNECT_EVT),
// so the link ran on the central's defaults. With BlueZ that meant a short
// supervision timeout, and on hardware we measured repeated drops ~2-3 s into
// a connection with BlueZ reporting org.bluez.Reason.Timeout. A 4 s timeout
// rides out brief radio contention (e.g. a combo Wi-Fi/BT chip).
// The ESP32's only central is the Pi (BlueZ), so Apple's accessory rules do not
// bind this link. (For reference, Apple's Accessory Design Guidelines R30
// §58.6 want supervision timeout 6-18 s and intervals in multiples of 15 ms;
// the phone<->Pi link is the one iOS negotiates.)
// Units per the BLE spec: interval 1.25 ms, timeout 10 ms.
static constexpr uint16_t kConnIntervalMin = 24;     // 30 ms
static constexpr uint16_t kConnIntervalMax = 40;     // 50 ms
static constexpr uint16_t kConnLatency = 0;
static constexpr uint16_t kSupervisionTimeout = 400; // 4 s

// What the central actually accepted, reported from loop() (never print from a
// BLE callback).
volatile bool connParamsChanged = false;
volatile uint16_t connIntervalUnits = 0, connLatency = 0, connTimeoutUnits = 0;
volatile int connParamsStatus = -1;

// Link diagnostics, printed on every serial line: how many times a central
// connected, and why the last link ended (esp_gatt_conn_reason_t = HCI reason:
// 0x08 supervision timeout, 0x13 central closed it, 0x3E never established).
volatile uint32_t connectCount = 0;
volatile uint16_t lastDisconnectReason = 0;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    clientConnected = true;
    ++connectCount;
  }
#if defined(CONFIG_BLUEDROID_ENABLED)
  void onConnect(BLEServer* s, esp_ble_gatts_cb_param_t* param) override {
    // Queues a connection-parameter request; does not block. A false return
    // means the request was not queued, reported as status=-2 on serial.
    if (!s->requestConnParams(param->connect.remote_bda, kConnIntervalMin, kConnIntervalMax,
                              kConnLatency, kSupervisionTimeout)) {
      connParamsStatus = -2;
      connParamsChanged = true;
    }
  }
  void onDisconnect(BLEServer*, esp_ble_gatts_cb_param_t* param) override {
    lastDisconnectReason = static_cast<uint16_t>(param->disconnect.reason);
  }
  void onConnParamsUpdate(esp_bd_addr_t, uint16_t interval, uint16_t latency,
                          uint16_t timeout, esp_bt_status_t status) override {
    connIntervalUnits = interval;
    connLatency = latency;
    connTimeoutUnits = timeout;
    connParamsStatus = status;
    connParamsChanged = true;
  }
#endif
  void onDisconnect(BLEServer*) override {
    clientConnected = false;
    restartAdvertising = true;
  }
};

// ------------------------------------------------------------- helpers ----
// ---------------------------------------------------- direct FIFO reader ---
// Reads the MAX30102's own 32-sample FIFO instead of going through SparkFun's
// getRed()/getIR(). Measured on this hardware, those calls broke the data:
//  * each one calls safeCheck(), which BLOCKS until a NEW sample arrives and
//    then returns the newest sample (sense.head), not the queued one. One
//    "read" therefore spanned ~2.5 sample periods: 100 samples took 2,507 ms
//    instead of 1,000, and the 25 Hz algorithm was really fed ~10 Hz data.
//  * red came from sample N+1 and IR from sample N+2, so the red/IR ratio that
//    SpO2 is computed from compared two different instants.
//  * the library's ring buffer is only 4 deep (STORAGE_SIZE), so a backlog of
//    more than 4 samples is silently overwritten.
// Register addresses are from the SparkFun driver's map, cross-checked on this
// sensor (PART_ID read 0x15 at 0x57).
static constexpr uint8_t kSensorAddr = 0x57;
static constexpr uint8_t kRegFifoWrPtr = 0x04;
static constexpr uint8_t kRegFifoOvf = 0x05;
static constexpr uint8_t kRegFifoRdPtr = 0x06;
static constexpr uint8_t kRegFifoData = 0x07;
static constexpr uint8_t kFifoDepth = 32;
static constexpr uint8_t kBytesPerSample = 6;        // SpO2 mode: 3 B red + 3 B IR
static constexpr uint8_t kMaxSamplesPerRequest = 21; // 21 x 6 = 126 B < Wire's 128 B buffer

static uint32_t fifoRed[kFifoDepth], fifoIr[kFifoDepth];
static uint8_t fifoCount = 0, fifoPos = 0;

// Pulls every sample currently in the sensor FIFO into fifoRed/fifoIr.
// Reading FIFO_DATA advances the sensor's read pointer, as the driver relies on.
static uint8_t drainFifo() {
  const uint8_t wr = sensor.readRegister8(kSensorAddr, kRegFifoWrPtr) & 0x1F;
  const uint8_t rd = sensor.readRegister8(kSensorAddr, kRegFifoRdPtr) & 0x1F;
  uint8_t pending = (wr - rd) & 0x1F;
  fifoCount = 0;
  fifoPos = 0;
  while (pending > 0) {
    const uint8_t batch = pending > kMaxSamplesPerRequest ? kMaxSamplesPerRequest : pending;
    Wire.beginTransmission(kSensorAddr);
    Wire.write(kRegFifoData);
    if (Wire.endTransmission() != 0) break;
    const size_t want = static_cast<size_t>(batch) * kBytesPerSample;
    if (Wire.requestFrom(static_cast<uint16_t>(kSensorAddr), want) != want) break;
    for (uint8_t i = 0; i < batch; ++i) {
      uint32_t r = static_cast<uint32_t>(Wire.read()) << 16;
      r |= static_cast<uint32_t>(Wire.read()) << 8;
      r |= static_cast<uint32_t>(Wire.read());
      uint32_t v = static_cast<uint32_t>(Wire.read()) << 16;
      v |= static_cast<uint32_t>(Wire.read()) << 8;
      v |= static_cast<uint32_t>(Wire.read());
      fifoRed[fifoCount] = r & 0x3FFFF;   // 18-bit ADC
      fifoIr[fifoCount] = v & 0x3FFFF;
      ++fifoCount;
    }
    pending -= batch;
  }
  return fifoCount;
}

// Returns the next sample in order. Red and IR always come from the same
// sensor sample, and every sample the sensor produces is delivered once.
static void readRawSample(uint32_t& red, uint32_t& ir) {
  while (fifoPos >= fifoCount) {
    // One sample arrives every 10 ms; yield (delay, not busy-wait) so the BLE
    // stack keeps running while we wait.
    if (drainFifo() == 0) delay(1);
  }
  red = fifoRed[fifoPos];
  ir = fifoIr[fifoPos];
  ++fifoPos;
}

// Averages kDecimation raw samples into one 25 Hz algorithm sample.
static void readAlgoSample(uint32_t& red, uint32_t& ir) {
  uint64_t rs = 0, is = 0;
  for (int k = 0; k < kDecimation; ++k) {
    uint32_t r, i;
    readRawSample(r, i);
    rs += r;
    is += i;
  }
  red = rs / kDecimation;
  ir = is / kDecimation;
}

// I2C bus clear (NXP UM10204 section 3.1.16). If the ESP32 resets in the middle
// of a read, the MAX30102 can be left driving SDA low while it waits for clock
// pulses that never come, and it ignores every later transaction until it is
// power-cycled. Clocking SCL until SDA is released, then issuing a STOP, frees
// it without a power cycle. Returns the idle levels seen, for diagnostics.
static void i2cBusClear(int& sdaBefore, int& sclBefore) {
  pinMode(SDA_PIN, INPUT_PULLUP);
  pinMode(SCL_PIN, INPUT_PULLUP);
  delayMicroseconds(10);
  sdaBefore = digitalRead(SDA_PIN);
  sclBefore = digitalRead(SCL_PIN);
  if (sdaBefore == HIGH || sclBefore == LOW) return;  // bus free, or SCL fault we can't fix

  pinMode(SCL_PIN, OUTPUT_OPEN_DRAIN);
  for (int i = 0; i < 9 && digitalRead(SDA_PIN) == LOW; ++i) {
    digitalWrite(SCL_PIN, LOW);  delayMicroseconds(5);
    digitalWrite(SCL_PIN, HIGH); delayMicroseconds(5);
  }
  // STOP condition: SDA rises while SCL is high.
  pinMode(SDA_PIN, OUTPUT_OPEN_DRAIN);
  digitalWrite(SDA_PIN, LOW);  delayMicroseconds(5);
  digitalWrite(SCL_PIN, HIGH); delayMicroseconds(5);
  digitalWrite(SDA_PIN, HIGH); delayMicroseconds(5);
  pinMode(SDA_PIN, INPUT_PULLUP);
  pinMode(SCL_PIN, INPUT_PULLUP);
}

// Diagnostics for a sensor that will not initialise. Two measurements that,
// together, separate the possible faults instead of leaving them to guesswork:
//  * which I2C addresses ACK (the MAX30102 is 0x57)
//  * whether each line is held high by the module's own pull-up resistor.
//    With the ESP32's weak internal pull-DOWN enabled, a line that still reads
//    1 is being driven up externally -- which requires the module to be both
//    wired and powered. (Internal pull-ups, as used for the bus clear, would
//    read 1 on a disconnected wire too, so they cannot answer this.)
static void i2cScan(char* out, size_t len) {
  out[0] = 0;
  size_t n = 0;
  for (uint8_t a = 1; a < 127; ++a) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0 && n + 6 < len) n += snprintf(out + n, len - n, "0x%02X ", a);
  }
  if (!n) snprintf(out, len, "none");
}

static void externalPullups(int& sda, int& scl) {
  pinMode(SDA_PIN, INPUT_PULLDOWN);
  pinMode(SCL_PIN, INPUT_PULLDOWN);
  delayMicroseconds(100);
  sda = digitalRead(SDA_PIN);
  scl = digitalRead(SCL_PIN);
  pinMode(SDA_PIN, INPUT_PULLUP);
  pinMode(SCL_PIN, INPUT_PULLUP);
}

static bool initSensor() {
  if (!sensor.begin(Wire, I2C_SPEED_FAST)) return false;
  // brightness 60, no on-chip averaging (decimation is done in software so
  // timing stays explicit), Red+IR mode, 100 Hz, 411 us pulse, 4096 nA range.
  sensor.setup(60, 1, 2, kRawRateHz, 411, 4096);
  return true;
}

// Sends one frame as MTU-sized notifications. The receiver's deframer
// reassembles on the magic bytes and CRC, so the chunk boundary is free.
static void sendFrame(const uint8_t* data, size_t len) {
  if (!clientConnected || txChar == nullptr) return;
  uint16_t mtu = server->getPeerMTU(server->getConnId());
  size_t chunk = (mtu > 3) ? mtu - 3 : 20;
  if (chunk < 20) chunk = 20;
  for (size_t off = 0; off < len; off += chunk) {
    size_t n = (len - off < chunk) ? len - off : chunk;
    txChar->setValue(const_cast<uint8_t*>(data + off), n);
    txChar->notify();
  }
}

static void startBle() {
  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setMTU(kRequestedMtu);
  // Maximum transmit power (+9 dBm instead of the +3 dBm default): ~6 dB of
  // extra link margin. In the car the Pi sits a metre or two away with the
  // column, the wheel's plastic and the driver's body in between, and a
  // marginal link drops with reason 0x3E every few seconds. Set for
  // advertising, for the connection itself, and as the default for handles
  // opened later -- Bluedroid tracks these separately.
  BLEDevice::setPower(ESP_PWR_LVL_P9, ESP_BLE_PWR_TYPE_ADV);
  BLEDevice::setPower(ESP_PWR_LVL_P9, ESP_BLE_PWR_TYPE_CONN_HDL0);
  BLEDevice::setPower(ESP_PWR_LVL_P9, ESP_BLE_PWR_TYPE_DEFAULT);

  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* service = server->createService(SERVICE_UUID);
  txChar = service->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());
  // Reserved Pi -> ESP32 channel, kept for future commands.
  service->createCharacteristic(RX_UUID, BLECharacteristic::PROPERTY_WRITE);
  service->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
}

// ---------------------------------------------------------------- setup ---
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("Steering Wheel PPG transmitter, protocol v3");

  for (int attempt = 1;; ++attempt) {
    int sda, scl;
    i2cBusClear(sda, scl);
    Wire.begin(SDA_PIN, SCL_PIN);
    if (initSensor()) break;
    char found[64];
    i2cScan(found, sizeof found);
    Wire.end();
    int extSda, extScl;
    externalPullups(extSda, extScl);
    Serial.printf("MAX30102 not found (attempt %d): I2C ACKs: %s| module pull-ups SDA=%d SCL=%d | "
                  "bus-idle SDA=%d SCL=%d\n", attempt, found, extSda, extScl, sda, scl);
    if (attempt == 1 || attempt % 10 == 0) {
      Serial.println(extSda || extScl
          ? "  -> module is wired and powered but not answering at 0x57"
          : "  -> no module pull-ups seen: check VIN/3.3V, GND, SDA->21, SCL->22");
    }
    delay(1000);
  }
  Serial.println("MAX30102 ready");

  startBle();
  Serial.printf("BLE advertising as %s, requested MTU %u\n", DEVICE_NAME, kRequestedMtu);

  // Prime the algorithm with 4 s of data before the first frame.
  Serial.println("Priming 4 s buffer - keep finger steady");
  for (int i = 0; i < kAlgoLen; ++i) {
    readAlgoSample(redBuffer[i], irBuffer[i]);
    pushHistory(redBuffer[i], irBuffer[i]);
  }
  maxim_heart_rate_and_oxygen_saturation(irBuffer, kAlgoLen, redBuffer,
                                         &spo2, &validSpo2, &heartRate, &validHeartRate);
  Serial.println("Streaming");
}

// ----------------------------------------------------------------- loop ---
void loop() {
  if (restartAdvertising) {
    restartAdvertising = false;
    BLEDevice::startAdvertising();
    Serial.println("Pi disconnected - advertising again");
  }
  if (connParamsChanged) {
    connParamsChanged = false;
    Serial.printf("BLE link params: interval=%.2fms latency=%u supervision=%ums status=%d\n",
                  connIntervalUnits * 1.25f, connLatency, connTimeoutUnits * 10u, connParamsStatus);
  }

  // Slide the Maxim window: keep the newest 75 algorithm samples.
  memmove(redBuffer, redBuffer + kAlgoNewPerSecond, (kAlgoLen - kAlgoNewPerSecond) * sizeof(uint32_t));
  memmove(irBuffer, irBuffer + kAlgoNewPerSecond, (kAlgoLen - kAlgoNewPerSecond) * sizeof(uint32_t));

  const uint32_t startMs = millis();
  uint64_t irTotal = 0;

  for (int a = 0; a < kAlgoNewPerSecond; ++a) {
    uint64_t rs = 0, is = 0;
    for (int k = 0; k < kDecimation; ++k) {
      uint32_t r, i;
      readRawSample(r, i);
      rs += r;
      is += i;
      frameRed[a * kDecimation + k] = r;  // time = startMs + index * 10 ms (sensor clock)
      frameIr[a * kDecimation + k] = i;
    }
    redBuffer[kAlgoLen - kAlgoNewPerSecond + a] = rs / kDecimation;
    irBuffer[kAlgoLen - kAlgoNewPerSecond + a] = is / kDecimation;
    pushHistory(rs / kDecimation, is / kDecimation);
    irTotal += is;
  }
  const uint32_t endMs = millis();

  maxim_heart_rate_and_oxygen_saturation(irBuffer, kAlgoLen, redBuffer,
                                         &spo2, &validSpo2, &heartRate, &validHeartRate);

  const uint32_t irMean = irTotal / kRawPerFrame;
  const bool finger = irMean >= kFingerIrThreshold;

  // Vitals come from ppg::estimate (see ppg_vitals.h for why it replaced
  // Maxim's). Maxim still runs above, but only for comparison on serial.
  ppg::Vitals vit{0, 0, 0, 0, false, false};
  if (finger && histFilled >= kAlgoLen) {  // need >= 4 s of data
    vit = ppg::estimate(histRed, histIr, scratchRed, scratchIr, histFilled, kAlgoFs,
                        kBpmMin, kBpmMax, uch_spo2_table, 184);
  }
  const int32_t bpm = vit.hrValid ? static_cast<int32_t>(lroundf(vit.heartRate)) : -999;
  const int32_t sat = vit.spo2Valid ? vit.spo2 : -999;
  const bool inRange = bpm >= kBpmMin && bpm <= kBpmMax && sat >= kSpo2Min && sat <= kSpo2Max;

  // -999 means "no result", matching the previous firmware; it fits in int16.
  ppg::FrameV3 frame{};
  frame.seq = frameSeq;
  frame.t0Ms = startMs;
  frame.rateHz = kRawRateHz;
  frame.sampleCount = kRawPerFrame;
  float q = vit.periodicity * 100.0f;
  frame.quality = static_cast<uint8_t>(q < 0 ? 0 : (q > 100 ? 100 : lroundf(q)));
  frame.heartRate = static_cast<int16_t>(bpm);
  frame.spo2 = static_cast<int16_t>(sat);
  frame.flags = (vit.hrValid ? ppg::kHrValid : 0) |
                (vit.spo2Valid ? ppg::kSpo2Valid : 0) |
                (finger ? ppg::kFinger : 0) |
                (inRange ? ppg::kInRange : 0);
  frame.red = frameRed;
  frame.ir = frameIr;

  const size_t frameLen = ppg::encodeV3(frame, frameBytes);
  sendFrame(frameBytes, frameLen);

  // Sequence advances whether or not the Pi is listening, so gaps the Pi
  // sees after a reconnect represent real seconds of lost data.
  ++frameSeq;

  // Samples the sensor had to drop because we fell behind (0 when healthy).
  const uint8_t ovf = sensor.readRegister8(kSensorAddr, kRegFifoOvf);
  if (ovf) sensor.writeRegister8(kSensorAddr, kRegFifoOvf, 0);
  const uint16_t crc = frameBytes[frameLen - 2] | (frameBytes[frameLen - 1] << 8);
  // maxim= is the old algorithm's answer, printed for comparison only.
  Serial.printf("#%lu bpm=%ld%s spo2=%ld%s q=%.2f R=%.3f maxim=%ld/%ld ir=%lu finger=%d win=%lums ovf=%u link=%s mtu=%u len=%u conns=%lu lastdisc=0x%02X crc=%04X\n",
                static_cast<unsigned long>(frame.seq),
                static_cast<long>(bpm), vit.hrValid ? "" : "?",
                static_cast<long>(sat), vit.spo2Valid ? "" : "?",
                vit.periodicity, vit.ratio,
                static_cast<long>(validHeartRate ? heartRate : -999), static_cast<long>(validSpo2 ? spo2 : -999),
                static_cast<unsigned long>(irMean), finger,
                static_cast<unsigned long>(endMs - startMs), ovf,
                clientConnected ? "up" : "down",
                clientConnected ? server->getPeerMTU(server->getConnId()) : 0,
                static_cast<unsigned>(frameLen),
                static_cast<unsigned long>(connectCount), lastDisconnectReason, crc);
}

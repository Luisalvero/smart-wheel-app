# PPG System — ESP32 → Raspberry Pi → Laptop

```
MAX30102 ──I²C──▶ ESP32 ──BLE──▶ Raspberry Pi ──BLE──▶ Laptop
                  1 frame/s      logs CSV,             live BPM / SpO₂
                  8 readings     verifies CRC,         charts, waveform,
                  + CRC-16       relays verbatim       packet log
```

One frame per second, 104 bytes: header, BPM, SpO₂, validity flags, 8 raw
Red/IR samples, CRC-16. The Pi forwards frames byte-for-byte, so the laptop
re-checks the ESP32's own CRC — corruption anywhere on the path is detected.
Full byte layout: `common/ppg_protocol.py` (docstring).

## Layout

```
esp32/ppg_transmitter/     firmware (ppg_transmitter.ino + ppg_frame.h)
esp32/flash_esp32.sh       compile + upload
pi/                        copy this folder to the Pi via USB
  ppg_relay.py             ESP32 link + CSV logger + laptop GATT server
  setup_pi.sh              one-shot install; starts at boot via systemd
  wheels/                  offline install for 64-bit Pi OS
laptop/
  ppg_viewer.py            the app
  run_viewer.sh            launcher (sets itself up on first run)
common/ppg_protocol.py     protocol master copy (pi/ and laptop/ hold copies)
tests/                     protocol + cross-language tests
```

## 1. ESP32

```bash
./esp32/flash_esp32.sh              # auto-detects /dev/ttyUSB0
~/.local/bin/arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=115200
```

Serial prints one line per frame:
`#42 bpm=65 spo2=99 q=0.66 R=0.437 maxim=93/100 ir=240592 finger=1 win=1003ms ovf=0 link=up mtu=517 crc=3A1F`
`?` = no valid result; `q` = pulse periodicity (signal quality, needs ≥0.5);
`win` should be ~1000 ms and `ovf` 0 — anything else means samples are being lost.

If the sensor is missing the firmware diagnoses it itself, e.g.
`I2C ACKs: none | module pull-ups SDA=1 SCL=0` (here: SCL not reaching GPIO22).

Toolchain: arduino-cli 1.5.1, ESP32 core 3.3.12, SparkFun MAX3010x 1.1.2.
Build options: **40 MHz DIO flash** (`flash_esp32.sh` sets them). At the
80 MHz QIO default this board intermittently misread its own intact flash at
boot and looped (43 boots in 15 s, Bluetooth never started).
Wiring unchanged: SDA→GPIO21, SCL→GPIO22, 3.3 V, GND.

## 2. Raspberry Pi

Copy the `pi/` folder to a USB stick, plug it into the Pi, then:

```bash
cd /media/$USER/<stick>/pi
sudo ./setup_pi.sh
```

That's the whole setup. It installs anything missing, powers Bluetooth, copies
the relay to `~/PPG_Logger`, and installs a service that **starts at every
boot** — the manual startup checklist is no longer needed.
Rerun the same command after copying new code to update.

```bash
journalctl -u ppg-relay -f                  # live log
tail -f ~/PPG_Logger/logs/ppg_data.csv      # vitals as they're logged
```

Logs (in `~/PPG_Logger/logs/`):

| File | Rows | Columns |
|---|---|---|
| `ppg_data.csv` | 1 per second | `timestamp, spo2, avg_spo2, bpm, avg_bpm` (same first five as before) + `seq, esp_start_ms, esp_end_ms, hr_valid, spo2_valid, finger, in_range` |
| `ppg_samples.csv` | 8 per second | `timestamp, seq, index, esp_ms, red, ir` |
| `latest_ppg.json` | latest only | replaced atomically |

Unusable seconds (no finger, algorithm invalid, out of range) log **blank**
vitals rather than `-999`, and never enter the 5-point averages. An old CSV with
the previous header is renamed `*.old.csv` rather than mixed with new rows.

## 3. Laptop

```bash
./laptop/run_viewer.sh            # through the Pi
./laptop/run_viewer.sh --direct   # straight to the ESP32 — isolates Pi faults
./laptop/run_viewer.sh --demo     # no hardware
```

Shows: connection state, **connected-at timestamp** and duration, ESP32→Pi link
status, live BPM and SpO₂ with 5-point averages, BPM and SpO₂ charts (5 min),
the raw IR waveform, a packet log with CRC status, and loss/CRC counters.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

Includes a cross-language test: the ESP32's `ppg_frame.h` is compiled with the
host `g++` and its output decoded by the Python code, so firmware and software
cannot drift apart. Also verifies every single-bit flip in a frame is caught.

## What changed from the previous code, and why

**Firmware — measurement fixes (these change the numbers)**
- **Sampling ran 2.5× slow, with red and IR from different samples.** SparkFun's
  `getRed()`/`getIR()` each block until a *new* sample arrives and return the
  newest one, so each read spanned ~2.5 sample periods (100 samples took
  2,507 ms, not 1,000) and red/IR came from different instants — which breaks
  SpO₂. **Both previous sketches had this.** The firmware now reads the
  sensor FIFO directly: measured 1,003 ms per 100 samples, 0 overflow.
- **Heart rate read ~45% high.** Maxim's reference algorithm counts the second
  bump of each pulse as an extra beat. Measured on the same finger: Maxim
  median 115 bpm (88–150, stdev 15.4) vs waveform autocorrelation/spectrum
  79–80 bpm. Replaced by `ppg_vitals.h` (autocorrelation over 8 s, sub-sample
  interpolation): median 65 bpm (58–69, stdev 3.3) at rest. SpO₂ uses Maxim's
  own calibration table, with the red/IR ratio taken over the whole window.
  Maxim still runs, printed as `maxim=` on serial for comparison.
- **Finger threshold measured on this module**: finger ≈ 242,000, object
  resting on sensor ≈ 50,400 (no pulse), open air ≈ 1,100 → threshold 100,000.
  The SparkFun example value (50,000) reported a finger that wasn't there.

**Firmware — transport and robustness**
- **The packet is actually sent.** The 8-reading version built the packet but
  only printed it, and its sequence number never advanced.
- **CRC-16/CCITT-FALSE** on every frame (check value `0x29B1` verified).
- **Explicit byte layout** instead of sending a C struct, whose padding made the
  wire format compiler-dependent.
- **MTU chunking.** `notify()` silently truncates to MTU−3 (verified in the
  core source), so a 100+ byte packet would have arrived as 20 bytes on a
  default link. The firmware requests MTU 247 and chunks to whatever is
  negotiated; the receivers reassemble. Measured MTU to BlueZ: 517.
- **Sample timestamps from the sensor clock** (n × 10 ms), not `millis()` at
  FIFO-drain time — samples queue during the algorithm and are read in a burst,
  so read-time stamps bunched together.
- No `delay()` inside BLE callbacks; sensor init retries instead of hanging;
  one serial line per frame instead of ~30 (UART writes were blocking `loop()`).

**Raspberry Pi**
- Reads the binary frame (the old logger parsed the old CSV-text format only).
- Relays to the laptop over BLE from the same process — one asyncio loop, and
  no new packages (bleak already depends on dbus-fast).
- Registers a pairing agent: without one, a pairing request goes unanswered and
  the central drops the link.
- Waits on the disconnect event instead of polling once a second, so a dropped
  ESP32 reconnects immediately.
- Files are kept open and flushed per row, and written off the event loop, so a
  slow SD card can't delay BLE.

## Status

| Verified | How |
|---|---|
| Protocol, CRC, deframer | 16 unit tests incl. C++↔Python and all 832 single-bit flips |
| HR/SpO₂ estimator | 45 synthetic cases (45–180 bpm, with dicrotic notch) within 2 bpm; noise rejected |
| ESP32 → laptop over BLE | real hardware: 1.004 s/frame, 0 CRC errors, 0 loss, 104-byte single notifications |
| Firmware compiles | ESP32 core 3.3.12, 0 warnings in project code |
| Pi relay's ESP32 link + GATT server + advertising, simultaneously | run on this laptop against the real ESP32; link held, MTU 517 |
| Viewer | demo mode screenshot; 0 loss / 0 CRC errors through 20-byte chunks |

Not yet run on the Raspberry Pi itself. The relay needs the Pi's controller to
be a central (to the ESP32) and a peripheral (to the laptop) at once; this was
proven on the laptop's Intel AX200, and BlueZ supports it, but the Pi's
Broadcom chip is untested here.

# Biometric Steering Wheel — System Guide

**Team 18 · FIU Senior Design · Prototype, not a medical device**

This guide explains every part of the working system: what it does, why it is
built that way, how to set it up from scratch on any Linux machine, and how to
check that it works. It is written for the whole team. You do not need to have
worked on a part to follow its section.

Contents

1. [The system in one picture](#1-the-system-in-one-picture)
2. [Hardware: sensor and ESP32](#2-hardware-sensor-and-esp32)
3. [ESP32 firmware](#3-esp32-firmware)
4. [Signal processing and algorithms](#4-signal-processing-and-algorithms)
5. [The radio packet (protocol v3)](#5-the-radio-packet-protocol-v3)
6. [Raspberry Pi relay](#6-raspberry-pi-relay)
7. [Phone app](#7-phone-app)
8. [Cloud: Supabase](#8-cloud-supabase)
9. [Website dashboard](#9-website-dashboard)
10. [Data policy, storage and backups](#10-data-policy-storage-and-backups)
11. [Alerts and baselines](#11-alerts-and-baselines)
12. [Setting up a development machine (any Linux)](#12-setting-up-a-development-machine-any-linux)
13. [Everyday commands](#13-everyday-commands)
14. [Tests](#14-tests)
15. [Measured results](#15-measured-results)
16. [Troubleshooting](#16-troubleshooting)
17. [Security status and before-real-data checklist](#17-security-status-and-before-real-data-checklist)
18. [How this maps to the proposal](#18-how-this-maps-to-the-proposal)
19. [References](#19-references)

---

## 1. The system in one picture

```
 hand on wheel
      │  light reflected through the skin
      ▼
 MAX30102 PPG sensor ──I²C──▶ ESP32 ──Bluetooth LE──▶ Raspberry Pi 5 ──Bluetooth LE──▶ iPhone app ──cellular──▶ Supabase ──▶ website
 (red + infrared,             100 samples/s,          checks CRC, logs              stores locally first,       Postgres,       live dashboard,
  18-bit, 100 Hz)             BPM + SpO₂ each s,      CSV, forwards the             alerts, streams live        Realtime,       history, summaries,
                              one 472-byte packet/s   packet unchanged              every second                Storage         waveform unfold
```

| Part | Runs | Where the code is |
|---|---|---|
| Sensor + ESP32 | Arduino C++ | `system/esp32/ppg_transmitter/` |
| Pi relay + terminal dashboard | Python 3 (asyncio, bleak, dbus-fast, rich) | `system/pi/` |
| Laptop viewer (bench tool) | Python 3 (PySide6, pyqtgraph) | `system/laptop/` |
| Shared protocol code | Python | `system/common/` (copied into `pi/` and `laptop/`) |
| Phone app | React Native + Expo SDK 54, TypeScript | `mobile-app/` |
| Database | Supabase (Postgres 17, Realtime, Storage) | `mobile-app/supabase/*.sql` |
| Website | Vite + vanilla JS, uPlot, fflate | `website/` |

**Key design ideas**

- **Only the phone needs the internet.** In the car the ESP32 and the Pi talk
  only over Bluetooth. The phone uses its cellular data to reach Supabase.
- **Nothing is lost when there is no signal.** The phone saves every reading
  locally first, then uploads. Uploads are retried, and the same row can be
  sent twice without creating a duplicate.
- **Errors are caught end to end.** The ESP32 adds a CRC-16 checksum to every
  packet. The Pi forwards packets byte-for-byte, and the phone checks the
  ESP32's checksum again. Corruption anywhere on the path is detected.

---

## 2. Hardware: sensor and ESP32

| Item | Detail |
|---|---|
| Microcontroller | ESP32-D0WD-V3 (rev 3.1) dev board, CP210x USB-serial (USB ID `10c4:ea60`) |
| Sensor | MAX30102 pulse-oximetry module, I²C address `0x57` (PART_ID reads `0x15`) |
| Wiring | module **3V3 → ESP32 3V3**, **GND → GND**, **SDA → GPIO 21**, **SCL → GPIO 22** |
| Pi | Raspberry Pi 5, Raspberry Pi OS, Bluetooth + Wi-Fi from its onboard Infineon CYW43455 |

Wiring notes from the bench:

- SCL must be on **GPIO 22**. On GPIO 23 the sensor is not found. The firmware
  prints I²C diagnostics if the sensor is missing: which addresses answer, and
  whether the module's pull-up resistors are visible.
- **Car power.** The ESP32 runs from the car's 12 V through a 12 V→5 V USB
  adapter. The Pi should get an ignition-switched supply. Sudden power loss
  can corrupt the Pi's SD card, so a UPS HAT or a supercapacitor plus an
  ignition-sense line is recommended before real use.

---

## 3. ESP32 firmware

File: `system/esp32/ppg_transmitter/ppg_transmitter.ino`, with `ppg_frame.h`
(packet encoder) and `ppg_vitals.h` (heart rate and SpO₂).

What it does every second:

1. **Reads the sensor FIFO directly** (registers `0x04`–`0x07`). The sensor
   samples at **100 Hz**: SpO₂ mode, 411 µs LED pulse, 18-bit ADC, 4096 nA
   range. The datasheet allows 50/100/200/400 sps at 411 µs. SparkFun's
   `getRed()/getIR()` are not used. Measured on this board, they block and
   return the *newest* sample, which ran acquisition 2.5× slow and paired red
   and IR values from different moments.
2. **Keeps all 100 raw samples** for the packet.
3. **Averages groups of 4 samples into a 25 Hz series** (decimation) for the
   vitals estimator and keeps an 8-second history.
4. **Estimates heart rate and SpO₂** (see §4). The finger check uses the
   infrared (IR) DC level, which must be at least **100 000**.
5. **Builds a v3 packet** (§5): 472 bytes, CRC-16. It sends the packet in
   pieces sized to the Bluetooth link, because the stack silently truncates
   anything larger than MTU−3.
6. **Prints one line to serial**, for example:
   `#105 bpm=72 spo2=99 q=0.83 R=0.439 maxim=136/99 ir=256361 finger=1 win=999ms ovf=0 link=up mtu=247 len=472 conns=3 lastdisc=0x13 crc=3771`
   (`maxim=` is the old reference algorithm, printed only for comparison;
   `ovf` counts sensor samples dropped because we fell behind, and should be 0;
   `conns`/`lastdisc` show how many times the Pi connected and why the last
   link ended, as an HCI reason code).

Bluetooth settings:

- Advertises as `SteeringWheelESP32` with the Nordic UART Service UUIDs.
- Transmit power is **+9 dBm**, the maximum. The default was +3 dBm.
- Asks the Pi for a connection interval of 30–50 ms, latency 0 and a
  supervision timeout of 4 s.

Build settings: flash at **40 MHz DIO**. At the default 80 MHz QIO this board
failed its boot checksum and rebooted in a loop.

---

## 4. Signal processing and algorithms

**Filtering chain (on the ESP32)**

| Stage | What | Why |
|---|---|---|
| On-chip | 18-bit sigma-delta ADC, 411 µs pulses, ambient-light cancellation in the MAX30102 | clean raw optical signal |
| Decimation | mean of each 4 consecutive 100 Hz samples → 25 Hz | box-car low-pass; cuts high-frequency noise, and 25 Hz is plenty for heart rate |
| Baseline removal | subtract a centred 1-second moving average | removes DC and slow drift (breathing, pressure changes) |
| Smoothing | 3-tap filter, −3 dB near 8 Hz at 25 Hz | smooths noise but keeps the pulse harmonics |
| Finger gate | IR DC ≥ 100 000 counts | measured: finger ≈ 242 000, object resting ≈ 50 400, open air ≈ 1 100 |
| Plausibility | BPM 30–220, SpO₂ 70–100 | anything outside is flagged as not usable |

**Heart rate: autocorrelation** (`ppg_vitals.h`)

- Works on 8 s of the pulsatile infrared signal at 25 Hz.
- Computes the normalised autocorrelation and takes the first peak that
  reaches **0.5** or more as the beat period.
- Refines that peak with parabolic interpolation, giving sub-sample precision.
- Heart rate = 60 / period.
- The peak's height (0–1) is the **quality** score sent in every packet.

It replaced Maxim's reference algorithm. On this hardware, Maxim's median was
115 BPM when independent estimates said 79–80. It counts the dicrotic notch as
an extra beat. The new estimator's median was 65 BPM with a standard deviation
of 3.3.

**SpO₂: ratio of ratios**

- R = (AC_red / DC_red) / (AC_ir / DC_ir), where AC is the RMS over the window.
- R is looked up in Maxim's own calibration table (`uch_spo2_table`), so the
  calibration is the manufacturer's.

**On the Pi**: a 5-point moving average of usable readings, for the display
only.

**On the phone and website**, summaries use percentiles, not min/max. PPG on
a steering wheel picks up grip and motion artifacts, and a single bad second
would otherwise become the "highest heart rate" of a drive.

- **Realistic low** = 5th percentile, **typical** = median, **realistic high**
  = 95th percentile. Min and max are still shown in small print.
- The phone and the database use the same percentile definition (linear
  interpolation, like Postgres `percentile_cont`), so they report identical
  numbers. This is unit-tested.

**Why 100 Hz raw data matters.** Mean heart rate needs only a low sampling
rate. Pulse-rate variability is reliable at 25 Hz or more in healthy subjects
(Choi & Shin 2017). RMSSD and frequency-domain HRV need about 100–200 Hz unless
you interpolate (Béres et al. 2019). Sending every 100 Hz sample keeps those
analyses possible for the team's future algorithm work.

---

## 5. The radio packet (protocol v3)

One packet per second. Little-endian. The CRC is computed by the ESP32 and
checked by the Pi, the phone and the laptop.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 2 | magic `0xA55A` | on the wire `5A A5` |
| 2 | 1 | version | 3 |
| 3 | 1 | flags | 1 = HR valid, 2 = SpO₂ valid, 4 = finger, 8 = in range |
| 4 | 4 | seq | +1 per second, restarts at 0 when the ESP32 reboots |
| 8 | 4 | t0_ms | ESP32 clock at the first sample |
| 12 | 2 | rate_hz | 100 |
| 14 | 1 | n | samples in this packet (100) |
| 15 | 1 | quality | 0–100 |
| 16 | 2 | heart_rate | BPM, −999 = no result |
| 18 | 2 | spo2 | %, −999 = no result |
| 20 | ⌈36n/8⌉ | samples | n × {red:18 bits, IR:18 bits}, bit-packed |
| end | 2 | CRC-16/CCITT-FALSE | check value `0x29B1` |

- Sample *i* was taken at `t0_ms + i × 1000 / rate_hz`, on the sensor's own
  clock.
- v3 carries **12.5× the samples of v2 for 4.5× the bytes**. v2 sent 8 of the
  100 samples in 104 bytes. The 18 bits match the sensor's ADC exactly, so no
  data is lost.
- The receivers also decode v2, so old captures still read.
- **The deframer** reassembles packets from Bluetooth pieces of any size. It
  resynchronises on the magic bytes after corruption. If it has buffered a
  false header, it looks ahead for a complete valid packet instead of waiting
  on the false one.
- **Implementations are kept in lock-step by tests:**
  - C++ `ppg_frame.h` (encoder)
  - Python `system/common/ppg_protocol.py`
  - TypeScript `mobile-app/lib/ble/protocol.ts`

  Both the Python and TypeScript test suites decode packets produced by the
  compiled firmware encoder.

**Bluetooth IDs**

| | Service | Characteristic |
|---|---|---|
| ESP32 | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | TX notify `6e400003-…` |
| Pi relay (`PPG-Relay-Pi`) | `5b1e0001-7c2d-4f6a-9e3b-8a4c2d1f6e01` | frames `5b1e0002-…` (notify), status JSON `5b1e0003-…` (read) |

---

## 6. Raspberry Pi relay

Files (in `system/pi/`, installed to `~/PPG_Logger` on the Pi):

- `ppg_relay.py` — one asyncio process that:
  - connects to the ESP32 as a Bluetooth central (bleak) and verifies every
    packet;
  - logs processed values to `~/PPG_Logger/logs/ppg_data.csv` (owner-only
    permissions, umask 077). Columns: timestamp, spo2, avg_spo2, bpm, avg_bpm,
    seq, esp times, validity flags, quality, protocol, samples, rate_hz;
  - runs a GATT server and advertisement for the phone (dbus-fast → BlueZ),
    forwarding each packet unchanged in MTU-sized pieces;
  - writes live state to `/run/ppg-relay/state.json` for the dashboard;
  - retries the phone-side service every 5 s if Bluetooth is off at boot;
  - backs off between failed ESP32 attempts, from 1 s up to 15 s;
  - releases BlueZ links orphaned by a crash.
- `ppg_monitor.py` — the terminal dashboard. It opens automatically at boot
  and shows the links, vitals with sparklines, latest packets, counters
  (including the packet format and bytes/s) and events. `ppg-monitor --once`
  prints one frame.
- `setup_pi.sh` — one-shot installer (`sudo bash setup_pi.sh`). It:
  - installs bluez and python3-venv;
  - unblocks and powers Bluetooth;
  - writes the `[LE]` connection and scan parameters to
    `/etc/bluetooth/main.conf`;
  - builds a venv from the bundled wheels in `pi/wheels/`, so no internet is
    needed;
  - installs the systemd service `ppg-relay` (`Restart=always`, `UMask=0077`);
  - sets the dashboard to autostart.

  Options: `--no-service`, `--no-dashboard`, `--uninstall`.
- **Raw samples are off by default.** `--log-raw` stores them for development
  only.

**Important: the Pi 5's Wi-Fi and Bluetooth share one radio and antenna.**
Measured on the bench:

- While the Pi's Wi-Fi was on 2.4 GHz, the ESP32 link failed to establish
  (HCI reason `0x3E`) again and again.
- Switching Bluetooth on made Wi-Fi glitch.
- **With Wi-Fi off, the link held steadily.**

What to do about it:

- **In the car:** keep Wi-Fi off (`sudo nmcli radio wifi off`). Nothing on the
  Pi needs it.
- **On the bench:** the relay now scans at a 25% duty cycle and backs off after
  failures. It is still best to use Ethernet, or to keep Wi-Fi off while
  testing Bluetooth.
- **Placement:** keep the ESP32 within about 1–2 m of the Pi, and never with a
  laptop or other metal between them. The Pi heard the ESP32 at −93 dBm with a
  laptop in between, which is at the limit of sensitivity.

---

## 7. Phone app

React Native (Expo SDK 54), TypeScript, in `mobile-app/`.

**Screens**

- **Who's driving?** — pick or add a driver: name, subject ID, age, weight,
  height, gender. Once in, **Switch driver** in the header goes back. If a
  drive is recording, it is ended and saved first.
- **Drive**
  - Phone → Pi → Wheel connection chain.
  - Big heart-rate and oxygen tiles.
  - 2-minute charts, with the driver's usual range shaded.
  - Start/End drive.
  - A **Data flow** card with a live dot that moves with the bytes/s coming
    from the wheel, plus the bytes/s sent to the cloud.
- **History** — past drives with realistic low / typical / realistic high,
  alerts, and **Unfold waveform** for full-waveform drives. Unfold checks the
  SHA-256, decompresses, and shows 10 s of red and IR.
- **Settings**
  - What to save (§10).
  - Upload waiting drives.
  - Auto-connect on/off.
  - Link health counters.
  - Bench-only "connect straight to ESP32".

**How it connects**: it scans for the Pi relay only and reconnects by itself,
backing off 1, 2, 4, then 8 s. It retries immediately when the app returns to
the foreground. Direct-to-ESP32 is off by default: the ESP32 accepts one
connection, so a phone holding it would lock the Pi out.

**Sessions**

- One reading per second is stored in SQLite: BPM and SpO₂ only when
  "usable", plus finger, quality and the time received.
- If the ESP32 restarts mid-drive (its sequence jumps backwards), the app
  closes the session and continues in a new one, so nothing collides.

**Live upload** (`lib/db/liveSync.ts`) runs every second. It pushes the
driver, the session (with a heartbeat: `last_seen_at` and a `link_state` of
streaming / sensor_lost / pi_lost), new readings and alerts. At the end of a
drive it also uploads the folded archive to Storage. If the database hasn't
had the v3 update, it falls back to the older columns instead of failing.

**Install on an iPhone.** There is no paid Apple account, so the app is
sideloaded:

1. Push to the build repo, and GitHub Actions builds an unsigned `.ipa`. See
   `.github/workflows/ios-build.yml`: it installs, typechecks, runs the unit
   tests, runs `expo prebuild` and `xcodebuild`, then packages the file.
2. Download the artifact.
3. Sign and install it with **iloader** and a free Apple ID. Run
   `apploader` on the dev laptop.
4. On the phone: **Settings → General → VPN & Device Management → Trust**, with
   Developer Mode on.

Free signing certificates expire after **7 days**. Then the app shows "no
longer available"; reinstall to renew.

Supabase URL and publishable key: in CI they come from the repository secrets
`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, written
to `.env` at build time.

---

## 8. Cloud: Supabase

Run these in **Supabase → SQL Editor**, in this order. Each is safe to re-run.

1. `mobile-app/supabase/schema.sql` — creates:
   - tables `driver_profiles`, `drive_sessions`, `telemetry_events`;
   - the view `session_summaries`;
   - prototype row-level security.
2. `mobile-app/supabase/live.sql` — turns on Realtime. It also adds a bridge
   to the old `test_readings` table, which step 3 retires.
3. `mobile-app/supabase/v3_dashboard.sql` — adds:
   - the session heartbeat, plus finger and quality on each reading;
   - **percentile summaries**, the `driver_baselines` view and the
     `active_sessions` view;
   - `session_archives` and the private Storage bucket `session-archives`;
   - `drive_alerts`;
   - Realtime on all live tables;
   - and it removes the bridge.

All primary keys are UUIDs made on the phone, so uploads are idempotent
upserts.

---

## 9. Website dashboard

`website/` is Vite with vanilla JS modules. It is deployed on Vercel at
**https://smart-wheel-dashboard.vercel.app**.

- **Live**
  - Every active drive appears on its own, with no refresh.
  - When exactly one is active, a big live chart opens, with the driver's
    usual range drawn behind it.
  - State pills show Streaming / No finger / Sensor lost / Phone quiet, and
    alert banners appear here too.
  - When a drive ends, its card turns into the summary: realistic low/high,
    median, average, duration and usable %.
- **Drives** — history with paginated charts, alerts, and **Unfold waveform**.
  Unfold downloads the `.ppga` file from Storage, checks its SHA-256, and plots
  the red and IR waveforms with zoom.
- **Drivers** — each driver's baseline, or "learning" until there is enough
  data.
- **Developer feed** — the team's original `test_readings` table.
- It shows a setup banner if `v3_dashboard.sql` hasn't been run.

Local run: `cd website && npm install`, create `website/.env` with
`VITE_SUPABASE_URL=…` and `VITE_SUPABASE_PUBLISHABLE_KEY=…`, then `npm run dev`.

Deploy:

```
npx vercel link
npx vercel env add VITE_SUPABASE_URL production
npx vercel env add VITE_SUPABASE_PUBLISHABLE_KEY production
npx vercel deploy --prod
```

---

## 10. Data policy, storage and backups

**The proposal's policy** ("Option 3"): keep processed values, not raw PPG,
with restricted permissions. The app follows it by default and makes raw
storage an explicit, informed choice.

| Mode (Settings → What to save) | Stored |
|---|---|
| **Vitals only** (default) | BPM, SpO₂, finger and quality once per second. No raw samples anywhere. |
| **Vitals + full waveform** | The above, plus every raw red/IR sample, **folded** into an archive at the end of the drive. Use only with the driver's consent. |

**The folded archive ("PPGA")** works like folding a long poem to keep it:
small to store, and it opens back exactly when you need it.
`mobile-app/lib/archive/codec.ts` has the full byte layout.

1. **Predict each value from the previous ones.** A fixed polynomial predictor
   of order 0–3 is chosen per column, the same idea as FLAC's "fixed"
   predictors (RFC 9639). A smooth PPG waveform leaves tiny leftovers
   ("residuals").
2. **Store the residuals compactly**: zigzag + LEB128 variable-length integers,
   so small numbers take 1–2 bytes instead of 4.
3. **DEFLATE-compress the result** (LZ77 + Huffman).
4. **Verify before deleting anything.** The phone unfolds the archive and
   compares every sample with the original. Only then does it clear the raw
   copy, in one database transaction. A **SHA-256** checksum is stored and
   checked every time the archive is opened, on the phone or the website.

On synthetic 100 Hz PPG this folds 2 minutes from 96 KB to 22 KB, **4.4×** and
lossless. Published lossless compression of biosignals using prediction plus
entropy coding reports about 3–4× (Bannajak et al. 2023). Expect about 4× on
real data. Confirm this on your own recordings.

**Backups (3-2-1 rule)**: three copies, on two kinds of storage, one off-site
(CISA / US-CERT "Data Backup Options").

- **Copy 1:** the phone's database.
- **Copy 2:** Supabase (off-site). Readings, summaries and the `.ppga` archive
  in Storage.
- **Copy 3:** the Pi's SD card CSV of processed values.

Supabase encrypts data at rest (AES-256) and in transit (TLS).

---

## 11. Alerts and baselines

**Baseline**

- A driver's **usual range** is the 10th to 90th percentile of all usable
  heart-rate readings from their finished drives.
- It counts as established after 60 readings (one minute of good signal).
- The same definition runs on the phone (offline, in the car) and in the
  database view `driver_baselines`.

**Alert flow** (`mobile-app/lib/analysis/alerts.ts`, unit-tested):

1. Every second, take the **median of the last 10 s** of readings. One noisy
   second cannot trigger an alert. A window with too few readings (poor
   signal) is not judged at all.
2. **Out of range** means any of:
   - heart rate outside the usual range widened by ±15 BPM;
   - heart rate below **40** or above **150**, with or without a baseline;
   - SpO₂ below **90%**.
3. After **20 s out of range**, the phone **vibrates** (non-visual first, as
   the proposal requires) and asks "Are you feeling OK?".
4. "I'm OK" closes the alert and starts a 5-minute quiet period. "I don't feel
   well", or no answer within **30 s**, marks it **escalated**.
5. In this prototype escalation is **simulated**, as the proposal specifies
   for testing. The alert is recorded and shown on the website; nobody is
   contacted.
6. Every alert is saved to `drive_alerts` with its value, threshold, times and
   outcome.

These limits are prototype values for demonstration, not clinical
thresholds.

---

## 12. Setting up a development machine (any Linux)

**1. System packages**

| Distro | Command |
|---|---|
| Debian / Ubuntu / Raspberry Pi OS | `sudo apt install git python3 python3-venv python3-pip g++ bluez curl chromium` |
| Fedora | `sudo dnf install git python3 python3-pip gcc-c++ bluez curl chromium` |
| Arch / Manjaro / Omarchy | `sudo pacman -S git python python-pip gcc bluez bluez-utils curl chromium` |
| openSUSE | `sudo zypper install git python3 python3-pip gcc-c++ bluez curl chromium` |

Then enable Bluetooth: `sudo systemctl enable --now bluetooth`.

**2. Node.js 22.** Use a version manager so every distro gets the same
version:

```
curl -fsSL https://fnm.vercel.app/install | bash      # then open a new terminal
fnm install 22 && fnm default 22
node --version                                        # v22.x or newer
```

**3. The code**

```
git clone <repo-url> fiu-senior && cd fiu-senior
git checkout luis/full-system
```

**4. ESP32 toolchain**

```
curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=~/.local/bin sh
~/.local/bin/arduino-cli config init
~/.local/bin/arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
~/.local/bin/arduino-cli core update-index
~/.local/bin/arduino-cli core install esp32:esp32@3.3.12
~/.local/bin/arduino-cli lib install "SparkFun MAX3010x Pulse and Proximity Sensor Library@1.1.2"
```

Serial-port access for the ESP32's CP210x chip, needed once per machine.
Replug the ESP32 afterwards:

```
echo 'SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-esp32-cp210x.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

**5. Python tools (laptop viewer, esptool)**

```
python3 -m venv ~/ppg-venv
~/ppg-venv/bin/pip install bleak==3.0.2 dbus-fast pyqtgraph PySide6 pyserial esptool rich numpy
```

**6. Phone app and website dependencies**

```
cd mobile-app && npm ci && npm test && cd ..
cd website && npm ci && cd ..
```

---

## 13. Everyday commands

| Task | Command |
|---|---|
| Flash the ESP32 (USB) | `system/esp32/flash_esp32.sh` (optional port: `/dev/ttyUSB0`) |
| Watch the ESP32 | `~/.local/bin/arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=115200` (opening the port resets the board) |
| Install/refresh the Pi | copy `system/pi/` to the Pi (USB stick or `scp -r system/pi pi:`), then on the Pi: `sudo bash setup_pi.sh` |
| Pi service status / logs | `systemctl status ppg-relay` · `journalctl -u ppg-relay -f` |
| Pi dashboard | `ppg-monitor` (starts automatically at boot) |
| Pi Wi-Fi off / on | `sudo nmcli radio wifi off` · `sudo nmcli radio wifi on` |
| Laptop viewer | `system/laptop/run_viewer.sh` (via the Pi) · `--direct` (ESP32) · `--demo` (no hardware) |
| Python tests | `cd system && python3 -m unittest discover -s tests -v` |
| App tests + typecheck | `cd mobile-app && npm test && npm run typecheck` |
| Build the iPhone app | push the branch to the build repo → Actions → download `SmartWheelApp-unsigned-ipa` |
| Install on iPhone | `apploader` (opens iloader with the newest `.ipa` path on the clipboard) |
| Website locally | `cd website && npm run dev` → http://localhost:5173 |
| Deploy website | `cd website && npx vercel deploy --prod` |

---

## 14. Tests

| Suite | What it proves |
|---|---|
| `system/tests/test_protocol.py` (20 tests) | CRC check value; v2 and v3 round-trip; **every single-bit flip is detected**; deframing at any chunk size; resync after garbage and false headers; the Python decoder reads packets from the **compiled firmware encoder** and the Python encoder reproduces them byte for byte; the shared modules in `pi/` and `laptop/` match the master copy |
| `system/tests/test_vitals_host.cpp` | the heart-rate/SpO₂ estimator on 45 synthetic signals with known answers |
| `mobile-app/tests/protocol.test.ts` | the phone decodes packets from the compiled firmware encoder; bit flips; mixed v2/v3 streams at Bluetooth chunk sizes; the false-header look-ahead |
| `mobile-app/tests/codec.test.ts` | folding is lossless, handles edge cases, rejects corruption; reports the compression ratio |
| `mobile-app/tests/alerts.test.ts` | percentiles match Postgres; alert timing; "I'm OK" cooldown; escalation on no answer; spikes and dropouts don't trigger |
| `mobile-app/tests/shared-sync.test.ts` | the website's copy of the codec is byte-identical |
| SQL | `v3_dashboard.sql` was run twice on Postgres 17 (PGlite) with the Supabase roles, bucket and publication stubbed |

CI runs the app typecheck and unit tests on every build.

---

## 15. Measured results

| Measurement | Result |
|---|---|
| Acquisition window | 990–1003 ms per 100 samples, 0 FIFO overflows |
| Packet | v3, 100 samples, 472 bytes, 1 per second |
| Laptop link (bench) | 0 CRC errors, packets every 1.004 s |
| Heart-rate estimator vs Maxim (same pulse; reference 79–80 BPM) | estimator median 65, σ 3.3 · Maxim median 115 |
| Finger threshold evidence | finger ≈ 242 000 · object ≈ 50 400 · air ≈ 1 100 (IR counts) |
| Pi ↔ ESP32 with Pi Wi-Fi on (2.4 GHz) | repeated `0x3E` failures; the Pi heard the ESP32 at −80 to −93 dBm with a laptop in between |
| Pi ↔ ESP32 with Pi Wi-Fi off | connected and steady |
| Archive fold (synthetic, 2 min @ 100 Hz) | 96 KB → 22 KB (4.4×), lossless |

---

## 16. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Pi dashboard stuck on SCANNING / connecting then dropping | Wi-Fi/Bluetooth sharing on the Pi 5 or distance → turn Pi Wi-Fi off, keep the ESP32 within 1–2 m with nothing metal between |
| Pi Wi-Fi glitches when Bluetooth is on | same shared radio → use Ethernet for development, or Wi-Fi off |
| "phone relay unavailable … is Bluetooth on?" in the Pi log | Bluetooth was off → switch it on; the relay retries every 5 s by itself |
| ESP32 serial shows "MAX30102 not found" | wiring. Read the diagnostic line: no pull-ups = power/GND; pull-ups but no ACK = SDA/SCL swapped or wrong pins |
| ESP32 boot loop, "Checksum failed" | flashed at 80 MHz QIO → use `flash_esp32.sh` (40 MHz DIO) |
| App says "no longer available" | the 7-day free signing expired → reinstall with `apploader` |
| iPhone: "Untrusted Developer" | Settings → General → VPN & Device Management → trust your Apple ID |
| Website shows "Database needs the v3 update" | run `v3_dashboard.sql` |
| No finger / "Place your hand on the sensor" | the IR level is below 100 000; press a fingertip flat on the sensor |
| Packet line shows v2 · 8 samples | the ESP32 has old firmware → reflash |

---

## 17. Security status and before-real-data checklist

The current state is a **closed prototype**:

- Supabase row-level security is **permissive**. Anyone holding the
  publishable key, which ships inside the app and the website, can read and
  write every table and archive.
- The website is public at its Vercel URL.
- Bluetooth pairing uses "Just Works", with no passkey.

Before collecting real subject data:

1. Add Supabase Auth and replace the `prototype_all` policies with per-user
   policies (e.g. `auth.uid() = owner_id`), including the Storage bucket.
2. Put the website behind login (Supabase Auth), or Vercel Deployment
   Protection.
3. Bluetooth: bond the phone to the Pi, and require encryption on the relay's
   characteristics.
4. Consider client-side encryption of `.ppga` archives, with the key in the
   phone's Keychain.
5. Collect written consent, especially for "Vitals + full waveform".

---

## 18. How this maps to the proposal

| Proposal item | Status |
|---|---|
| PPG sensing on the wheel, ESP32 preprocessing, BPM/SpO₂ | ✅ MAX30102 + ESP32, estimator in §4 |
| Sensor polling 25–250 Hz | ✅ 100 Hz, all samples transmitted |
| Baseline acquisition 6–8 s | ✅ 8 s analysis window |
| Wireless ESP32 → Pi (BLE) | ✅ with CRC and end-to-end verification |
| Filter environmental and electrical noise | ✅ decimation, baseline removal, smoothing, finger gate, plausibility, 10-s median for alerts, percentile summaries |
| User profiles and baselines | ✅ driver picker, per-driver baseline (phone and cloud) |
| Real-time display | ✅ phone app, Pi dashboard, live website |
| Store processed, time-stamped data; raw not primary | ✅ vitals-only default; raw is opt-in and folded |
| Encryption and restricted permissions | ◐ TLS + AES-256 at rest (Supabase), owner-only files on the Pi; per-user access control is on the checklist in §17 |
| Alert → driver response → escalation | ✅ haptic prompt, 30-s window, escalation **simulated** (as specified) |
| Haptic / non-visual alert | ◐ phone vibration; a haptic motor in the wheel is future hardware |
| Website always available | ✅ Vercel |
| Pi touchscreen UI | ◐ the terminal dashboard runs on the Pi's screen; a touch GUI is future work |
| Multiple PPG sensing points | ◐ one sensor today; the protocol's per-packet sample count and flags leave room to add channels in a v4 |
| Machine-learning assessment | ◐ not yet; the 100 Hz raw archives are the training data it will need |

---

## 19. References

- Analog Devices / Maxim, *MAX30102 datasheet*, 19-7740 Rev 1 (2018):
  - SpO₂-mode sample rates vs pulse width (Table 11);
  - registers 0x08 FIFO_CONFIG and 0x0A SPO2_CONFIG;
  - 18-bit ADC and a 32-sample FIFO.

  https://www.analog.com/media/en/technical-documentation/data-sheets/MAX30102.pdf
- Choi A., Shin H., "Photoplethysmography sampling frequency: pilot assessment
  of how low can we go to analyze pulse rate variability with reliability?",
  *Physiol. Meas.* 38(3):586–600, 2017. https://pubmed.ncbi.nlm.nih.gov/28169836/
- Béres S., Holczer L., Hejjel L., "On the Minimal Adequate Sampling Frequency
  of the Photoplethysmogram for Pulse Rate Monitoring and Heart Rate
  Variability Analysis in Mobile and Wearable Technology", *Meas. Sci. Rev.*
  19(5):232–240, 2019. https://sciendo.com/article/10.2478/msr-2019-0030
- Bannajak K. et al., "Signal Acquisition-Independent Lossless
  Electrocardiogram Compression Using Adaptive Linear Prediction", *IJERPH*
  20(3):2753, 2023. https://pubmed.ncbi.nlm.nih.gov/36768118/
- IETF RFC 9639, *Free Lossless Audio Codec (FLAC)*, 2024 (fixed predictors +
  Rice coding). https://www.rfc-editor.org/rfc/rfc9639.txt
- Ruggiero P., Heckathorn M. A., *Data Backup Options*, US-CERT/CISA, 2012 (the
  3-2-1 rule). https://www.cisa.gov/sites/default/files/publications/data_backup_options.pdf
- Elgendi M., "Optimal Signal Quality Index for Photoplethysmogram Signals",
  *Bioengineering* 3(4):21, 2016. https://pubmed.ncbi.nlm.nih.gov/28952584/
- Bent B. et al., "Investigating sources of inaccuracy in wearable optical
  heart rate sensors", *npj Digit. Med.* 3:18, 2020. https://pubmed.ncbi.nlm.nih.gov/32047863/
- Supabase:
  - Security (AES-256 at rest, TLS): https://supabase.com/security
  - Realtime Postgres Changes: https://supabase.com/docs/guides/realtime/postgres-changes
- Apple, *Accessory Design Guidelines*, R30, §58 (Bluetooth LE connection
  parameters). https://developer.apple.com/accessories/Accessory-Design-Guidelines.pdf
- Bluetooth SIG, *Core Specification 6.0* (LE data length up to 251 octets;
  attribute values up to 512 octets).
- Infineon, *CYW43455 datasheet* §5.9 (shared-antenna Wi-Fi/Bluetooth
  coexistence).
- Raspberry Pi, "Introducing Raspberry Pi 5" (the CYW43455 combo chip).
  https://www.raspberrypi.com/news/introducing-raspberry-pi-5/

Two claims are engineering reasoning rather than cited findings:

- "Percentiles instead of min/max for summaries" follows from the artifact
  literature above but is not taken from a specific paper.
- "Wi-Fi on the Pi degrades our BLE link" is based on our own bench
  measurements (§15), not on a vendor statement.

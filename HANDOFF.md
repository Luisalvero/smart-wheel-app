# HANDOFF — context for an AI coding agent

You are picking up the **Biometric Steering Wheel** (FIU Senior Design, Team
18). Read this file first, then `docs/SYSTEM_GUIDE.md` for the full human
guide. Everything below is current as of **2026-09-21**, on branch
`luis/full-system`.

## 1. What the system is

A PPG pulse sensor on a steering wheel measures heart rate and SpO₂. Data
flows:

```
MAX30102 --I2C--> ESP32 --BLE--> Raspberry Pi 5 relay --BLE--> iPhone app (React Native/Expo)
   --HTTPS--> Supabase (Postgres + Realtime + Storage) --> website (Vite, on Vercel)
```

- In the car, only the phone has internet. The ESP32 and the Pi are
  Bluetooth-only. The Pi's Wi-Fi must be **off** in the car (see Gotchas).
- It is a prototype, not a medical device. Alerts use prototype thresholds,
  and escalation is simulated on purpose, per the proposal.

## 2. Repository map

```
system/                         hardware side (Python + Arduino C++)
  esp32/ppg_transmitter/        firmware: ppg_transmitter.ino, ppg_frame.h (packet encoder), ppg_vitals.h (HR/SpO2)
  esp32/flash_esp32.sh          compile + upload (FQBN esp32:esp32:esp32:FlashFreq=40,FlashMode=dio)
  common/ppg_protocol.py        MASTER protocol code; copies in pi/ and laptop/ must stay identical (tested)
  common/bluez_links.py         MASTER; same copy rule
  pi/ppg_relay.py               relay: ESP32 central (bleak) + GATT server for the phone (dbus-fast) + CSV logger
  pi/ppg_monitor.py             terminal dashboard (rich), reads /run/ppg-relay/state.json
  pi/setup_pi.sh                one-shot Pi installer (systemd unit ppg-relay, BlueZ [LE] params, venv from wheels/)
  laptop/ppg_viewer.py          PySide6 bench viewer (--demo, --direct)
  tests/                        python unittest + host-compiled C++ tests
mobile-app/                     Expo SDK 54 app (TypeScript)
  components/                   SmartWheelScreen (shell + global VoiceCheckModal), DriverPicker (create/edit, long-press),
                                DriveView, HistoryView, SettingsView (safety card, demo, voice), VoicePicker, ui, charts
  lib/ble/                      bleService.ts (auto-reconnect to Pi), protocol.ts (TS twin of the protocol)
  lib/hooks/useDriveSession.ts  THE integration point: BLE -> decode -> SQLite -> alerts -> live upload
  lib/db/                       database.ts (SQLite + migrations), repositories.ts (all SQL), liveSync.ts, sync.ts
  lib/archive/                  codec.ts (PPGA fold/unfold, pure), archiveStore.ts (fold a session, verify, store)
  lib/analysis/                 stats.ts, baseline.ts, profileModel.ts (Avram 2019 prior + NEWS2),
                                flagEngine.ts (notice/warning/critical, persistence → emergency; COPD oxygen vs own baseline, Little 1999),
                                rhythm.ts (Elgendi beats + Dash irregularity + Apple 5-of-6),
                                safetyController.ts (glue: frames → flags → voice check → drive_alerts)
  lib/voice/                    intent.ts + intentModel.ts (local yes/no/help classifier + safety rules),
                                voiceCheck.ts (dialogue policy), speechIO.ts (expo-speech + expo-speech-recognition)
  tools/intent/                 phrases.py (EN+ES training/test phrases), train.py, check.py
  supabase/                     schema.sql -> live.sql -> v3_dashboard.sql -> v4_flags.sql (run in this order)
  tests/                        node --test (TypeScript stripped natively; Node >= 22)
website/                        Vite + vanilla JS dashboard; src/lib/codec.ts is a byte-identical copy (tested)
.github/workflows/ios-build.yml unsigned IPA build on macOS runners (typecheck + tests + prebuild + xcodebuild)
docs/SYSTEM_GUIDE.md            human guide (setup on any distro, algorithms, references)
```

## 3. Contracts you must not break

- **Protocol v3 packet** (§5 of the guide):
  - 20-byte header, then n×36-bit {red, ir} LSB-first, then CRC-16/CCITT-FALSE
    (init 0xFFFF, check 0x29B1).
  - A 100-sample packet is 472 bytes. `seq` restarts at 0 on ESP32 reboot.
  - Any change must be made in **three places**: `ppg_frame.h`,
    `common/ppg_protocol.py` (then copy it into `pi/` and `laptop/`), and
    `mobile-app/lib/ble/protocol.ts`.
  - Then run both test suites. They decode packets from the compiled C++
    encoder.
  - Bump the version byte for incompatible changes. Decoders keep accepting
    v2.
- **The Pi forwards packets byte-for-byte.** The phone re-verifies the ESP32's
  CRC. Never re-encode in the relay.
- **BLE UUIDs:**
  - ESP32: Nordic UART, `6e400001/6e400003-b5a3-f393-e0a9-e50e24dcca9e`.
  - Relay service: `5b1e0001-7c2d-4f6a-9e3b-8a4c2d1f6e01`, with frames on
    `...0002` and status JSON on `...0003`.
  - Relay name: `PPG-Relay-Pi`.
- **Database:**
  - Phone-generated UUID primary keys; all uploads are idempotent upserts.
  - Local SQLite is the source of truth; `sync_status` goes `local` →
    `synced`.
  - Never delete local rows during sync.
  - SQLite migrations are additive only (`PRAGMA user_version`, now 4).
- **Supabase schema:** `mobile-app/supabase/v3_dashboard.sql` defines:
  - views `session_summaries` (p05/median/p95), `driver_baselines`
    (p10/median/p90, established at ≥ 60 readings) and `active_sessions`
    (heartbeat within 2 min);
  - tables `session_archives` and `drive_alerts`;
  - the private bucket `session-archives`.

  `v4_flags.sql` adds profile `conditions`/`medications`/`language`, a
  generated `bmi`, and alert `level`/`channel`/`answer_confidence`.

  The website and `liveSync.ts` rely on these names.
- **Percentiles:** linear interpolation, the same as Postgres
  `percentile_cont`. `lib/analysis/stats.ts` is tested to match.
- **PPGA archive format** (`lib/archive/codec.ts`):
  - Header: `PPGA`, version 1, codec 1.
  - Fixed predictors of order 0–3 per column, zigzag + LEB128, raw DEFLATE.
  - Raw DEFLATE is fflate `deflateSync/inflateSync`, not zlib or gzip.
  - The website copy must be byte-identical (`tests/shared-sync.test.ts`).
- **Data policy:**
  - Default storage mode is `vitals` (processed values only, per the
    proposal).
  - `full` mode keeps `raw_payload` only until the session ends. It is then
    folded, verified by unfolding, and cleared in one transaction.

- **Flag engine / voice check contract** (guide §11):
  - Levels come from NEWS2 plus the driver's personal band.
  - The confirmation window is 15 s (warning) or 8 s (critical). To become an
    emergency it needs ≥ 70 % coverage and ≥ 80 % of readings beyond the
    line.
  - The voice check only reacts to `emergency` events. It never reads
    vitals.
  - Transcripts are never stored.
  - The emergency contact never leaves the phone.
  - Answer model: "ok" needs P ≥ 0.75, "not_ok" P ≥ 0.5, and urgent words
    override. `tests/intent.test.ts` enforces **zero** not_ok→ok errors on
    the held-out set. If you retrain, keep it at zero.
  - **"I'm OK" learning** (`Ack` in flagEngine.ts): an OK answer to a
    WARNING-level heart-rate check moves that warning line to peak ± 5 BPM.
    It is capped at 125 and floored at 43, never applies to critical or
    oxygen, and is stored per driver as app_settings `ack:<profileId>`.
    Settings has a reset.
  - **COPD oxygen** is relative to the driver's awake baseline: warning at a
    fall of more than 4 points, critical at ≤ 85 % (Little 1999). Everyone
    else uses NEWS2 Scale 1.
  - **Demo** (`SafetyController.simulate`) plays fabricated readings through
    a *fresh* engine and runs the voice check in rehearsal mode. It must
    never save, upload or learn (tested in tests/safetyController.test.ts).
  - **Speech audio:** prompts use the iOS session playback / voicePrompt /
    duckOthers (loud, and they play even on silent); listening uses
    playAndRecord + defaultToSpeaker + Bluetooth. The voice choice is stored
    as app_settings `voice:en` / `voice:es`. Premium voices are detected by
    `.premium.` in the identifier, because expo-speech reports them as
    "Default".

## 4. Commands

```
# Python/protocol/C++ tests
cd system && python3 -m unittest discover -s tests -v
# App: typecheck + unit tests (needs g++ for the firmware-encoder test)
cd mobile-app && npm run typecheck && npm test
# Flash the ESP32 (needs human authorization; see Rules)
system/esp32/flash_esp32.sh /dev/ttyUSB0
# Website
cd website && npm run dev            # needs website/.env with VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY
cd website && npx vercel deploy --prod
# iPhone build: push the branch to the BUILD repo (remote "mine"), Actions builds the unsigned IPA
git push mine luis/full-system && gh run list -R Luisalvero/smart-wheel-app -L 1
# Sideload: `apploader` (wrapper around ~/smartwheel-pairing/iloader.AppImage)
```

Pi (user `wheel`; the SSH alias `pi` is in `~/.ssh/config` on the dev
laptop; files live in `~/PPG_Logger`):

```
systemctl status ppg-relay ; journalctl -u ppg-relay -f
sudo btmon                                     # HCI trace: disconnect reasons (0x3E = never established)
sudo nmcli radio wifi off|on
```

To deploy relay code: `scp system/pi/{ppg_relay,ppg_protocol,ppg_monitor,bluez_links}.py pi:PPG_Logger/`,
then `sudo systemctl restart ppg-relay`. Back up first. The previous deploy
left `~/PPG_Logger/backup-*`.

## 5. Gotchas (all measured, not guessed)

- **Pi 5 Wi-Fi and Bluetooth share one radio/antenna (CYW43455).**
  - With Wi-Fi on 2.4 GHz, ESP32 connections failed repeatedly with HCI 0x3E.
  - With Wi-Fi off, the link is steady. The car has no Wi-Fi.
  - On the bench, use Ethernet or accept flakiness.
  - A past attempt to force the Pi onto 5 GHz dropped it off the network. The
    5 GHz signal there was weak.
- **Distance and shielding.** The Pi heard the ESP32 at −93 dBm with a laptop
  between them. Keep them within 1–2 m with clear line of sight. The ESP32
  now transmits at +9 dBm.
- **Opening the ESP32 serial port resets the board** (DTR/RTS). Every serial
  read restarts `seq`.
- **The ESP32 must be flashed at 40 MHz DIO.** At 80 MHz QIO it boot-loops
  with "Checksum failed".
- **Use the direct FIFO reader.** SparkFun `getRed()/getIR()` block and
  return the newest sample (2.5× slow, and red/IR misaligned). Don't
  reintroduce them.
- **The Maxim HR algorithm over-reads** (median 115 vs 79–80 true). The
  firmware uses `ppg::estimate` (autocorrelation). Maxim is printed only for
  comparison.
- **The finger threshold is IR DC ≥ 100 000.** Measured: finger ≈ 242k,
  object ≈ 50.4k, air ≈ 1.1k.
- **dbus-fast in the relay:** do NOT add `from __future__ import annotations`
  to relay files. dbus-fast reads the annotations at runtime.
- **bleak 3.x:** don't use the private `_acquire_mtu`. It caused 3-second
  drops.
- **Killing processes:** `pkill -f` can match your own shell. Use `pgrep`
  with a command-name check.
- **Apple accessory guidelines** (R30 §58.6): supervision timeout 6–18 s;
  intervals are multiples of 15 ms. They apply to the phone↔Pi link, not the
  ESP32↔Pi link.
- **Hermes bundle inspection:** strings in the compiled bundle are UTF-16.
  Use `strings -e l` as well as `strings`.
- **Free Apple ID signing expires every 7 days.** Then the app says "no
  longer available" and must be reinstalled.
- **iOS 26 renamed** Accessibility → Spoken Content to **Read & Speak**
  (where Premium/Enhanced voices are downloaded).
- **Node:** tests use native TypeScript stripping, so no parameter properties
  or enums in files that tests import. Relative imports inside
  `lib/analysis` use explicit `.ts` extensions.

## 6. Current state

**Working and verified:**

- Firmware v3 is flashed: 472-byte packets, 100 samples each.
- The relay decodes v3 and runs on the Pi. It retries the phone-side service
  and backs off failed ESP32 connections. Scan duty cycle is 25%.
- The ESP32↔Pi link is steady with the Pi's Wi-Fi off.
- The website is deployed at https://smart-wheel-dashboard.vercel.app.
- `v3_dashboard.sql` was validated on Postgres 17 (PGlite).
- All unit tests pass: Python 20, TypeScript 42, C++ vitals.
- The iOS bundle compiles with Metro and Hermes.

**Not yet verified on real devices** (do these next):

0. The voice check on an iPhone:
   - permission prompts appear at drive start;
   - Settings → "Try the voice check" speaks, hears "yes" or "no" and
     classifies correctly;
   - in a car with road noise and Bluetooth audio.

1. The new iPhone build installed and run end to end with the Pi. Check that
   the phone receives 472-byte packets split across ~3 notifications.
2. `v3_dashboard.sql` applied on the real Supabase. The website shows a
   setup banner until it is.
3. A full-waveform drive:
   - it folds on the phone;
   - the archive uploads to Storage;
   - the website's "Unfold waveform" works, including the SHA-256 check.
4. The alert flow on a phone: haptic prompt, then a `drive_alerts` row, then
   the banner on the website.

**Known limitations / future work:**

- RLS is permissive (prototype); see guide §17.
- One sensor today; the proposal envisions several (would need protocol v4
  channels).
- No touch GUI on the Pi (the terminal dashboard only).
- Escalation is simulated; there are no emergency contacts in profiles yet.
- There is no machine-learning model yet.
- The Pi needs power-loss protection in the car.

## 7. Rules for agents on this project

- **Never push to the team repo** (`origin` = JosselinPonce/FIU-SeniorDesign)
  unless the owner explicitly asks. Build/CI happens on the owner's repo, git
  remote `mine` = `Luisalvero/smart-wheel-app`.
- **Hardware needs explicit human authorization, naming the exact target, for
  each occasion.** That covers flashing the ESP32, resets, and changing Pi
  network settings. Never change the Pi's Wi-Fi remotely without a guaranteed
  rollback: sudo-with-password and timers have failed before.
- **Never print or commit secrets:**
  - `website/.env`, `.env.local` and `.vercel/` are gitignored.
  - CI reads the Supabase URL/key from repo secrets.
  - Don't paste keys into chat or logs.
- **Only UI files need an explicit request.** The owner does not want
  unrequested HTML/CSS/UI edits; backend/data changes are fine.
- **Don't guess** pinouts, registers, electrical limits or RF behaviour. Use
  the MAX30102 datasheet and measurements (§5 above, guide §15).
- After changing shared code, run **both** test suites before shipping. Keep
  the `pi/` and `laptop/` copies of `common/*.py` identical.

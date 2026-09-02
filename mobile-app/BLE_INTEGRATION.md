# BLE + local database integration

Adds Bluetooth Low Energy telemetry capture and offline storage to the mobile
app. Proposed as a branch for review — **no existing file was rewritten.**

## What changed

**New files only:**

```
lib/ble/protocol.ts          payload parsing + UUIDs (no transport, no React)
lib/ble/bleService.ts        BLE transport via react-native-ble-plx
lib/db/database.ts           expo-sqlite schema
lib/db/repositories.ts       all SQL for profiles / sessions / telemetry
lib/hooks/useDriveSession.ts application state (BLE + parser + DB meet here)
components/SmartWheelScreen.tsx  drop-in UI
```

**Existing files touched — config only, no logic:**

| File | Change | Why |
|---|---|---|
| `package.json` | `+ react-native-ble-plx ^3.5.1` | added via `npx expo install`, so the version matches SDK 54 |
| `app.json` | BLE config plugin + iOS `NSBluetoothAlwaysUsageDescription` + Android `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` | iOS kills the app on first scan without a usage string |

**`App.tsx` and `lib/supabase.ts` are untouched.** The Supabase test screen still
works exactly as before.

To see the new screen, change one line in `App.tsx`:

```tsx
import SmartWheelScreen from './components/SmartWheelScreen';
export default function App() {
  return <SmartWheelScreen />;
}
```

## ⚠️ This needs a development build — Expo Go will not work

`react-native-ble-plx` is native code, and Expo Go only ships the modules Expo
bundles. The app currently runs in Expo Go **because it has no custom native
code**; adding BLE ends that.

```bash
npx expo prebuild            # generates ios/ and android/
npx expo run:ios             # requires macOS + Xcode
npx expo run:android         # works from Linux/Windows
# or a cloud build:
eas build --profile development --platform ios
```

There is no way around this. BLE cannot work in Expo Go on any framework — it
is an Apple/Expo constraint, not a library choice.

## Database schema

`expo-sqlite` was already a dependency and listed in `app.json` plugins but
**no code used it**. This is the first code that does.

```sql
driver_profiles  (id TEXT PK, display_name, created_at, updated_at)
drive_sessions   (id TEXT PK, profile_id FK, started_at, ended_at,
                  status, sync_status)
telemetry_events (id TEXT PK, session_id FK, sequence_number, event_type,
                  received_at, raw_payload, sync_status)

UNIQUE INDEX (session_id, sequence_number)   -- duplicate protection
```

Design decisions worth reviewing:

- **UUID primary keys, generated on the phone.** The same row can later be
  pushed to Supabase with the identical key — the sync step never has to invent
  replacement IDs, and re-sending is naturally idempotent.
- **Events are the data; the counter is a view.** The ping count is
  `SELECT COUNT(*)`, never a stored integer. That is what lets a `ping` row
  become a `vitals` row (BPM / SpO₂ / signal quality) with no schema change.
- **`received_at` is stamped on the phone** and is authoritative. The wheel's
  `sent_at` survives only inside `raw_payload`, so a bad clock on the hardware
  cannot corrupt the record.
- **`sync_status` stays `'local'`.** This layer does no networking at all, which
  is what guarantees a drive recorded in a parking garage is never lost.
  Supabase sync is a separate step and can read `WHERE sync_status = 'local'`.
- **Interrupted sessions are closed, not resumed.** Resuming would mean trusting
  that the wheel's sequence counter had not restarted, which the phone cannot
  verify. Telemetry is never deleted.

## BLE contract

Identical to the laptop simulator and to the future ESP32 firmware:

| | |
|---|---|
| Service UUID | `7a1f0001-6e2b-4c91-9d5a-2f3c4b5a6001` |
| Telemetry characteristic | `7a1f0002-6e2b-4c91-9d5a-2f3c4b5a6001` |
| Properties | `NOTIFY`, `READ` |
| Payload | UTF-8 JSON |

```json
{"protocol_version":1,"type":"ping","sequence":42,"sent_at":"2026-09-02T17:25:01.123Z"}
```

Future telemetry — already parsed correctly by `protocol.ts` today, verified
against real simulator output:

```json
{"protocol_version":1,"type":"vitals","sequence":1823,
 "bpm":78,"spo2":97,"signal_quality":91,"battery":84}
```

Unknown fields land in `TelemetryPacket.extra`, so the firmware can add a sensor
before the app is updated without breaking anything.

Discovery filters on the **service UUID**, not the device name: the name is
cosmetic and lives in the scan response, whereas the 128-bit service UUID is
what actually identifies a Smart Wheel peripheral — simulator or ESP32 alike.

## Testing against the laptop simulator

The simulator is a Python BLE peripheral (BlueZ) that pretends to be the
steering wheel. One SPACEBAR press = one BLE notification.

```bash
cd wheel_simulator && ./run_simulator.sh
```

Then in the app: create a driver → **CONNECT TO WHEEL** → **START SESSION** →
press SPACE on the laptop. The counter increments, and one row lands in
`telemetry_events` per press.

## Verification done so far

- `npx tsc --noEmit` passes under the project's `strict: true` config
- `protocol.ts` decodes real base64 payloads produced by the simulator's own
  Python module, including the future `vitals` shape
- Malformed input (garbage, missing `sequence`) is rejected rather than crashing
- `uuidv4()` output validated against the RFC 4122 v4 pattern

Not yet verified on hardware: the end-to-end link from a development build,
which needs the prebuild step above.

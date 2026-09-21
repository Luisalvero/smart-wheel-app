# Smart Wheel — live dashboard (website)

The web dashboard for the biometric steering wheel. Data path:
MAX30102 sensor → ESP32 → (BLE) Raspberry Pi relay → (BLE) iPhone app → Supabase → this site.

**Prototype — not for medical use.**

## What it shows

| Page | Route | What it does |
| --- | --- | --- |
| Live | `#/live` | One card per active drive (driver, live BPM and SpO₂, state pill, elapsed time, sparkline). New drives appear on their own via Realtime. With exactly one active drive it opens the focused view automatically: live BPM/SpO₂ charts for the last 10 minutes, the driver's usual range shaded behind the BPM line, an "outside usual range" note, and alert banners. When the drive ends the view turns into its summary. |
| Live (one drive) | `#/live/:sessionId` | The focused view for a specific drive. |
| Drives | `#/sessions` | Recorded drives, newest first, with a driver filter and "Load more". |
| Drive detail | `#/sessions/:sessionId` | Summary (realistic low/high = 5th/95th percentile, median, average, usable %), full BPM/SpO₂ charts (telemetry loaded in pages of 1000), alerts, and — if the drive has a full-waveform archive — **Unfold waveform** (download from Storage, SHA-256 check, unfold, plot red/IR). |
| Drivers | `#/drivers` | Each driver's baseline ("established" after 60 readings, otherwise "learning"). |
| Developer feed | `#/dev` | The team's original `test_readings` table with its live INSERT feed, plus a local `.ppga` archive inspector. |

The header shows the Realtime connection state (Live / Reconnecting…) and how long ago data last arrived.

## Setup

```bash
cd website
npm install
```

Create `website/.env` (it is git-ignored — never commit it):

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable/anon key>
```

```bash
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
npm run preview  # serve the build
```

## Database

Run these in the Supabase SQL editor (SQL Editor → New query → paste → Run), in order:

1. `mobile-app/supabase/schema.sql` — tables and the basic summary view.
2. `mobile-app/supabase/live.sql` — Realtime publication for sessions/telemetry.
3. `mobile-app/supabase/v3_dashboard.sql` — heartbeat columns, finger/quality, percentile summaries,
   `active_sessions`, `driver_baselines`, `drive_alerts`, `session_archives` and the private
   `session-archives` Storage bucket.

Until step 3 is run the site shows a "Database needs the v3 update" notice and degrades: live drives
fall back to `drive_sessions.status = 'active'` (hidden after 2 minutes without telemetry),
summaries show min/average/max, and baselines, alerts and waveform archives are unavailable.

## Code map

```
src/main.js               app shell, header indicators, hash router
src/supabase.js           Supabase client (reads the two VITE_ variables)
src/lib/data.js           every Supabase query (the DB contract lives here)
src/lib/schema.js         detects whether v3_dashboard.sql has been applied
src/lib/realtime.js       one shared Realtime channel + connection/freshness state
src/lib/live-store.js     in-memory state of active drives, fed by Realtime deltas
src/lib/charts.js         uPlot wrappers (vitals, waveform) and the card sparkline
src/lib/archive.js        download → SHA-256 verify → unfold (.ppga)
src/lib/codec.ts          BYTE-IDENTICAL copy of mobile-app/lib/archive/codec.ts — do not edit here
src/views/*.js            one module per page; mount() returns an unmount() cleanup
```

The `.ppga` codec uses **raw** DEFLATE; the site injects fflate's `deflateSync`/`inflateSync`
(not the zlib/gzip variants). If `mobile-app/lib/archive/codec.ts` changes, copy it over again unchanged.

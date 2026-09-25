-- Smart Wheel — v3: live dashboard, robust session stats, baselines, archives.
--
-- Run AFTER schema.sql and live.sql (SQL Editor → New query → paste → Run).
-- Safe to re-run: every statement is idempotent.
--
-- What this adds
--   * drive_sessions heartbeat (last_seen_at, link_state) so the dashboard can
--     tell "driving, sensor on" from "phone went quiet" without guessing.
--   * telemetry_events.finger / quality, so "no finger on the wheel" is visible.
--   * session_summaries v2: realistic low/high (5th/95th percentile) next to
--     the absolute min/max, which a single motion artifact can distort.
--   * driver_baselines: each driver's usual range from their finished drives
--     (proposal: baseline comparison per user profile).
--   * session_archives + the private 'session-archives' Storage bucket for the
--     compressed full-waveform "folded" archive (opt-in; see docs/ARCHIVE_FORMAT.md).
--   * Removes the test_readings bridge from live.sql: the dashboard now reads
--     the real tables directly.

-- --------------------------------------------------------------- sessions --
alter table public.drive_sessions add column if not exists last_seen_at   timestamptz;
alter table public.drive_sessions add column if not exists link_state     text;      -- 'streaming' | 'sensor_lost' | 'pi_lost'
alter table public.drive_sessions add column if not exists storage_mode   text not null default 'vitals'; -- 'vitals' | 'full'
alter table public.drive_sessions add column if not exists sample_rate_hz integer;

create index if not exists idx_sessions_active
  on public.drive_sessions (status, last_seen_at desc);

-- -------------------------------------------------------------- telemetry --
alter table public.telemetry_events add column if not exists finger  boolean;
alter table public.telemetry_events add column if not exists quality smallint;       -- 0..100 periodicity score from the ESP32

-- ------------------------------------------------------ session summaries --
-- Percentiles, not just min/max: PPG on a steering wheel picks up motion and
-- grip artifacts, and one bad second would otherwise define the "lowest" or
-- "highest" heart rate of a whole drive. p05/p95 are the realistic range;
-- min/max stay available for completeness.
drop view if exists public.session_summaries;
create view public.session_summaries
with (security_invoker = true) as
select
  s.id                                                        as session_id,
  s.profile_id,
  p.display_name,
  p.custom_id,
  s.started_at,
  s.ended_at,
  s.duration_seconds,
  s.status,
  s.storage_mode,
  s.last_seen_at,
  count(e.id)                                                 as frames,
  count(e.bpm)                                                as samples,
  round(100.0 * count(e.bpm) / nullif(count(e.id), 0), 1)     as usable_pct,
  min(e.bpm)                                                  as bpm_min,
  max(e.bpm)                                                  as bpm_max,
  round(avg(e.bpm), 1)                                        as bpm_avg,
  percentile_cont(0.05) within group (order by e.bpm)         as bpm_p05,
  percentile_cont(0.50) within group (order by e.bpm)         as bpm_median,
  percentile_cont(0.95) within group (order by e.bpm)         as bpm_p95,
  min(e.spo2)                                                 as spo2_min,
  max(e.spo2)                                                 as spo2_max,
  round(avg(e.spo2), 1)                                       as spo2_avg,
  percentile_cont(0.05) within group (order by e.spo2)        as spo2_p05,
  percentile_cont(0.50) within group (order by e.spo2)        as spo2_median,
  percentile_cont(0.95) within group (order by e.spo2)        as spo2_p95
from public.drive_sessions s
join public.driver_profiles p on p.id = s.profile_id
left join public.telemetry_events e on e.session_id = s.id
group by s.id, p.display_name, p.custom_id;

-- --------------------------------------------------------------- baselines --
-- A driver's usual range, from every usable reading in their finished drives.
-- Needs >= 60 readings (one minute) before it is reported as established.
-- Mirrors lib/analysis/baseline.ts on the phone, which computes the same
-- thing offline for in-car alerts. Not a medical reference range.
-- dropped first: a later migration changes the columns, and
-- "create or replace view" cannot remove a column on a re-run.
drop view if exists public.driver_baselines;
create view public.driver_baselines
with (security_invoker = true) as
select
  s.profile_id,
  count(e.bpm)                                              as readings,
  count(distinct s.id)                                      as sessions,
  percentile_cont(0.10) within group (order by e.bpm)       as bpm_p10,
  percentile_cont(0.50) within group (order by e.bpm)       as bpm_median,
  percentile_cont(0.90) within group (order by e.bpm)       as bpm_p90,
  percentile_cont(0.10) within group (order by e.spo2)      as spo2_p10,
  percentile_cont(0.50) within group (order by e.spo2)      as spo2_median,
  count(e.bpm) >= 60                                        as established
from public.drive_sessions s
join public.telemetry_events e on e.session_id = s.id
where s.status = 'completed' and e.bpm is not null
group by s.profile_id;

-- Active right now: an open session whose phone checked in recently. A session
-- whose phone died without ending it drops off after 2 minutes on its own.
-- dropped first: a later migration changes the columns, and
-- "create or replace view" cannot remove a column on a re-run.
drop view if exists public.active_sessions;
create view public.active_sessions
with (security_invoker = true) as
select s.id as session_id, s.profile_id, p.display_name, p.custom_id,
       s.started_at, s.last_seen_at, s.link_state, s.storage_mode, s.sample_rate_hz
from public.drive_sessions s
join public.driver_profiles p on p.id = s.profile_id
where s.status = 'active'
  and s.last_seen_at > now() - interval '2 minutes';

-- ---------------------------------------------------------------- archives --
create table if not exists public.session_archives (
  session_id     uuid primary key references public.drive_sessions (id) on delete cascade,
  format         text    not null,               -- 'PPGA'
  format_version integer not null,               -- 1
  sample_rate_hz integer not null,
  sample_count   integer not null,
  frame_count    integer not null,
  raw_bytes      integer not null,               -- size before folding (samples as 2 x u32)
  packed_bytes   integer not null,               -- size of the .ppga file
  sha256         text    not null,               -- of the .ppga file; checked on unfold
  storage_path   text    not null,               -- object key in bucket 'session-archives'
  created_at     timestamptz not null default now()
);

alter table public.session_archives enable row level security;
drop policy if exists prototype_all on public.session_archives;
create policy prototype_all on public.session_archives
  for all to anon, authenticated using (true) with check (true);

-- Private bucket: objects are only reachable through the API with a key, never
-- by a public URL.
insert into storage.buckets (id, name, public)
values ('session-archives', 'session-archives', false)
on conflict (id) do nothing;

-- Prototype policies, same stance as the tables in schema.sql: the publishable
-- key may read and write archives. Replace with per-user policies before real
-- subject data (see docs/SYSTEM_GUIDE.md, "Security").
drop policy if exists "archives prototype read"   on storage.objects;
drop policy if exists "archives prototype insert" on storage.objects;
drop policy if exists "archives prototype update" on storage.objects;
create policy "archives prototype read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'session-archives');
create policy "archives prototype insert" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'session-archives');
create policy "archives prototype update" on storage.objects
  for update to anon, authenticated using (bucket_id = 'session-archives')
  with check (bucket_id = 'session-archives');

-- ------------------------------------------------------------------ alerts --
-- Proposal alert-response flow: readings outside the driver's usual range for
-- a sustained period -> the phone prompts the driver (haptic + "Are you OK?")
-- -> "I'm OK" closes it; "Not well" or no answer in 30 s escalates. Escalation
-- is SIMULATED in this prototype (recorded, nobody is contacted), as the
-- proposal specifies for testing. Thresholds live in lib/analysis/alerts.ts.
create table if not exists public.drive_alerts (
  id            uuid primary key,
  session_id    uuid not null references public.drive_sessions (id) on delete cascade,
  kind          text not null,              -- 'bpm_high' | 'bpm_low' | 'spo2_low'
  value         numeric,                    -- 10-s median that triggered it
  threshold     numeric,                    -- the limit it crossed
  started_at    timestamptz not null,       -- first out-of-range reading
  prompted_at   timestamptz,                -- driver was asked
  response      text,                       -- 'ok' | 'unwell' | 'no_response' | null (open)
  responded_at  timestamptz,
  escalated     boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists idx_alerts_session on public.drive_alerts (session_id, started_at desc);
alter table public.drive_alerts enable row level security;
drop policy if exists prototype_all on public.drive_alerts;
create policy prototype_all on public.drive_alerts
  for all to anon, authenticated using (true) with check (true);

-- ---------------------------------------------------------------- realtime --
do $$
declare t text;
begin
  foreach t in array array['drive_sessions', 'telemetry_events', 'session_archives', 'drive_alerts'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------ retire the live.sql bridge --
drop trigger  if exists mirror_to_test_readings on public.telemetry_events;
drop function if exists public.mirror_to_test_readings();

-- ------------------------------------------------------------- cleanup --
-- Rows the retired bridge copied from our automated SELFTEST drives while the
-- dashboard was being verified. Only those exact labels; the team's own
-- test_readings rows are untouched.
delete from public.test_readings where device_name in ('SELFTEST BPM', 'SELFTEST SpO2');

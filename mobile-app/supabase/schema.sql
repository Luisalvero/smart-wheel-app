-- Smart Wheel — Supabase schema
--
-- Run this in the Supabase dashboard: SQL Editor → New query → paste → Run.
--
-- Primary keys are UUIDs generated on the phone, NOT database defaults. That is
-- deliberate: a drive is recorded offline and uploaded later, so the id must
-- exist before the row ever reaches Postgres. It also makes uploads idempotent —
-- re-sending after a failed sync upserts the same row instead of duplicating it.

-- ---------------------------------------------------------------- profiles --
create table if not exists public.driver_profiles (
  id            uuid primary key,
  custom_id     text,                    -- team-assigned code, e.g. SUBJ-001
  display_name  text not null,
  weight_kg     numeric(5,2),
  age           integer check (age is null or (age > 0 and age < 130)),
  height_cm     numeric(5,2),
  gender        text check (
                  gender is null
                  or gender in ('male','female','other','prefer_not_to_say')
                ),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_profiles_custom_id
  on public.driver_profiles (custom_id);

-- ---------------------------------------------------------------- sessions --
create table if not exists public.drive_sessions (
  id               uuid primary key,
  profile_id       uuid not null references public.driver_profiles (id)
                     on delete cascade,
  started_at       timestamptz not null,
  ended_at         timestamptz,
  -- Stored rather than derived so reports and charts need no date arithmetic.
  duration_seconds integer,
  status           text not null default 'completed',
  uploaded_at      timestamptz not null default now()
);

create index if not exists idx_sessions_profile
  on public.drive_sessions (profile_id);
create index if not exists idx_sessions_started
  on public.drive_sessions (started_at desc);

-- --------------------------------------------------------------- telemetry --
-- One row per sample. Storing every reading rather than a summary is what lets
-- the dashboard draw a real time series and lets stats be recomputed later.
create table if not exists public.telemetry_events (
  id              uuid primary key,
  session_id      uuid not null references public.drive_sessions (id)
                    on delete cascade,
  sequence_number integer,
  event_type      text not null,          -- 'ping' | 'vitals'
  bpm             integer,
  spo2            integer,
  signal_quality  integer,
  battery         integer,
  -- Measured by the phone on arrival. The wheel's own clock is not trusted.
  received_at     timestamptz not null,
  uploaded_at     timestamptz not null default now(),
  -- The wheel's sequence numbers restart when it reboots, so uniqueness is
  -- scoped per session. This is what makes a repeated upload harmless.
  unique (session_id, sequence_number)
);

create index if not exists idx_telemetry_session
  on public.telemetry_events (session_id);
create index if not exists idx_telemetry_received
  on public.telemetry_events (session_id, received_at);

-- ------------------------------------------------------- convenience views --
-- Per-session physiological summary, for the dashboard.
create or replace view public.session_summaries as
select
  s.id                         as session_id,
  s.profile_id,
  p.display_name,
  p.custom_id,
  s.started_at,
  s.ended_at,
  s.duration_seconds,
  count(e.bpm)                 as samples,
  min(e.bpm)                   as bpm_min,
  max(e.bpm)                   as bpm_max,
  round(avg(e.bpm), 1)         as bpm_avg,
  min(e.spo2)                  as spo2_min,
  max(e.spo2)                  as spo2_max,
  round(avg(e.spo2), 1)        as spo2_avg
from public.drive_sessions s
join public.driver_profiles p on p.id = s.profile_id
left join public.telemetry_events e on e.session_id = s.id
group by s.id, p.display_name, p.custom_id;

-- ------------------------------------------------------------------- RLS ---
-- Supabase exposes tables through PostgREST using the publishable/anon key,
-- which ships inside the mobile app and must be treated as public. Row Level
-- Security is therefore the ONLY thing standing between that key and your data.
--
-- The policies below are permissive: they let any anon caller read and write.
-- That is acceptable for a closed prototype but is NOT safe for real subject
-- data — anyone who extracts the key from the app can read every record.
--
-- Before collecting real physiological data, add authentication and replace
-- these with per-user policies (e.g. `auth.uid() = owner_id`).
alter table public.driver_profiles  enable row level security;
alter table public.drive_sessions   enable row level security;
alter table public.telemetry_events enable row level security;

drop policy if exists prototype_all on public.driver_profiles;
create policy prototype_all on public.driver_profiles
  for all to anon, authenticated using (true) with check (true);

drop policy if exists prototype_all on public.drive_sessions;
create policy prototype_all on public.drive_sessions
  for all to anon, authenticated using (true) with check (true);

drop policy if exists prototype_all on public.telemetry_events;
create policy prototype_all on public.telemetry_events
  for all to anon, authenticated using (true) with check (true);

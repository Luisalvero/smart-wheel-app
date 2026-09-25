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

-- The table may already exist in an older shape (the legacy app's profiles,
-- or an earlier version of this schema), in which case "create table if not
-- exists" above did nothing. Add whatever is missing before anything indexes
-- or selects it. Constraints are deliberately NOT retrofitted: existing rows
-- may hold values our CHECKs would reject, e.g. free-text gender.
alter table public.driver_profiles add column if not exists custom_id    text;
alter table public.driver_profiles add column if not exists display_name text;
alter table public.driver_profiles add column if not exists weight_kg    numeric(5,2);
alter table public.driver_profiles add column if not exists age          integer;
alter table public.driver_profiles add column if not exists height_cm    numeric(5,2);
alter table public.driver_profiles add column if not exists gender       text;
alter table public.driver_profiles add column if not exists created_at   timestamptz not null default now();
alter table public.driver_profiles add column if not exists updated_at   timestamptz not null default now();

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

-- Same for an older drive_sessions.
alter table public.drive_sessions add column if not exists profile_id       uuid;
alter table public.drive_sessions add column if not exists started_at       timestamptz;
alter table public.drive_sessions add column if not exists ended_at         timestamptz;
alter table public.drive_sessions add column if not exists duration_seconds integer;
alter table public.drive_sessions add column if not exists status           text not null default 'completed';
alter table public.drive_sessions add column if not exists uploaded_at      timestamptz not null default now();

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

-- Same for an older telemetry_events. The (session_id, sequence_number)
-- uniqueness is what makes a repeated upload harmless, so add it if the older
-- table lacks it - unless existing rows already break it, in which case say so
-- and carry on rather than failing the whole migration.
alter table public.telemetry_events add column if not exists sequence_number integer;
alter table public.telemetry_events add column if not exists event_type      text;
alter table public.telemetry_events add column if not exists bpm             integer;
alter table public.telemetry_events add column if not exists spo2            integer;
alter table public.telemetry_events add column if not exists signal_quality  integer;
alter table public.telemetry_events add column if not exists battery         integer;
alter table public.telemetry_events add column if not exists received_at     timestamptz not null default now();
alter table public.telemetry_events add column if not exists uploaded_at     timestamptz not null default now();
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.telemetry_events'::regclass
                    and contype = 'u'
                    and pg_get_constraintdef(oid) like '%(session_id, sequence_number)%') then
    alter table public.telemetry_events
      add constraint telemetry_events_session_id_sequence_number_key
      unique (session_id, sequence_number);
  end if;
exception when others then
  raise notice 'could not add the (session_id, sequence_number) uniqueness: %', sqlerrm;
end $$;

create index if not exists idx_telemetry_session
  on public.telemetry_events (session_id);
create index if not exists idx_telemetry_received
  on public.telemetry_events (session_id, received_at);

-- ------------------------------------------------------- convenience views --
-- Per-session physiological summary, for the dashboard.
-- dropped first: a later migration changes the columns, and
-- "create or replace view" cannot remove a column on a re-run.
drop view if exists public.session_summaries;
create view public.session_summaries as
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

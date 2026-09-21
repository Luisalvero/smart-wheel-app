-- Smart Wheel — v7: adaptation history.
--
-- Run after v6_quality.sql (SQL Editor → New query → paste → Run). Safe to re-run.
--
-- One row each time the phone recomputes a driver's thresholds and they
-- changed (after a drive, an "I'm OK" answer, a profile edit, a reset), so
-- the team can see the system learning each driver over time: how much it
-- relies on their own data (learned 0..1), their expected heart rate
-- (mean ± sd) and the warning lines themselves.

create table if not exists public.threshold_history (
  id          uuid primary key,
  profile_id  uuid not null references public.driver_profiles (id) on delete cascade,
  at          timestamptz not null,
  reason      text not null,          -- 'drive' | 'ok_answer' | 'profile' | 'reset'
  drives      integer not null,
  learned     numeric(4,3) not null,
  mean        numeric(5,1) not null,
  sd          numeric(4,1) not null,
  high_warn   integer not null,
  low_warn    integer not null,
  spo2_warn   integer not null
);
create index if not exists idx_history_profile on public.threshold_history (profile_id, at);

alter table public.threshold_history enable row level security;
drop policy if exists prototype_all on public.threshold_history;
create policy prototype_all on public.threshold_history
  for all to anon, authenticated using (true) with check (true);

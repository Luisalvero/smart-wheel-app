-- Smart Wheel — v4: profile-aware flags and the voice check.
--
-- Run AFTER schema.sql, live.sql and v3_dashboard.sql (SQL Editor → New
-- query → paste → Run). Safe to re-run.
--
-- What this adds
--   * driver_profiles: conditions, medications (text arrays of the keys in
--     mobile-app/lib/analysis/profileModel.ts), voice-check language, and a
--     BMI the database computes itself from weight and height.
--     The emergency contact is intentionally NOT stored here: it stays on the
--     phone, which is what escalates.
--   * drive_alerts: level ('notice' | 'warning' | 'critical'), the channel the
--     driver answered through ('voice' | 'button' | 'none') and the answer
--     classifier's confidence. Transcripts are never uploaded.
--     `response` now also takes 'recovered' (the reading came back before
--     confirmation) and 'unconfirmed' (signal too poor to confirm), and
--     `kind` also 'no_contact' and 'irregular_rhythm'.

alter table public.driver_profiles add column if not exists conditions  text[] not null default '{}';
alter table public.driver_profiles add column if not exists medications text[] not null default '{}';
alter table public.driver_profiles add column if not exists language    text   not null default 'en';
alter table public.driver_profiles add column if not exists bmi numeric(4,1)
  generated always as (
    case when weight_kg > 0 and height_cm > 0
         then round(weight_kg / ((height_cm / 100.0) * (height_cm / 100.0)), 1)
    end
  ) stored;

alter table public.drive_alerts add column if not exists level             text;
alter table public.drive_alerts add column if not exists channel           text;
alter table public.drive_alerts add column if not exists answer_confidence numeric;

create index if not exists idx_alerts_level on public.drive_alerts (level, started_at desc);

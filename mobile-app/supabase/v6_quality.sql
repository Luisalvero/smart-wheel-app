-- Smart Wheel — v6: per-second signal-quality labels and personal calibration.
--
-- Run after v5_delete.sql (SQL Editor → New query → paste → Run). Safe to re-run.
--
-- Every reading now carries the phone's own analysis of the 100 Hz waveform
-- (mobile-app/lib/analysis/signal.ts), so the dataset says how trustworthy
-- each second was:
--   hr_beats    heart rate from the individual beats (independent of the ESP32)
--   sqi_good    clean pulse (Orphanidou 2015 feasibility + template match)
--               AND the two heart-rate estimates agree
--   template_r  mean beat-to-template correlation (0..1)
--   perfusion   perfusion index, AC/DC × 100 (%)
--   skewness    skewness of the band-passed window (Elgendi 2016 SQI)
-- Personal calibration against a reference device (see the guide, §11):
--   cal_hr / cal_spo2   bounded offsets applied by the phone; cal_at when set.

alter table public.telemetry_events add column if not exists hr_beats   numeric(5,1);
alter table public.telemetry_events add column if not exists sqi_good   boolean;
alter table public.telemetry_events add column if not exists template_r numeric(4,3);
alter table public.telemetry_events add column if not exists perfusion  numeric(6,3);
alter table public.telemetry_events add column if not exists skewness   numeric(6,3);

alter table public.driver_profiles add column if not exists cal_hr   numeric(4,1);
alter table public.driver_profiles add column if not exists cal_spo2 numeric(4,1);
alter table public.driver_profiles add column if not exists cal_at   timestamptz;

-- Baselines from clean seconds only: the view now ignores readings the phone
-- judged unreliable (sqi_good = false). Rows from older app versions have no
-- label (null) and still count.
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
where s.status = 'completed' and e.bpm is not null and e.sqi_good is not false
group by s.profile_id;

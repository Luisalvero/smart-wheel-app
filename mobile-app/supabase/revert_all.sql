-- Smart Wheel - REVERT EVERYTHING (Team 18)
--
-- Puts the database back the way the team had it before this project's
-- changes: it removes every table, view, trigger, function, policy and
-- storage object that our migrations created, and nothing else.
--
-- WHAT IT KEEPS
--   * public.test_readings  - the team's original table, untouched
--   * every other object we did not create
--
-- WHAT IT DELETES, PERMANENTLY
--   * driver_profiles, drive_sessions, telemetry_events, drive_alerts,
--     session_archives, threshold_history  - and ALL rows in them
--     (every driver, drive and reading the app ever uploaded)
--   * the views session_summaries, driver_baselines, active_sessions
--   * the mirror trigger and function that copied readings into test_readings
--   * the session-archives storage bucket AND the waveform files inside it
--
-- There is no undo. Take a backup first if the data matters:
--   Supabase dashboard -> Database -> Backups, or
--   pg_dump 'postgres://...' -f backup.sql
--
-- To put everything back afterwards, run apply_all.sql.
--
-- Safe to run twice: every statement is guarded with "if exists".
-- How to run: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.

begin;

-- 1. Stop realtime broadcasting our tables. (Dropping a table removes it from
--    the publication anyway; this keeps the order tidy and is harmless if the
--    publication or the table is already gone.)
do $$
declare t text;
begin
  foreach t in array array['drive_sessions', 'telemetry_events'] loop
    if exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime'
                 and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end $$;

-- 2. The bridge into the team's test_readings table (added in live.sql and
--    already removed by v3_dashboard.sql; dropped here too in case only the
--    earlier migrations were run).
drop trigger  if exists mirror_to_test_readings on public.telemetry_events;
drop function if exists public.mirror_to_test_readings();

-- 3. Views first: they depend on the tables below.
drop view if exists public.active_sessions;
drop view if exists public.driver_baselines;
drop view if exists public.session_summaries;

-- 4. Tables, children before parents. CASCADE also removes their indexes,
--    row-level-security policies, constraints and any view we missed.
drop table if exists public.threshold_history cascade;
drop table if exists public.drive_alerts      cascade;
drop table if exists public.session_archives  cascade;
drop table if exists public.telemetry_events  cascade;
drop table if exists public.drive_sessions    cascade;
drop table if exists public.driver_profiles   cascade;

-- 5. Storage policies we added for the archive bucket.
drop policy if exists "archives prototype read"   on storage.objects;
drop policy if exists "archives prototype insert" on storage.objects;
drop policy if exists "archives prototype update" on storage.objects;
drop policy if exists "archives prototype delete" on storage.objects;

-- 6. The archive bucket and the files in it. This is the destructive step:
--    the folded waveform archives are deleted here. Delete these three
--    statements if you want to keep the bucket and its files.
delete from storage.objects where bucket_id = 'session-archives';
delete from storage.buckets where id = 'session-archives';

commit;

-- 7. Check: this should list only the team's own tables. Anything of ours
--    still showing means a statement above did not run.
select table_name, table_type
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('driver_profiles','drive_sessions','telemetry_events',
                      'session_archives','drive_alerts','threshold_history',
                      'session_summaries','driver_baselines','active_sessions')
 order by table_name;
-- Expected result: "no rows returned".

-- 8. OPTIONAL, and NOT done automatically: while live.sql was in place, the
--    mirror trigger inserted rows into the team's public.test_readings, named
--    "<driver> BPM" and "<driver> SpO2". They are the team's data now and we
--    cannot tell them apart from rows their own app wrote, so they are left
--    alone. Look first:
--
--    select device_name, count(*), min(created_at), max(created_at)
--      from public.test_readings
--     where device_name like '% BPM' or device_name like '% SpO2'
--     group by device_name order by device_name;
--
--    Then, only if those rows are all ours, delete them:
--
--    delete from public.test_readings
--     where device_name like '% BPM' or device_name like '% SpO2';

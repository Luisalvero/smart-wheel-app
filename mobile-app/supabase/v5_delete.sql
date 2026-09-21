-- Smart Wheel — v5: let the app delete what it uploaded.
--
-- Run after v4_flags.sql (SQL Editor → New query → paste → Run). Safe to re-run.
--
-- The tables already allow deletes (prototype_all policy in schema.sql /
-- v3_dashboard.sql, and ON DELETE CASCADE from driver_profiles down to
-- drive_sessions, telemetry_events, drive_alerts and session_archives). What
-- was missing is permission to remove the waveform archive files from
-- Storage, so a deleted driver's .ppga files would otherwise stay behind.
--
-- Prototype policy, same stance as the others: replace with per-user policies
-- before real subject data (docs/SYSTEM_GUIDE.md, "Security").

drop policy if exists "archives prototype delete" on storage.objects;
create policy "archives prototype delete" on storage.objects
  for delete to anon, authenticated using (bucket_id = 'session-archives');

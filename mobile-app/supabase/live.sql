-- Smart Wheel — live dashboard support. Run AFTER schema.sql
-- (Supabase dashboard: SQL Editor → New query → paste → Run). Safe to re-run.

-- 1. Realtime: broadcast new rows so the website updates without refreshing.
do $$
declare t text;
begin
  foreach t in array array['drive_sessions', 'telemetry_events'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 2. Bridge for the current website, which only reads public.test_readings
--    (value, device_name). Every usable reading the phone uploads is mirrored
--    there as two rows: "<subject> BPM" and "<subject> SpO2".
--    Any failure here is swallowed: the mirror must never block the real
--    telemetry insert. Remove with:
--      drop trigger if exists mirror_to_test_readings on public.telemetry_events;
create or replace function public.mirror_to_test_readings()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if new.bpm is null or new.spo2 is null then return new; end if;
  select coalesce(nullif(p.custom_id, ''), p.display_name) into who
    from drive_sessions s join driver_profiles p on p.id = s.profile_id
   where s.id = new.session_id;
  begin
    insert into test_readings (value, device_name)
    values (new.bpm,  coalesce(who, 'wheel') || ' BPM'),
           (new.spo2, coalesce(who, 'wheel') || ' SpO2');
  exception when others then
    raise warning 'mirror_to_test_readings skipped: %', sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists mirror_to_test_readings on public.telemetry_events;
create trigger mirror_to_test_readings
  after insert on public.telemetry_events
  for each row execute function public.mirror_to_test_readings();

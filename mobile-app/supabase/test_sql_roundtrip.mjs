// Proves apply_all.sql and revert_all.sql do what they claim, on real Postgres
// (PGlite = Postgres 18 compiled to WebAssembly, no server to install).
//
//   cd mobile-app && npm i -D @electric-sql/pglite && npm run test:sql
//
// It stands up a database the way the team had it (their test_readings table,
// the storage schema, the realtime publication, the anon/authenticated roles),
// applies everything twice, inserts a drive and reads the views, then reverts
// twice and checks the database is byte-for-byte back to the original object
// list -- with the team's table and any other storage bucket untouched.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const SQL = new URL('.', import.meta.url).pathname
const db = await PGlite.create()
const q = async (s) => (await db.query(s)).rows
const objects = async () => (await q(`
  select table_name as n, table_type as t from information_schema.tables
   where table_schema in ('public') order by 1`)).map(r => `${r.t === 'VIEW' ? 'view' : 'table'} ${r.n}`)
const policies = async () => (await q(
  `select schemaname||'.'||tablename||': '||policyname as p from pg_policies order by 1`)).map(r => r.p)

// ---- the database as the team had it, before anything of ours
await db.exec(`
  create role anon; create role authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id serial primary key, bucket_id text, name text);
  alter table storage.objects enable row level security;
  create publication supabase_realtime;
  create table public.test_readings (
    id serial primary key, value numeric, device_name text,
    created_at timestamptz not null default now());
  insert into public.test_readings (value, device_name) values (72, 'team bench');
`)
const before = { obj: await objects(), pol: await policies() }
console.log('ORIGINAL   :', before.obj.join(', '))

// ---- apply, twice (it must be safe to re-run)
const apply = readFileSync(`${SQL}/apply_all.sql`, 'utf8')
for (const pass of [1, 2]) {
  try { await db.exec(apply) } catch (e) { console.error(`APPLY pass ${pass} FAILED:`, e.message); process.exit(1) }
}
const after = { obj: await objects(), pol: await policies() }
console.log('AFTER APPLY:', after.obj.join(', '))
console.log('POLICIES   :', after.pol.length, 'rows')

// ---- does it actually work? insert a drive and read the views
try { await db.exec(`
  insert into public.driver_profiles (id, custom_id, display_name)
    values ('11111111-1111-1111-1111-111111111111', 'luis', 'Luis');
  insert into public.drive_sessions (id, profile_id, started_at, status)
    values ('22222222-2222-2222-2222-222222222222',
            '11111111-1111-1111-1111-111111111111', now(), 'completed');
  insert into public.telemetry_events
      (id, session_id, event_type, received_at, sequence_number, bpm, spo2, finger, quality, sqi_good)
    values (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'vitals', now(), 1, 72, 98, true, 90, true),
           (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'vitals', now(), 2, 74, 97, true, 88, true);
  insert into public.threshold_history
      (id, profile_id, at, reason, drives, learned, mean, sd, high_warn, low_warn, spo2_warn)
    values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', now(), 'drive',
            3, 0.300, 74.0, 6.0, 110, 45, 92);
`) } catch (e) { console.error('SAMPLE DATA FAILED:', e.message); process.exit(1) }
const cols = async (v) => (await q(`select column_name from information_schema.columns
   where table_schema='public' and table_name='${v}' order by ordinal_position`)).map(r => r.column_name)
const s = await q('select count(*)::int as n from public.session_summaries')
const b = await q('select count(*)::int as n from public.driver_baselines')
const a = await q('select count(*)::int as n from public.active_sessions')
console.log('VIEW COLS  : session_summaries', (await cols('session_summaries')).length,
            '| driver_baselines', (await cols('driver_baselines')).length,
            '| active_sessions', (await cols('active_sessions')).length)
console.log('VIEW ROWS  : summaries', s[0].n, 'baselines', b[0].n, 'active', a[0].n)
await db.exec(`insert into storage.buckets (id, name, public) values ('x','x',false) on conflict do nothing;
               insert into storage.objects (bucket_id, name) values ('session-archives','a.ppga');`)

// ---- revert, twice
const revert = readFileSync(`${SQL}/revert_all.sql`, 'utf8')
for (const pass of [1, 2]) {
  try { await db.exec(revert) } catch (e) { console.error(`REVERT pass ${pass} FAILED:`, e.message); process.exit(1) }
}
const end = { obj: await objects(), pol: await policies() }
console.log('AFTER REVRT:', end.obj.join(', '))

// ---- verdicts
const same = JSON.stringify(end.obj) === JSON.stringify(before.obj)
const polSame = JSON.stringify(end.pol) === JSON.stringify(before.pol)
const team = await q(`select count(*)::int as n from public.test_readings`)
const bucket = await q(`select count(*)::int as n from storage.buckets where id='session-archives'`)
const files = await q(`select count(*)::int as n from storage.objects where bucket_id='session-archives'`)
const other = await q(`select count(*)::int as n from storage.buckets where id='x'`)
console.log('\nRESULTS')
console.log(' objects back to original :', same ? 'PASS' : 'FAIL ' + JSON.stringify(end.obj))
console.log(' policies back to original:', polSame ? 'PASS' : 'FAIL ' + JSON.stringify(end.pol))
console.log(' team test_readings kept  :', team[0].n === 1 ? 'PASS (1 row)' : 'FAIL ' + team[0].n)
console.log(' archive bucket removed   :', bucket[0].n === 0 ? 'PASS' : 'FAIL')
console.log(' archive files removed    :', files[0].n === 0 ? 'PASS' : 'FAIL')
console.log(' other buckets untouched  :', other[0].n === 1 ? 'PASS' : 'FAIL')
process.exit(same && polSame && team[0].n === 1 && !bucket[0].n && !files[0].n && other[0].n === 1 ? 0 : 1)

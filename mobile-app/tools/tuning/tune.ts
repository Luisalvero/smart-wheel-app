/**
 * Team tuning report: learns from EVERYONE's labelled drives how well the
 * algorithm is doing on our sensor, and recommends changes. It never changes
 * the app -- a person reviews the report and edits the constants.
 *
 *   cd mobile-app
 *   node tools/tuning/tune.ts            # reads Supabase (website/.env or env vars)
 *   node tools/tuning/tune.ts --demo     # synthetic dataset, to see the report
 *
 * Credentials: SUPABASE_URL + SUPABASE_KEY in the environment, or the
 * VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY in website/.env.
 * Output: printed, and written to tools/tuning/report.md (gitignored; it
 * contains no names, drivers are numbered).
 *
 * Sections
 *  1. Dataset: drivers, drives, hours, share of clean seconds (sqi_good).
 *  2. Estimator agreement: ESP32 heart rate vs the phone's beat heart rate,
 *     Bland–Altman bias and 95 % limits of agreement (Bland & Altman 1986),
 *     MAPE vs the ±10 % consumer standard.
 *  3. Weak-pulse cut-off for OUR sensor: perfusion index as a predictor of a
 *     clean second (sqi_good); the cut-off with the best Youden J, and AUC.
 *     The research said published cut-offs don't transfer to a MAX30102.
 *  4. Alerts in practice: episodes by kind/level/outcome, emergencies per 10
 *     driving hours, share answered "I'm OK" (a false-alarm proxy).
 *  5. Replay: every drive through the real FlagEngine with alternative
 *     confirmation windows and with / without the quality gate, compared with
 *     what the drivers actually answered.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

import { FlagEngine, thresholds, type Reading } from '../../lib/analysis/flagEngine.ts';
import { personalBand, profilePrior, type Sex } from '../../lib/analysis/profileModel.ts';

type Profile = { id: string; age: number | null; gender: string | null; weight_kg: number | null; height_cm: number | null; conditions?: string[]; medications?: string[] };
type Session = { id: string; profile_id: string; started_at: string; ended_at: string | null; status: string };
type Tele = { session_id: string; received_at: string; bpm: number | null; spo2: number | null; finger: boolean | null; quality: number | null; hr_beats: number | null; sqi_good: boolean | null; perfusion: number | null };
type Alert = { session_id: string; kind: string; level: string | null; response: string | null; started_at: string };
type Data = { profiles: Profile[]; sessions: Session[]; telemetry: Tele[]; alerts: Alert[] };

const HERE = import.meta.dirname;

// ------------------------------------------------------------------ data --
async function fromSupabase(): Promise<Data> {
  let url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_KEY;
  const envFile = join(HERE, '..', '..', '..', 'website', '.env');
  if ((!url || !key) && existsSync(envFile)) {
    const env = Object.fromEntries(
      readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]),
    );
    url ??= env.VITE_SUPABASE_URL;
    key ??= env.VITE_SUPABASE_PUBLISHABLE_KEY;
  }
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_KEY, or create website/.env');
  const sb = createClient(url, key);
  const all = async <T,>(table: string, cols: string, optional = false): Promise<T[]> => {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
      if (error) {
        if (optional) return out;
        // Older schema: retry with the columns every version has.
        if (/column|schema cache/i.test(error.message) && table === 'telemetry_events') {
          return all<T>(table, 'session_id, received_at, bpm, spo2', true);
        }
        throw new Error(`${table}: ${error.message}`);
      }
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < 1000) return out;
    }
  };
  return {
    profiles: await all<Profile>('driver_profiles', '*'),
    sessions: await all<Session>('drive_sessions', 'id, profile_id, started_at, ended_at, status'),
    telemetry: await all<Tele>('telemetry_events', 'session_id, received_at, bpm, spo2, finger, quality, hr_beats, sqi_good, perfusion'),
    alerts: await all<Alert>('drive_alerts', 'session_id, kind, level, response, started_at', true),
  };
}

/** Synthetic team: 3 drivers × 12 drives × 10 min, with artifacts, weak-pulse
 *  stretches, and two real tachycardia episodes. */
function demo(): Data {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const profiles: Profile[] = [
    { id: 'p1', age: 24, gender: 'male', weight_kg: 75, height_cm: 180 },
    { id: 'p2', age: 52, gender: 'female', weight_kg: 70, height_cm: 165, conditions: ['hypertension'] },
    { id: 'p3', age: 67, gender: 'male', weight_kg: 90, height_cm: 175 },
  ];
  const usual = { p1: 68, p2: 78, p3: 66 } as Record<string, number>;
  const sessions: Session[] = [];
  const telemetry: Tele[] = [];
  const alerts: Alert[] = [];
  const t0 = Date.parse('2026-08-01T08:00:00Z');
  for (const p of profiles) {
    for (let d = 0; d < 12; d += 1) {
      const sid = `${p.id}-d${d}`;
      const start = t0 + d * 86_400_000 + (p.id === 'p2' ? 3_600_000 : 0);
      sessions.push({ id: sid, profile_id: p.id, started_at: new Date(start).toISOString(), ended_at: new Date(start + 600_000).toISOString(), status: 'completed' });
      const episode = (p.id === 'p3' && d === 9) || (p.id === 'p1' && d === 11);
      for (let s = 0; s < 600; s += 1) {
        const motion = rnd() < 0.12;
        const weak = rnd() < 0.08;
        let bpm = usual[p.id]! + 4 * Math.sin(s / 40) + (rnd() - 0.5) * 4;
        if (episode && s > 300 && s < 420) bpm = 138 + (rnd() - 0.5) * 4;
        const esp = motion ? bpm + (rnd() - 0.5) * 60 : bpm + (rnd() - 0.5) * 3;
        const beats = motion ? bpm + (rnd() - 0.5) * 30 : bpm + (rnd() - 0.5) * 3;
        telemetry.push({
          session_id: sid,
          received_at: new Date(start + s * 1000).toISOString(),
          bpm: Math.round(esp),
          spo2: 97 + Math.round(rnd()),
          finger: true,
          quality: motion ? 40 : 85,
          hr_beats: Math.round(beats * 10) / 10,
          sqi_good: !motion && !weak && Math.abs(esp - beats) <= 5,
          perfusion: weak ? 0.05 + rnd() * 0.1 : 0.3 + rnd() * 0.9,
        });
      }
      if (episode) alerts.push({ session_id: sid, kind: 'bpm_high', level: 'critical', response: 'not_ok', started_at: new Date(start + 305_000).toISOString() });
      if (p.id === 'p2' && d === 4) alerts.push({ session_id: sid, kind: 'bpm_high', level: 'warning', response: 'ok', started_at: new Date(start + 200_000).toISOString() });
    }
  }
  return { profiles, sessions, telemetry, alerts };
}

// ----------------------------------------------------------------- stats --
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const f1 = (x: number) => x.toFixed(1);

function blandAltman(pairs: [number, number][]) {
  const diffs = pairs.map(([a, b]) => a - b);
  const bias = mean(diffs);
  const s = sd(diffs);
  const mape = mean(pairs.map(([a, b]) => Math.abs(a - b) / b)) * 100;
  return { n: pairs.length, bias, lo: bias - 1.96 * s, hi: bias + 1.96 * s, mape };
}

function bestCutoff(points: { x: number; good: boolean }[]) {
  const pos = points.filter((p) => p.good).length;
  const neg = points.length - pos;
  if (!pos || !neg) return null;
  const xs = [...new Set(points.map((p) => Math.round(p.x * 100) / 100))].sort((a, b) => a - b);
  let best = { cut: xs[0]!, j: -1, sens: 0, spec: 0 };
  const roc: [number, number][] = [];
  for (const c of xs) {
    const tp = points.filter((p) => p.good && p.x >= c).length;
    const tn = points.filter((p) => !p.good && p.x < c).length;
    const sens = tp / pos, spec = tn / neg;
    roc.push([1 - spec, sens]);
    if (sens + spec - 1 > best.j) best = { cut: c, j: sens + spec - 1, sens, spec };
  }
  roc.sort((a, b) => a[0] - b[0]);
  let auc = 0;
  for (let i = 1; i < roc.length; i += 1) auc += (roc[i]![0] - roc[i - 1]![0]) * (roc[i]![1] + roc[i - 1]![1]) / 2;
  return { ...best, auc };
}

// ---------------------------------------------------------------- report --
async function main() {
  const isDemo = process.argv.includes('--demo');
  const data = isDemo ? demo() : await fromSupabase();
  const L: string[] = [];
  const say = (s = '') => L.push(s);
  const drivers = new Map(data.profiles.map((p, i) => [p.id, `Driver ${i + 1}`]));
  const sessions = data.sessions.filter((s) => s.status !== 'active');
  const bySession = new Map<string, Tele[]>();
  for (const t of data.telemetry) {
    if (!bySession.has(t.session_id)) bySession.set(t.session_id, []);
    bySession.get(t.session_id)!.push(t);
  }
  for (const rows of bySession.values()) rows.sort((a, b) => a.received_at.localeCompare(b.received_at));

  say(`# Smart Wheel — team tuning report${isDemo ? ' (DEMO DATA)' : ''}`);
  say(`Generated ${new Date().toISOString()}. Recommendations only: review before changing any constant in lib/analysis.`);
  say();

  // 1. Dataset
  const hours = data.telemetry.length / 3600;
  const labelled = data.telemetry.filter((t) => t.sqi_good !== null && t.sqi_good !== undefined);
  say('## 1. Dataset');
  say(`${data.profiles.length} drivers · ${sessions.length} drives · ${f1(hours)} h of readings · ${labelled.length} seconds with quality labels.`);
  say();
  say('| Driver | Drives | Hours | Clean seconds |');
  say('|---|---|---|---|');
  for (const p of data.profiles) {
    const ss = sessions.filter((s) => s.profile_id === p.id);
    const rows = ss.flatMap((s) => bySession.get(s.id) ?? []);
    const lab = rows.filter((r) => r.sqi_good !== null && r.sqi_good !== undefined);
    say(`| ${drivers.get(p.id)} | ${ss.length} | ${f1(rows.length / 3600)} | ${lab.length ? pct(lab.filter((r) => r.sqi_good).length / lab.length) : '—'} |`);
  }
  say();
  if (!data.telemetry.length) {
    say('No readings yet — drive with the app, then run this again.');
    return finish(L);
  }

  // 2. Agreement
  say('## 2. ESP32 heart rate vs the phone\'s beat heart rate (Bland–Altman)');
  const pairsAll = data.telemetry.filter((t) => t.bpm !== null && t.hr_beats !== null && t.hr_beats !== undefined).map((t) => [t.bpm!, t.hr_beats!] as [number, number]);
  const pairsGood = data.telemetry.filter((t) => t.sqi_good && t.bpm !== null && t.hr_beats != null).map((t) => [t.bpm!, t.hr_beats!] as [number, number]);
  if (pairsAll.length) {
    const a = blandAltman(pairsAll), g = pairsGood.length ? blandAltman(pairsGood) : null;
    say('| Seconds | n | Bias (bpm) | 95 % limits of agreement | MAPE |');
    say('|---|---|---|---|---|');
    say(`| all | ${a.n} | ${f1(a.bias)} | ${f1(a.lo)} … ${f1(a.hi)} | ${f1(a.mape)} % |`);
    if (g) say(`| clean only | ${g.n} | ${f1(g.bias)} | ${f1(g.lo)} … ${f1(g.hi)} | ${f1(g.mape)} % |`);
    say();
    say(g && g.mape <= 10
      ? `Clean seconds meet the ±10 % consumer target (MAPE ${f1(g.mape)} %). The quality gate is doing its job.`
      : 'Clean seconds do NOT yet meet ±10 % MAPE — check sensor mounting/pressure before tuning thresholds.');
  } else say('No paired readings yet (needs app v6 quality labels).');
  say();

  // 3. Perfusion cut-off
  say('## 3. Weak-pulse (perfusion index) cut-off for our sensor');
  const perf = data.telemetry.filter((t) => t.perfusion != null && t.sqi_good != null).map((t) => ({ x: t.perfusion!, good: !!t.sqi_good }));
  const cut = bestCutoff(perf);
  if (cut) {
    say(`Best cut-off ${cut.cut.toFixed(2)} % (sensitivity ${pct(cut.sens)}, specificity ${pct(cut.spec)}, Youden J ${cut.j.toFixed(2)}, AUC ${cut.auc.toFixed(2)}; ${perf.length} seconds).`);
    say(cut.auc >= 0.7
      ? `Recommendation: set PERFUSION_HINT in lib/analysis/signal.ts to ${cut.cut.toFixed(2)}. Consider making it part of the verdict only if AUC stays ≥ 0.7 on more drivers.`
      : 'Perfusion does not separate clean from unclean seconds well on our data (AUC < 0.7) — keep it as a hint only, as now.');
  } else say('Not enough labelled seconds of both kinds yet.');
  say();

  // 4. Alerts
  say('## 4. Alerts in practice');
  if (data.alerts.length) {
    const counts = new Map<string, number>();
    for (const a of data.alerts) counts.set(`${a.kind} · ${a.level ?? '—'} · ${a.response ?? 'open/noted'}`, (counts.get(`${a.kind} · ${a.level ?? '—'} · ${a.response ?? 'open/noted'}`) ?? 0) + 1);
    say('| Kind · level · outcome | Count |');
    say('|---|---|');
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) say(`| ${k} | ${n} |`);
    const emerg = data.alerts.filter((a) => ['ok', 'not_ok', 'no_response'].includes(a.response ?? ''));
    say();
    say(`Emergencies (voice checks): ${emerg.length} = ${f1((emerg.length / Math.max(hours, 1e-9)) * 10)} per 10 driving hours; answered "I'm OK": ${emerg.length ? pct(emerg.filter((a) => a.response === 'ok').length / emerg.length) : '—'}.`);
  } else say('No alerts recorded yet.');
  say();

  // 5. Replay
  say('## 5. Replay through the engine with other settings');
  const variants = [
    { name: 'current (15 s / 8 s, quality gate on)', w: 15, c: 8, gate: true },
    { name: 'shorter (10 s / 5 s)', w: 10, c: 5, gate: true },
    { name: 'longer (20 s / 12 s)', w: 20, c: 12, gate: true },
    { name: 'current windows, NO quality gate', w: 15, c: 8, gate: false },
  ];
  const notOk = data.alerts.filter((a) => a.response === 'not_ok' || a.response === 'no_response');
  say(`Reference: ${notOk.length} episode(s) where the driver said "not OK" or didn't answer (should be caught).`);
  say();
  say('| Settings | Emergencies | per 10 h | "not OK" episodes caught |');
  say('|---|---|---|---|');
  for (const v of variants) {
    let emergencies = 0, caught = 0;
    for (const s of sessions) {
      const p = data.profiles.find((x) => x.id === s.profile_id);
      if (!p) continue;
      const prior = profilePrior({ age: p.age, sex: p.gender as Sex, weight_kg: p.weight_kg, height_cm: p.height_cm, conditions: p.conditions ?? [], medications: p.medications ?? [] });
      const engine = new FlagEngine(thresholds(prior, personalBand(prior, null)), () => 'x', { confirmWarningS: v.w, confirmCriticalS: v.c });
      const times: number[] = [];
      for (const t of bySession.get(s.id) ?? []) {
        const r: Reading = {
          t: Date.parse(t.received_at), bpm: t.bpm, spo2: t.spo2, quality: v.gate ? t.quality : null, finger: t.finger ?? true,
          good: v.gate ? (t.sqi_good ?? null) : null,
        };
        for (const e of engine.feed(r)) {
          if (e.type === 'emergency') {
            emergencies += 1;
            times.push(r.t);
            engine.resolve('ok', r.t);
          }
        }
      }
      for (const a of notOk.filter((x) => x.session_id === s.id)) {
        if (times.some((t) => Math.abs(t - Date.parse(a.started_at)) < 120_000)) caught += 1;
      }
    }
    say(`| ${v.name} | ${emergencies} | ${f1((emergencies / Math.max(hours, 1e-9)) * 10)} | ${notOk.length ? `${caught} / ${notOk.length}` : '—'} |`);
  }
  say();
  say('Read this as: prefer the setting that catches every "not OK" episode with the fewest emergencies. The replay uses population thresholds (no personal learning), so real in-app emergencies should be fewer.');
  finish(L);
}

function finish(L: string[]) {
  const text = L.join('\n');
  console.log(text);
  writeFileSync(join(HERE, 'report.md'), text + '\n');
  console.log(`\n(written to tools/tuning/report.md)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

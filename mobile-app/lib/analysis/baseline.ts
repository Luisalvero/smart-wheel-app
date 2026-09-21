/**
 * A driver's usual heart-rate range (proposal: "compare the measurements with
 * that driver's stored baseline information").
 *
 * Computed from every usable reading in the driver's finished drives, exactly
 * like the driver_baselines view in supabase/v3_dashboard.sql, so the phone
 * (offline, in the car) and the website agree. Established after 60 readings
 * -- one minute of good signal; until then the alert logic falls back to
 * fixed prototype limits.
 *
 * This is a personal reference band for a prototype, not a medical range.
 */
import { percentile } from './stats.ts';

export const BASELINE_MIN_READINGS = 60;

export type Baseline = {
  readings: number;
  sessions: number;
  bpmP10: number | null;
  bpmMedian: number | null;
  bpmP90: number | null;
  spo2P10: number | null;
  spo2Median: number | null;
  established: boolean;
};

export function computeBaseline(bpm: readonly number[], spo2: readonly number[], sessions: number): Baseline {
  const b = [...bpm].sort((x, y) => x - y);
  const s = [...spo2].sort((x, y) => x - y);
  return {
    readings: b.length,
    sessions,
    bpmP10: percentile(b, 0.1),
    bpmMedian: percentile(b, 0.5),
    bpmP90: percentile(b, 0.9),
    spo2P10: percentile(s, 0.1),
    spo2Median: percentile(s, 0.5),
    established: b.length >= BASELINE_MIN_READINGS,
  };
}

// ------------------------------------------------------------ learning v2
/**
 * How the baseline learns (v2), following the wearable personal-baseline
 * studies: a FIXED recent window, not an all-time average.
 *   - Window: the last 28 days (Mishra et al. 2020 Nat Biomed Eng and Alavi
 *     et al. 2022 Nat Med use 28-day sliding baselines). If that holds fewer
 *     than MIN_DRIVES drives, it reaches back to the most recent MIN_DRIVES
 *     (Cacheda et al. 2026 require ≥ 10 valid observations).
 *   - Driving data only: heart rate while driving runs ~11 bpm above rest
 *     (taxi drivers, Ann Occup Environ Med 2016), so resting norms would mislead.
 * Readings are EXCLUDED when:
 *   - the phone judged the second unreliable (sqi_good = 0), or
 *   - they fall inside an episode the driver answered "not OK" or did not
 *     answer (60 s before it started to 120 s after it was answered): a
 *     medical event must never be learned as that driver's normal.
 */
export const WINDOW_DAYS = 28;
export const MIN_DRIVES = 10;
export const EPISODE_PAD_BEFORE_S = 60;
export const EPISODE_PAD_AFTER_S = 120;

export type BaselineSample = { t: number; bpm: number; spo2: number | null; session: string; good: boolean | null };
export type Episode = { from: number; to: number };

export type LearnedBaseline = Baseline & { excluded: number; windowDays: number };

export function learnBaseline(samples: BaselineSample[], episodes: Episode[], now: number): LearnedBaseline {
  // Which drives are in the window: the last 28 days, or the last 10 drives.
  const driveStart = new Map<string, number>();
  for (const s of samples) driveStart.set(s.session, Math.min(driveStart.get(s.session) ?? Infinity, s.t));
  const byRecency = [...driveStart.entries()].sort((a, b) => b[1] - a[1]);
  const cutoff = now - WINDOW_DAYS * 86_400_000;
  let inWindow = byRecency.filter(([, t]) => t >= cutoff).map(([id]) => id);
  if (inWindow.length < MIN_DRIVES) inWindow = byRecency.slice(0, MIN_DRIVES).map(([id]) => id);
  const chosen = new Set(inWindow);
  const oldest = Math.min(...inWindow.map((id) => driveStart.get(id)!));

  const keep: BaselineSample[] = [];
  let excluded = 0;
  for (const s of samples) {
    if (!chosen.has(s.session)) continue;
    const inEpisode = episodes.some((e) => s.t >= e.from - EPISODE_PAD_BEFORE_S * 1000 && s.t <= e.to + EPISODE_PAD_AFTER_S * 1000);
    if (s.good === false || inEpisode) excluded += 1;
    else keep.push(s);
  }
  const b = computeBaseline(
    keep.map((s) => s.bpm),
    keep.map((s) => s.spo2).filter((v): v is number => v !== null),
    new Set(keep.map((s) => s.session)).size,
  );
  return { ...b, excluded, windowDays: keep.length ? Math.ceil((now - oldest) / 86_400_000) : 0 };
}

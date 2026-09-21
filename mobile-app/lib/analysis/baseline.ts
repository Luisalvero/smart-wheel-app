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

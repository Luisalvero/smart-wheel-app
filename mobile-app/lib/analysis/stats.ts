/**
 * Robust summary statistics for PPG-derived vitals.
 *
 * A steering-wheel PPG picks up grip changes and road vibration, and a single
 * bad second can produce an implausible reading that is still inside the
 * sensor's validity limits. Min/max are defined by exactly those outliers, so
 * summaries lead with percentiles: p05/p95 are the "realistic low/high", the
 * median is the typical value. Min/max are kept for completeness.
 *
 * percentile() uses linear interpolation between closest ranks -- the same
 * definition as Postgres percentile_cont, so the phone and the website
 * (session_summaries / driver_baselines views) report identical numbers.
 */

export function percentile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function median(values: readonly number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

export type RobustStats = {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p05: number | null;
  median: number | null;
  p95: number | null;
};

export function robustStats(values: readonly number[]): RobustStats {
  const s = [...values].sort((a, b) => a - b);
  return {
    count: s.length,
    min: s.length ? s[0]! : null,
    max: s.length ? s[s.length - 1]! : null,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
    p05: percentile(s, 0.05),
    median: percentile(s, 0.5),
    p95: percentile(s, 0.95),
  };
}

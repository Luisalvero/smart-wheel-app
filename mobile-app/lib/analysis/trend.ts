/**
 * "Your heart rate has been running higher than usual this week."
 *
 * The wearable studies that caught illness early did it by comparing a
 * person's recent resting heart rate with their own baseline:
 *   - Radin et al. 2020 (Lancet Digit Health): a week is abnormal when its
 *     mean RHR is more than 0.5 SD above the person's own average.
 *   - Alavi et al. 2022 (Nat Med, NightSignal): ≥ +4 bpm above baseline.
 *   - Mishra et al. 2020 (Nat Biomed Eng): 28-day baselines; median elevation
 *     found was 7 bpm, typically days before symptoms.
 *   - Quer et al. 2020 (PLOS One, 92,457 adults): a person's RHR varies with
 *     SD ≈ 3 bpm day to day -- used as the SD floor so ordinary noise can't
 *     trigger this.
 * We have no resting HR, only driving HR, so each drive contributes its
 * median of clean seconds (driving adds ~11 bpm over rest but consistently),
 * and the rule is: this week's median of drive medians ≥ max(4 bpm, 0.5 SD)
 * above the median of the 28 days before it. Needs ≥ 3 drives this week and
 * ≥ 10 in the baseline.
 *
 * An ADVISORY only -- illness, poor sleep, stress, caffeine or a new
 * medication all raise heart rate. Never an alarm, never a diagnosis.
 */
import { median } from './stats.ts';

export const RECENT_DAYS = 7;
export const BASE_DAYS = 28;
export const MIN_RECENT = 3;
export const MIN_BASE = 10;
export const TREND_BPM = 4;
export const TREND_SD = 0.5;
export const SD_FLOOR = 3;

export type DriveMedian = { start: number; bpm: number };
export type Trend =
  | { status: 'insufficient'; recentDrives: number; baselineDrives: number }
  | { status: 'normal' | 'elevated'; delta: number; recent: number; usual: number; sd: number; recentDrives: number; baselineDrives: number };

export function computeTrend(drives: DriveMedian[], now: number): Trend {
  const day = 86_400_000;
  const recent = drives.filter((d) => d.start >= now - RECENT_DAYS * day).map((d) => d.bpm);
  const base = drives
    .filter((d) => d.start < now - RECENT_DAYS * day && d.start >= now - (RECENT_DAYS + BASE_DAYS) * day)
    .map((d) => d.bpm);
  if (recent.length < MIN_RECENT || base.length < MIN_BASE) {
    return { status: 'insufficient', recentDrives: recent.length, baselineDrives: base.length };
  }
  const usual = median(base)!;
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const sd = Math.max(SD_FLOOR, Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / (base.length - 1)));
  const now7 = median(recent)!;
  const delta = Math.round((now7 - usual) * 10) / 10;
  const elevated = delta >= Math.max(TREND_BPM, TREND_SD * sd);
  return { status: elevated ? 'elevated' : 'normal', delta, recent: now7, usual, sd, recentDrives: recent.length, baselineDrives: base.length };
}

/**
 * Personal calibration against a reference device.
 *
 * Reflectance PPG on a fingertip reads slightly differently for different
 * people (skin, finger size, grip) and the SpO2 calibration table is generic.
 * The driver sits still with a finger on the wheel sensor and a reference
 * (clip-on pulse oximeter or chest strap) on the other hand; the app averages
 * CAL_SECONDS of clean readings and the driver enters what the reference
 * showed. The difference becomes a per-driver offset, applied to every
 * reading from then on.
 *
 * Offsets are only accepted when small: a large difference means a placement
 * or sensor problem, which must be fixed, not calibrated away.
 *
 * Research-driven limits:
 *   - Heart rate: consumer HR monitors are judged at ±10 % (MAPE; CTA-2065 as
 *     used by Nelson & Allen 2019). Bland (york.ac.uk/~mb55) recommends ~100
 *     paired readings for agreement, so the correction ACCUMULATES across
 *     sessions (weighted by clean seconds) instead of trusting one minute.
 *   - SpO2 is compared but NOT corrected: FDA 510(k) guidance validates
 *     oximeters against arterial blood (SaO2) with ≥ 200 paired points, and a
 *     consumer fingertip oximeter has its own ~2–3 % error, so it is not a
 *     reference. Pulse oximeters also read high on darker skin (Sjoding et al.
 *     2020 NEJM: occult hypoxaemia 11.7 % vs 3.6 %), so SpO2 stays an
 *     estimate. The raw frame
 * (and hence raw archives and the phone's independent beat heart rate) is
 * never altered; the offsets are recorded on the profile (cal_hr, cal_spo2,
 * cal_at) so raw values can always be recovered.
 */
export const CAL_SECONDS = 60;
export const CAL_MIN_GOOD = 30; // clean seconds needed out of the minute
export const CAL_MAX_HR = 10; // bpm
export const CAL_MAX_SPO2 = 3; // % points

export type CalibrationResult =
  | { ok: true; hr: number; spo2: number | null; n: number; wheelBpm: number; wheelSpo2: number | null; mape: number }
  | { ok: false; reason: string };

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function computeCalibration(
  wheel: { bpm: number[]; spo2: number[] },
  reference: { bpm: number; spo2: number | null },
): CalibrationResult {
  if (wheel.bpm.length < CAL_MIN_GOOD) {
    return { ok: false, reason: `Only ${wheel.bpm.length} clean seconds (need ${CAL_MIN_GOOD}). Keep still with your finger flat on the sensor and try again.` };
  }
  const wheelBpm = mean(wheel.bpm);
  const hr = Math.round((reference.bpm - wheelBpm) * 10) / 10;
  if (Math.abs(hr) > CAL_MAX_HR) {
    return { ok: false, reason: `The wheel read ${wheelBpm.toFixed(0)} BPM vs ${reference.bpm} on the reference — too far apart to calibrate. Check how the finger sits on the sensor.` };
  }
  let spo2: number | null = null;
  let wheelSpo2: number | null = null;
  if (reference.spo2 !== null && wheel.spo2.length >= CAL_MIN_GOOD) {
    wheelSpo2 = mean(wheel.spo2);
    spo2 = Math.round((reference.spo2 - wheelSpo2) * 10) / 10;
    if (Math.abs(spo2) > CAL_MAX_SPO2) {
      return { ok: false, reason: `Oxygen: the wheel read ${wheelSpo2.toFixed(0)}% vs ${reference.spo2}% on the reference — too far apart to calibrate.` };
    }
  }
  const mape = (Math.abs(reference.bpm - wheelBpm) / reference.bpm) * 100;
  return { ok: true, hr, spo2, n: wheel.bpm.length, wheelBpm, wheelSpo2, mape };
}

/** Combines a new session with the stored correction, weighted by clean
 *  seconds (running mean across sessions). */
export function accumulate(prev: { hr: number | null; n: number }, next: { hr: number; n: number }): { hr: number; n: number } {
  const n = prev.n + next.n;
  const hr = prev.hr === null || prev.n === 0 ? next.hr : (prev.hr * prev.n + next.hr * next.n) / n;
  return { hr: Math.round(hr * 10) / 10, n };
}

/** Applies a driver's heart-rate offset to one reading (SpO2 is never corrected). */
export function applyCalibration(bpm: number, spo2: number, cal: { hr?: number | null; spo2?: number | null }) {
  return {
    bpm: Math.round(bpm + (cal.hr ?? 0)),
    spo2,
  };
}

// Heart rate and SpO2 from a window of red/IR PPG samples.
//
// Replaces the heart-rate and ratio parts of Maxim's reference algorithm
// (spo2_algorithm.cpp). Measured on this hardware against two independent
// estimates of the same pulse (waveform autocorrelation: 80 bpm; spectrum peak:
// 79 bpm), the Maxim algorithm reported a median of 115 bpm, ranging 78-150.
// Its heart rate is 1500 / (samples between two detected valleys), and it
// accepts valleys as close as 4 samples apart, so the second bump in each
// pulse (the dicrotic notch) or noise is counted as an extra beat. Its SpO2 is
// computed at those same mis-picked valleys, so it inherits the error.
//
// This estimator instead measures the period of the whole waveform:
//  * Heart rate: normalised autocorrelation of the pulsatile IR signal. The
//    first strong peak is the beat period; a notch halfway through a beat
//    correlates poorly with the waveform and is rejected by the threshold.
//    Parabolic interpolation gives sub-sample period resolution, so the result
//    is continuous rather than stepping through 1500/k (125, 136, 150 ...).
//  * SpO2: ratio of ratios R = (AC_red/DC_red)/(AC_ir/DC_ir) using RMS over
//    the whole window, looked up in Maxim's own calibration table
//    (uch_spo2_table, index = R*100), so calibration is unchanged.
//
// Pure C++ with no Arduino dependencies: tests/test_vitals_host.cpp exercises
// it on the laptop with signals whose answers are known.

#pragma once
#include <math.h>
#include <stdint.h>

namespace ppg {

struct Vitals {
  float heartRate;    // bpm, valid only if hrValid
  float ratio;        // R, ratio of ratios
  int spo2;           // %, valid only if spo2Valid
  float periodicity;  // autocorrelation at the chosen lag, 0..1: signal quality
  bool hrValid;
  bool spo2Valid;
};

// Minimum normalised autocorrelation for a lag to count as the beat period.
// Chosen so a clean pulse (typically > 0.7) passes and noise or a notch-only
// sub-period (typically < 0.3) does not.
constexpr float kMinPeriodicity = 0.5f;

// Removes baseline (DC and slow drift) with a centred moving average one second
// long, then lightly smooths. Returns the DC level (mean of the raw input).
inline float pulsatile(const float* in, float* out, int n, float fs) {
  float dc = 0;
  for (int i = 0; i < n; ++i) dc += in[i];
  dc /= n;

  const int half = static_cast<int>(fs / 2);
  for (int i = 0; i < n; ++i) {
    const int a = i - half < 0 ? 0 : i - half;
    const int b = i + half >= n ? n - 1 : i + half;
    float s = 0;
    for (int k = a; k <= b; ++k) s += in[k];
    out[i] = in[i] - s / (b - a + 1);
  }
  // 3-tap smoothing: -3 dB near fs/3 (8 Hz at 25 Hz), keeping pulse harmonics.
  float prev = out[0];
  for (int i = 1; i < n - 1; ++i) {
    const float cur = out[i];
    out[i] = (prev + cur + out[i + 1]) / 3.0f;
    prev = cur;
  }
  return dc;
}

inline float rms(const float* x, int n) {
  float s = 0;
  for (int i = 0; i < n; ++i) s += x[i] * x[i];
  return sqrtf(s / n);
}

// Normalised autocorrelation at lag `lag` over the overlapping part.
inline float autocorr(const float* x, int n, int lag) {
  float sxy = 0, sxx = 0, syy = 0;
  for (int i = 0; i + lag < n; ++i) {
    sxy += x[i] * x[i + lag];
    sxx += x[i] * x[i];
    syy += x[i + lag] * x[i + lag];
  }
  const float d = sqrtf(sxx * syy);
  return d > 0 ? sxy / d : 0;
}

// `red`/`ir`: raw samples at `fs` Hz. `acRed`/`acIr`: scratch, same length.
// `table`/`tableLen`: SpO2 calibration indexed by R*100 (Maxim's table).
inline Vitals estimate(const float* red, const float* ir, float* acRed, float* acIr,
                       int n, float fs, float bpmMin, float bpmMax,
                       const uint8_t* table, int tableLen) {
  Vitals v{0, 0, 0, 0, false, false};
  const float dcRed = pulsatile(red, acRed, n, fs);
  const float dcIr = pulsatile(ir, acIr, n, fs);

  // Candidate beat periods, in samples.
  const int lagMin = static_cast<int>(floorf(fs * 60.0f / bpmMax));
  const int lagMax = static_cast<int>(ceilf(fs * 60.0f / bpmMin));
  if (lagMin < 2 || lagMax + 2 >= n) return v;

  // First local maximum above the threshold is the fundamental period. Taking
  // the first (rather than the global maximum) avoids locking onto 2x or 3x the
  // period, which also correlate strongly.
  float rPrev = autocorr(acIr, n, lagMin - 1);
  float rCur = autocorr(acIr, n, lagMin);
  for (int lag = lagMin; lag <= lagMax; ++lag) {
    const float rNext = autocorr(acIr, n, lag + 1);
    if (rCur >= kMinPeriodicity && rCur >= rPrev && rCur >= rNext) {
      // Parabolic interpolation of the peak for sub-sample resolution.
      const float denom = rPrev - 2 * rCur + rNext;
      const float shift = denom != 0 ? 0.5f * (rPrev - rNext) / denom : 0;
      const float period = lag + (shift > 0.5f ? 0.5f : shift < -0.5f ? -0.5f : shift);
      v.heartRate = 60.0f * fs / period;
      v.periodicity = rCur;
      v.hrValid = v.heartRate >= bpmMin && v.heartRate <= bpmMax;
      break;
    }
    rPrev = rCur;
    rCur = rNext;
  }

  // SpO2 needs a genuinely pulsatile signal: without a detected rhythm the AC
  // terms are noise and the ratio is meaningless.
  const float acR = rms(acRed, n), acI = rms(acIr, n);
  if (v.hrValid && dcRed > 0 && dcIr > 0 && acI > 0) {
    v.ratio = (acR / dcRed) / (acI / dcIr);
    const int idx = static_cast<int>(lroundf(v.ratio * 100.0f));
    // Same valid range as Maxim's implementation (2 < idx < 184).
    if (table && idx > 2 && idx < tableLen) {
      v.spo2 = table[idx];
      v.spo2Valid = true;
    }
  }
  return v;
}

}  // namespace ppg

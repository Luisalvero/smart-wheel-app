/**
 * Irregular-rhythm advisory from the 100 Hz raw PPG (protocol v3).
 *
 * Modelled on Apple's Irregular Rhythm Notification ("Using Apple Watch for
 * Arrhythmia Detection", Dec 2020): analyse beat-to-beat intervals only when
 * the signal is clean, classify each interval segment as irregular or not,
 * and notify only when 5 of 6 consecutive segments are irregular; two regular
 * segments reset the count. In the Apple Heart Study sub-study, 78.9 % of
 * notified participants had concordant AFib on an ECG patch and 98.2 % had
 * AFib or another clinically relevant arrhythmia.
 *
 * This is an ADVISORY (logged, shown after the drive), never an emergency and
 * never a diagnosis: PPG irregularity has many causes (ectopic beats, motion).
 *
 * Steps
 *  1. Beats: Elgendi et al. 2013 (PLoS ONE 8:e76585) two-event-related-moving-
 *     averages detector: band-pass 0.5–8 Hz (zero-phase), clip < 0, square,
 *     MA_peak over 111 ms, MA_beat over 667 ms, blocks where MA_peak >
 *     MA_beat + β·mean (β = 0.02) and at least 111 ms wide; the peak is the
 *     maximum inside each block (reported 99.84 % sensitivity, 99.89 % +P).
 *     Reflectance PPG dips when blood volume rises, so the signal is inverted.
 *  2. Intervals between beats, 300–2000 ms (30–200 bpm) kept.
 *  3. Segments of 128 intervals from continuous clean signal (Dash et al.
 *     2009, Ann Biomed Eng 37:1701). Irregular when all three hold:
 *       RMSSD / mean interval  ≥ 0.098
 *       Shannon entropy (16 bins, 8 highest and 8 lowest removed) ≥ 0.8
 *       turning-point ratio within 0.527–0.8 (random-like sequence)
 *     Thresholds from the authors' patent (US 8,417,326 B2). Dash reported
 *     94.4 % sensitivity / 95.1 % specificity on MIT-BIH AF.
 *  4. 5 of 6 consecutive irregular segments → advisory.
 */

export const SEGMENT_BEATS = 128;
export const NRMSSD_MIN = 0.098;
export const SHE_MIN = 0.8;
export const TPR_RANGE: [number, number] = [0.527, 0.8];

// ------------------------------------------------------------- filtering
type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** RBJ cookbook Butterworth (Q = 1/√2) low/high-pass sections. */
function biquad(kind: 'low' | 'high', fc: number, fs: number): Biquad {
  const w = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const [b0, b1, b2] = kind === 'low' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function run(f: Biquad, x: Float64Array): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = x[0]!, x2 = x[0]!, y1 = 0, y2 = 0;
  // Start from the first sample's steady state to limit the start-up transient.
  const dc = f.b0 + f.b1 + f.b2 === 0 ? 0 : x[0]!;
  y1 = y2 = dc * ((f.b0 + f.b1 + f.b2) / (1 + f.a1 + f.a2));
  for (let i = 0; i < x.length; i += 1) {
    const v = f.b0 * x[i]! + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** Zero-phase band-pass (forward + backward), 0.5–8 Hz. */
export function bandpass(x: ArrayLike<number>, fs: number): Float64Array {
  const hp = biquad('high', 0.5, fs);
  const lp = biquad('low', 8, fs);
  let y: Float64Array = Float64Array.from(x);
  for (const f of [hp, lp]) {
    y = run(f, y);
    y.reverse();
    y = run(f, y);
    y.reverse();
  }
  return y;
}

function movingAverage(x: Float64Array, w: number): Float64Array {
  const out = new Float64Array(x.length);
  const half = Math.floor(w / 2);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i += 1) {
    const a = Math.max(0, i - half);
    const b = Math.min(x.length - 1, i + half);
    while (hi < b) sum += x[++hi]!;
    while (lo < a) sum -= x[lo++]!;
    out[i] = sum / (b - a + 1);
  }
  return out;
}

/** Elgendi 2013 systolic-peak detector. Returns sample indices of beats. */
export function detectBeats(rawIr: ArrayLike<number>, fs: number): number[] {
  const inverted = Array.from(rawIr, (v) => -v);
  const s = bandpass(inverted, fs);
  const y = s.map((v) => (v > 0 ? v * v : 0));
  const w1 = Math.round(0.111 * fs);
  const w2 = Math.round(0.667 * fs);
  const maPeak = movingAverage(y, w1);
  const maBeat = movingAverage(y, w2);
  let mean = 0;
  for (const v of y) mean += v;
  mean /= y.length || 1;
  const alpha = 0.02 * mean;
  const peaks: number[] = [];
  let start = -1;
  for (let i = 0; i <= y.length; i += 1) {
    const inBlock = i < y.length && maPeak[i]! > maBeat[i]! + alpha;
    if (inBlock && start < 0) start = i;
    if (!inBlock && start >= 0) {
      if (i - start >= w1) {
        let best = start;
        for (let k = start; k < i; k += 1) if (s[k]! > s[best]!) best = k;
        peaks.push(best);
      }
      start = -1;
    }
  }
  return peaks;
}

// --------------------------------------------------------------- metrics
export type SegmentMetrics = { beats: number; meanIbi: number; nrmssd: number; she: number; tpr: number; irregular: boolean };

export function segmentMetrics(ibi: number[]): SegmentMetrics {
  const n = ibi.length;
  const mean = ibi.reduce((a, b) => a + b, 0) / n;
  let ss = 0;
  for (let i = 1; i < n; i += 1) ss += (ibi[i]! - ibi[i - 1]!) ** 2;
  const nrmssd = Math.sqrt(ss / (n - 1)) / mean;
  let turns = 0;
  for (let i = 1; i < n - 1; i += 1) {
    const a = ibi[i - 1]!, b = ibi[i]!, c = ibi[i + 1]!;
    if ((b > a && b > c) || (b < a && b < c)) turns += 1;
  }
  const tpr = turns / (n - 2);
  const trimmed = [...ibi].sort((a, b) => a - b).slice(8, n - 8);
  const lo = trimmed[0]!, hi = trimmed[trimmed.length - 1]!;
  const bins = new Array(16).fill(0);
  for (const v of trimmed) bins[Math.min(15, Math.floor(((v - lo) / (hi - lo || 1)) * 16))] += 1;
  let she = 0;
  for (const c of bins) if (c) she -= (c / trimmed.length) * Math.log(c / trimmed.length);
  she /= Math.log(16);
  const irregular = nrmssd >= NRMSSD_MIN && she >= SHE_MIN && tpr >= TPR_RANGE[0] && tpr <= TPR_RANGE[1];
  return { beats: n, meanIbi: mean, nrmssd, she, tpr, irregular };
}

// ---------------------------------------------------------------- monitor
export type RhythmEvent =
  | { type: 'segment'; metrics: SegmentMetrics; irregularInRow: number }
  | { type: 'advisory'; metrics: SegmentMetrics[] };

/**
 * Feed frames as they arrive. Only continuous, clean stretches are analysed:
 * a lost frame, a lifted finger or a low-quality second ends the stretch.
 */
export class RhythmMonitor {
  private buf: number[] = [];
  private bufStart = 0; // absolute sample index of buf[0]
  private next = 0; // absolute sample index of the next incoming sample
  private lastPeak: number | null = null;
  private ibis: number[] = [];
  private history: SegmentMetrics[] = [];
  private advised = false;
  private fs = 100;

  /** One frame (one second). ok = finger on, quality good, no frames lost before it. */
  feed(ir: ArrayLike<number>, fs: number, ok: boolean): RhythmEvent[] {
    if (!ok || fs !== this.fs) {
      this.fs = fs;
      this.reset();
      return [];
    }
    for (let i = 0; i < ir.length; i += 1) this.buf.push(ir[i]!);
    this.next += ir.length;
    if (this.buf.length < 20 * fs) return [];
    return this.process();
  }

  private reset() {
    this.buf = [];
    this.bufStart = this.next;
    this.lastPeak = null;
    this.ibis = [];
  }

  private process(): RhythmEvent[] {
    const fs = this.fs;
    const peaks = detectBeats(this.buf, fs);
    // Trust peaks away from the edges (filter transients); keep 2 s of overlap.
    const keepFrom = this.buf.length - 2 * fs;
    const out: RhythmEvent[] = [];
    for (const p of peaks) {
      const abs = this.bufStart + p;
      if (p < fs || p >= keepFrom) continue;
      if (this.lastPeak !== null && abs <= this.lastPeak) continue;
      if (this.lastPeak !== null) {
        const ms = ((abs - this.lastPeak) * 1000) / fs;
        if (ms >= 300 && ms <= 2000) this.ibis.push(ms);
      }
      this.lastPeak = abs;
      if (this.ibis.length >= SEGMENT_BEATS) {
        const m = segmentMetrics(this.ibis.splice(0, SEGMENT_BEATS));
        out.push(...this.judge(m));
      }
    }
    this.bufStart += keepFrom;
    this.buf = this.buf.slice(keepFrom);
    return out;
  }

  private judge(m: SegmentMetrics): RhythmEvent[] {
    this.history.push(m);
    // Apple: two regular segments reset the cycle.
    const last2 = this.history.slice(-2);
    if (last2.length === 2 && last2.every((x) => !x.irregular)) this.history = [];
    const last6 = this.history.slice(-6);
    const irregularInRow = last6.filter((x) => x.irregular).length;
    const events: RhythmEvent[] = [{ type: 'segment', metrics: m, irregularInRow }];
    if (!this.advised && irregularInRow >= 5) {
      this.advised = true;
      events.push({ type: 'advisory', metrics: last6 });
    }
    return events;
  }
}

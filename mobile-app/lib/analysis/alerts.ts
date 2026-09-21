/**
 * In-car alert logic (proposal: alert-and-escalation feature).
 *
 *   normal ──(10-s median outside the band for SUSTAIN_S)──▶ prompting
 *   prompting ──"I'm OK"──▶ cooldown (COOLDOWN_S) ──▶ normal
 *   prompting ──"Not well" or no answer in RESPONSE_S──▶ escalated (SIMULATED)
 *
 * The band is the driver's baseline p10–p90 widened by BAND_MARGIN_BPM, once
 * the baseline is established; always also the fixed prototype limits below.
 * A 10-second median (not a single reading) is compared, so one noisy second
 * cannot start an alert -- the same artifact problem that makes the summaries
 * use percentiles.
 *
 * Escalation is simulated: it is recorded and shown, and nobody is contacted,
 * as the proposal specifies for testing. Not a medical device; the limits are
 * prototype values chosen for demonstration, not clinical thresholds.
 *
 * Pure logic, no React or storage: fed one reading per second, returns
 * transitions for the caller to persist and present. Unit-tested in
 * tests/alerts.test.ts.
 */
import type { Baseline } from './baseline';
import { median } from './stats.ts';

export const WINDOW_S = 10;
export const SUSTAIN_S = 20;
export const RESPONSE_S = 30;
export const COOLDOWN_S = 300;
export const BAND_MARGIN_BPM = 15;
/** Fixed prototype limits, applied with or without a baseline. */
export const LIMITS = { bpmLow: 40, bpmHigh: 150, spo2Low: 90 } as const;

export type AlertKind = 'bpm_high' | 'bpm_low' | 'spo2_low';
export type AlertResponse = 'ok' | 'unwell' | 'no_response';

export type OpenAlert = {
  id: string;
  kind: AlertKind;
  value: number;
  threshold: number;
  startedAt: number; // ms epoch
  promptedAt: number;
};

export type AlertEvent =
  | { type: 'prompt'; alert: OpenAlert }
  | { type: 'resolved'; alert: OpenAlert; response: AlertResponse; escalated: boolean; at: number };

type Breach = { kind: AlertKind; value: number; threshold: number };

export class AlertMonitor {
  private bpm: { t: number; v: number }[] = [];
  private spo2: { t: number; v: number }[] = [];
  private breachSince: number | null = null;
  private breachKind: AlertKind | null = null;
  private cooldownUntil = 0;
  open: OpenAlert | null = null;

  private baseline: Baseline | null;
  private readonly newId: () => string;

  constructor(baseline: Baseline | null, newId: () => string) {
    this.baseline = baseline;
    this.newId = newId;
  }

  setBaseline(b: Baseline | null) {
    this.baseline = b;
  }

  /** The band the current heart rate is judged against, for display. */
  band(): { low: number; high: number; personal: boolean } {
    const b = this.baseline;
    if (b?.established && b.bpmP10 !== null && b.bpmP90 !== null) {
      return {
        low: Math.max(LIMITS.bpmLow, b.bpmP10 - BAND_MARGIN_BPM),
        high: Math.min(LIMITS.bpmHigh, b.bpmP90 + BAND_MARGIN_BPM),
        personal: true,
      };
    }
    return { low: LIMITS.bpmLow, high: LIMITS.bpmHigh, personal: false };
  }

  private breach(now: number): Breach | null {
    const recent = (xs: { t: number; v: number }[]) => xs.filter((p) => now - p.t <= WINDOW_S * 1000).map((p) => p.v);
    const bpmNow = recent(this.bpm);
    const spoNow = recent(this.spo2);
    // Need most of the window: a half-empty window is a poor-signal period,
    // not evidence of an abnormal heart rate.
    if (bpmNow.length >= WINDOW_S * 0.6) {
      const m = median(bpmNow)!;
      const band = this.band();
      if (m > band.high) return { kind: 'bpm_high', value: m, threshold: band.high };
      if (m < band.low) return { kind: 'bpm_low', value: m, threshold: band.low };
    }
    if (spoNow.length >= WINDOW_S * 0.6) {
      const m = median(spoNow)!;
      if (m < LIMITS.spo2Low) return { kind: 'spo2_low', value: m, threshold: LIMITS.spo2Low };
    }
    return null;
  }

  /** Feed one second. bpm/spo2 null = no usable reading that second. */
  feed(now: number, bpm: number | null, spo2: number | null): AlertEvent | null {
    if (bpm !== null) this.bpm.push({ t: now, v: bpm });
    if (spo2 !== null) this.spo2.push({ t: now, v: spo2 });
    const horizon = now - WINDOW_S * 1000;
    this.bpm = this.bpm.filter((p) => p.t > horizon);
    this.spo2 = this.spo2.filter((p) => p.t > horizon);

    if (this.open) {
      if (now - this.open.promptedAt >= RESPONSE_S * 1000) return this.resolve(now, 'no_response');
      return null;
    }
    if (now < this.cooldownUntil) return null;

    const b = this.breach(now);
    if (!b) {
      this.breachSince = null;
      this.breachKind = null;
      return null;
    }
    if (this.breachKind !== b.kind || this.breachSince === null) {
      this.breachSince = now;
      this.breachKind = b.kind;
    }
    if (now - this.breachSince >= SUSTAIN_S * 1000) {
      this.open = { id: this.newId(), ...b, startedAt: this.breachSince, promptedAt: now };
      this.breachSince = null;
      return { type: 'prompt', alert: this.open };
    }
    return null;
  }

  /** The driver answered the prompt. */
  respond(now: number, response: 'ok' | 'unwell'): AlertEvent | null {
    return this.open ? this.resolve(now, response) : null;
  }

  private resolve(now: number, response: AlertResponse): AlertEvent {
    const alert = this.open!;
    this.open = null;
    const escalated = response !== 'ok';
    // After "I'm OK" stay quiet for a while; after escalation, too -- the
    // escalation itself is the follow-up.
    this.cooldownUntil = now + COOLDOWN_S * 1000;
    return { type: 'resolved', alert, response, escalated, at: now };
  }
}

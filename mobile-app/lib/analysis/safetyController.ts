/**
 * Glue between the live frames, the flag engine, the rhythm monitor and the
 * voice check -- with no React in it, so it can be reasoned about (and
 * tested) on its own. The hook (useDriveSession) forwards frames here and
 * renders whatever state this reports.
 *
 *   frame ─▶ FlagEngine ── warning ──▶ "watching" (logged, shown quietly)
 *                        └─ emergency ─▶ VoiceCheck (speak, listen, understand)
 *                                          └─▶ resolve: ok / not_ok / no_response
 *   frame ─▶ RhythmMonitor ── advisory ─▶ logged, shown after the drive
 *
 * Every episode is saved as a drive_alerts row (and uploaded by liveSync):
 * notices, warnings that recovered, unconfirmed ones, emergencies and how the
 * driver answered. Transcripts are not saved.
 */
import type { Frame } from '../ble/protocol';
import type { DriveAlertRow, DriverProfile } from '../db/repositories';
import { parseList } from '../db/repositories';
import type { Baseline } from './baseline';
import { FlagEngine, thresholds, type Band, type EngineEvent, type Episode, type Thresholds } from './flagEngine';
import { personalBand, profilePrior, type ProfilePrior, type Sex } from './profileModel';
import { RhythmMonitor } from './rhythm';
import { VoiceCheck, type CheckResult, type Lang, type VoiceIO } from '../voice/voiceCheck';

export type CheckPhase = 'speaking' | 'listening';

export type SafetyState = {
  prior: ProfilePrior | null;
  band: (Band & { weight: number }) | null;
  th: Thresholds | null;
  /** A warning flag is up and the next seconds are being checked. */
  tracking: Episode | null;
  /** The voice check is running. */
  check: { episode: Episode; phase: CheckPhase } | null;
  last: { episode: Episode; result: CheckResult; at: Date } | null;
  notices: number;
  advisory: boolean;
  rejected: number;
};

export const initialSafety: SafetyState = {
  prior: null,
  band: null,
  th: null,
  tracking: null,
  check: null,
  last: null,
  notices: 0,
  advisory: false,
  rejected: 0,
};

type Deps = {
  voiceIO: () => VoiceIO;
  save: (row: Omit<DriveAlertRow, 'sync_status'>) => Promise<void>;
  haptic: (kind: 'warning' | 'error') => void;
  onChange: (s: SafetyState) => void;
  newId: () => string;
};

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export class SafetyController {
  private state: SafetyState = { ...initialSafety };
  private engine: FlagEngine | null = null;
  private rhythm = new RhythmMonitor();
  private sessionId: string | null = null;
  private voice: VoiceCheck | null = null;
  private lang: Lang = 'en';
  private name = '';
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  private set(patch: Partial<SafetyState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  /** Recomputes the driver's thresholds from their profile and baseline. */
  configure(p: DriverProfile, baseline: Baseline | null) {
    const prior = profilePrior({
      age: p.age,
      sex: p.gender as Sex,
      weight_kg: p.weight_kg,
      height_cm: p.height_cm,
      conditions: parseList(p.conditions),
      medications: parseList(p.medications),
    });
    const band = personalBand(prior, baseline);
    const th = thresholds(prior, band);
    if (this.engine) this.engine.setThresholds(th);
    else this.engine = new FlagEngine(th, this.deps.newId);
    this.lang = p.language === 'es' ? 'es' : 'en';
    this.name = p.display_name.split(' ')[0] ?? '';
    this.set({ prior, band, th });
  }

  startSession(sessionId: string) {
    this.sessionId = sessionId;
    this.rhythm = new RhythmMonitor();
    if (this.state.th) this.engine = new FlagEngine(this.state.th, this.deps.newId);
    this.set({ tracking: null, check: null, last: null, notices: 0, advisory: false, rejected: 0 });
  }

  endSession() {
    if (this.voice) this.voice.answerByButton('ok'); // ending the drive closes an open check
    this.sessionId = null;
    this.set({ tracking: null });
  }

  answer(r: 'ok' | 'not_ok') {
    this.voice?.answerByButton(r);
  }

  onFrame(f: Frame, rx: Date, missingBefore: number) {
    if (!this.sessionId || !this.engine) return;
    const quality = f.version >= 3 ? f.quality : null;
    const events = this.engine.feed({
      t: rx.getTime(),
      bpm: f.usable ? f.heartRate : null,
      spo2: f.usable ? f.spo2 : null,
      quality,
      finger: f.finger,
    });
    for (const e of events) this.handle(e);
    if (this.engine.rejected !== this.state.rejected) this.set({ rejected: this.engine.rejected });

    if (f.version >= 3 && f.rateHz) {
      const ok = f.finger && (quality ?? 0) >= 50 && missingBefore === 0;
      for (const ev of this.rhythm.feed(f.samples.map((s) => s.ir), f.rateHz, ok)) {
        if (ev.type !== 'advisory') continue;
        const last = ev.metrics[ev.metrics.length - 1]!;
        void this.persist({
          id: this.deps.newId(),
          kind: 'no_contact',
          level: 'notice',
          stage: 'notice',
          startedAt: rx.getTime(),
          value: Math.round(last.nrmssd * 1000) / 1000,
          threshold: 0.098,
          confirmedAt: null,
          outcome: null,
          resolvedAt: null,
        }, 'irregular_rhythm');
        this.set({ advisory: true });
      }
    }
  }

  private handle(e: EngineEvent) {
    const ep = e.episode;
    switch (e.type) {
      case 'notice':
        void this.persist(ep);
        this.set({ notices: this.state.notices + 1 });
        return;
      case 'warning':
      case 'escalated':
        void this.persist(ep);
        this.set({ tracking: { ...ep } });
        return;
      case 'cleared':
        void this.persist(ep);
        this.set({ tracking: null });
        return;
      case 'emergency':
        void this.persist(ep);
        this.set({ tracking: null });
        void this.runCheck(ep);
        return;
    }
  }

  /** Settings → "Try the voice check": the real dialogue, nothing recorded. */
  async rehearse(): Promise<CheckResult> {
    const ep: Episode = {
      id: 'rehearsal', kind: 'bpm_high', level: 'warning', stage: 'emergency', startedAt: Date.now(),
      value: 0, threshold: 0, confirmedAt: Date.now(), outcome: null, resolvedAt: null,
    };
    return this.runCheck(ep, true);
  }

  private async runCheck(ep: Episode, rehearsal = false): Promise<CheckResult> {
    if (ep.kind === 'no_contact') return { outcome: 'ok', urgent: false, channel: 'none', attempts: 0, confidence: null };
    this.deps.haptic('warning');
    const base = this.deps.voiceIO();
    // Report what the voice check is doing so the screen can show it.
    const io: VoiceIO = {
      speak: (text, lang) => {
        this.set({ check: { episode: ep, phase: 'speaking' } });
        return base.speak(text, lang);
      },
      listen: (lang, ms, hints) => {
        this.set({ check: { episode: ep, phase: 'listening' } });
        return base.listen(lang, ms, hints);
      },
      cancel: () => base.cancel(),
    };
    this.voice = new VoiceCheck(io, this.lang, this.name);
    let result: CheckResult;
    try {
      result = await this.voice.run(ep.kind);
    } catch {
      result = { outcome: 'no_response', urgent: false, channel: 'none', attempts: 0, confidence: null };
    }
    this.voice = null;
    if (rehearsal) {
      this.set({ check: null });
      return result;
    }
    const done = this.engine?.resolve(result.outcome, Date.now()) ?? { ...ep, outcome: result.outcome, resolvedAt: Date.now() };
    if (result.outcome !== 'ok') this.deps.haptic('error');
    await this.persist(done, undefined, result);
    this.set({ check: null, last: { episode: done, result, at: new Date() } });
    return result;
  }

  private async persist(ep: Episode, kindOverride?: string, result?: CheckResult) {
    if (!this.sessionId) return;
    const escalated = ep.outcome === 'not_ok' || ep.outcome === 'no_response';
    await this.deps
      .save({
        id: ep.id,
        session_id: this.sessionId,
        kind: kindOverride ?? ep.kind,
        value: Math.round(ep.value * 10) / 10,
        threshold: ep.threshold,
        started_at: iso(ep.startedAt)!,
        prompted_at: iso(ep.confirmedAt),
        response: ep.outcome,
        responded_at: iso(ep.resolvedAt),
        escalated: escalated ? 1 : 0,
        level: ep.level,
        channel: result?.channel ?? null,
        answer_confidence: result?.confidence ?? null,
      })
      .catch(() => undefined);
  }
}

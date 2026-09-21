/**
 * The spoken "Are you feeling okay?" check, run when the flag engine confirms
 * an emergency. It reacts to a flag; it never looks at the vitals itself.
 *
 *   speak prompt → listen (6 s) → understand
 *     ok      → reassure, done (outcome ok)
 *     not_ok  → tell the driver to pull over / call 911, done (not_ok)
 *     unclear or silence → ask once more, simpler → listen (6 s)
 *       ok / not_ok as above; still unclear or silent → no_response
 *
 * No response is treated like "not okay" by the caller (proposal: escalate
 * when the driver does not respond). The on-screen buttons stay available the
 * whole time and win immediately (answerByButton), so the check also works
 * when the microphone or speech recognition is unavailable.
 *
 * Wording is honest about the prototype: it never says help is on the way,
 * because escalation is simulated -- it tells the driver what to do.
 *
 * Speech I/O is injected (see speechIO.ts for the phone implementation), so
 * the dialogue policy is unit-tested without a device (tests/voiceCheck.test.ts).
 * Transcripts are used in memory only and never stored.
 */
import { understand, type Understood } from './intent.ts';

export type Lang = 'en' | 'es';

export type VoiceIO = {
  speak(text: string, lang: Lang): Promise<void>;
  /** Resolves with what was heard, or null if nothing (or recognition is unavailable). */
  listen(lang: Lang, ms: number, hints: string[]): Promise<string | null>;
  /** Stops any speech or listening in progress. */
  cancel(): void;
};

export type CheckOutcome = 'ok' | 'not_ok' | 'no_response';
export type CheckResult = {
  outcome: CheckOutcome;
  urgent: boolean;
  channel: 'voice' | 'button' | 'none';
  attempts: number;
  confidence: number | null;
};

export const LISTEN_MS = 6000;

type Reason = 'bpm_high' | 'bpm_low' | 'spo2_low';

const TEXT = {
  en: {
    ask: (name: string, r: Reason) =>
      `${name ? `${name}, ` : ''}${
        r === 'bpm_high' ? 'your heart rate has been unusually high' : r === 'bpm_low' ? 'your heart rate has been unusually low' : 'your oxygen level has been low'
      }. Are you feeling okay? Please say yes, or no.`,
    again: "Sorry, I didn't catch that. Are you okay? Say yes if you're fine, or no if you need help.",
    ok: "Okay. I'll keep an eye on things. Drive safely.",
    notOk: 'Please pull over as soon as it is safe. If you need emergency help, call nine one one.',
    urgent: 'Pull over as soon as it is safe and call nine one one now.',
    none: "I didn't hear an answer. Please pull over when it is safe. This has been recorded as an emergency.",
    hints: ['yes', 'no', "I'm okay", "I'm fine", 'not okay', 'I need help', 'help', 'call 911'],
  },
  es: {
    ask: (name: string, r: Reason) =>
      `${name ? `${name}, ` : ''}${
        r === 'bpm_high' ? 'tu ritmo cardíaco ha estado inusualmente alto' : r === 'bpm_low' ? 'tu ritmo cardíaco ha estado inusualmente bajo' : 'tu nivel de oxígeno ha estado bajo'
      }. ¿Te sientes bien? Por favor di sí, o no.`,
    again: 'Perdón, no te entendí. ¿Estás bien? Di sí si estás bien, o no si necesitas ayuda.',
    ok: 'Muy bien. Sigo pendiente. Maneja con cuidado.',
    notOk: 'Por favor detente cuando sea seguro. Si necesitas ayuda de emergencia, llama al nueve uno uno.',
    urgent: 'Detente en cuanto sea seguro y llama al nueve uno uno ahora.',
    none: 'No escuché respuesta. Por favor detente cuando sea seguro. Esto quedó registrado como una emergencia.',
    hints: ['sí', 'no', 'estoy bien', 'no estoy bien', 'ayuda', 'necesito ayuda', 'llama al 911'],
  },
} as const;

export class VoiceCheck {
  private buttonAnswer: ((r: 'ok' | 'not_ok') => void) | null = null;
  private done = false;
  private readonly io: VoiceIO;
  private readonly lang: Lang;
  private readonly name: string;

  constructor(io: VoiceIO, lang: Lang, name: string) {
    this.io = io;
    this.lang = lang;
    this.name = name;
  }

  /** The driver tapped a button: ends the check at once. */
  answerByButton(r: 'ok' | 'not_ok') {
    this.buttonAnswer?.(r);
  }

  async run(reason: Reason): Promise<CheckResult> {
    const t = TEXT[this.lang];
    const button = new Promise<'ok' | 'not_ok'>((resolve) => (this.buttonAnswer = resolve));
    const byButton = async (r: 'ok' | 'not_ok'): Promise<CheckResult> => {
      this.io.cancel();
      this.done = true;
      await this.io.speak(r === 'ok' ? t.ok : t.notOk, this.lang).catch(() => undefined);
      return { outcome: r, urgent: false, channel: 'button', attempts: 0, confidence: null };
    };

    let attempts = 0;
    for (const prompt of [t.ask(this.name, reason), t.again]) {
      attempts += 1;
      const heard = await Promise.race([
        (async () => {
          await this.io.speak(prompt, this.lang);
          if (this.done) return null;
          return { text: await this.io.listen(this.lang, LISTEN_MS, [...t.hints]) };
        })(),
        button.then((r) => ({ button: r })),
      ]);
      if (heard && 'button' in heard) return byButton(heard.button);
      const u: Understood = understand(heard?.text ?? null);
      if (u.intent === 'ok' || u.intent === 'not_ok') {
        this.done = true;
        await this.io.speak(u.intent === 'ok' ? t.ok : u.urgent ? t.urgent : t.notOk, this.lang);
        return { outcome: u.intent, urgent: u.urgent, channel: 'voice', attempts, confidence: u.confidence };
      }
    }
    this.done = true;
    await this.io.speak(t.none, this.lang);
    return { outcome: 'no_response', urgent: false, channel: 'none', attempts, confidence: null };
  }
}

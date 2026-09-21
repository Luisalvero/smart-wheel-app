/**
 * Phone implementation of VoiceIO: free, on-device speech in and out.
 *
 * Speaking: expo-speech → the phone's own text-to-speech (iOS
 * AVSpeechSynthesizer, Android TextToSpeech). No network, no cost. We pick the
 * best installed voice for the language: an "Enhanced" voice if the phone has
 * one (free to download on iPhone: Settings → Accessibility → Spoken Content →
 * Voices), otherwise the default.
 *
 * Listening: expo-speech-recognition → iOS SFSpeechRecognizer / Android
 * SpeechRecognizer with requiresOnDeviceRecognition when the device supports
 * it for that language, so audio never leaves the phone. contextualStrings
 * bias the recogniser toward the expected answers ("yes", "no", "I need
 * help"...). If on-device recognition isn't available the OS's own free
 * service is used (no key, no charge). If recognition isn't possible at all
 * (permission denied), listen() simply waits out the window and returns
 * null -- the driver can still answer with the buttons, and silence counts as
 * no response.
 *
 * Nothing is recorded or stored: transcripts only live for the check.
 */
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

import type { Lang, VoiceIO } from './voiceCheck';

const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-US' };

let voiceCache: Partial<Record<Lang, string | null>> = {};

async function bestVoice(lang: Lang): Promise<string | undefined> {
  if (lang in voiceCache) return voiceCache[lang] ?? undefined;
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    const prefix = LOCALE[lang].slice(0, 2);
    const mine = voices.filter((v) => v.language?.toLowerCase().startsWith(prefix));
    const exact = mine.filter((v) => v.language === LOCALE[lang]);
    const pool = exact.length ? exact : mine;
    const pick = pool.find((v) => String(v.quality) === 'Enhanced') ?? pool[0];
    voiceCache[lang] = pick?.identifier ?? null;
  } catch {
    voiceCache[lang] = null;
  }
  return voiceCache[lang] ?? undefined;
}

/** Ask for microphone + speech permission ahead of time (at drive start), so
 *  the first emergency is never blocked by a permission dialog. */
export async function prepareVoice(): Promise<{ granted: boolean; onDevice: boolean }> {
  try {
    const p = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    return { granted: p.granted, onDevice: ExpoSpeechRecognitionModule.supportsOnDeviceRecognition() };
  } catch {
    return { granted: false, onDevice: false };
  }
}

export function phoneVoiceIO(): VoiceIO {
  let cancelListen: (() => void) | null = null;

  return {
    async speak(text, lang) {
      const voice = await bestVoice(lang);
      await new Promise<void>((resolve) => {
        Speech.speak(text, {
          language: LOCALE[lang],
          voice,
          rate: 0.95,
          onDone: () => resolve(),
          onStopped: () => resolve(),
          onError: () => resolve(),
        });
      });
    },

    listen(lang, ms, hints) {
      return new Promise<string | null>((resolve) => {
        let best = '';
        let finished = false;
        const subs: { remove(): void }[] = [];
        const finish = (value: string | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          for (const s of subs) s.remove();
          cancelListen = null;
          try {
            ExpoSpeechRecognitionModule.abort();
          } catch {
            // already stopped
          }
          resolve(value);
        };
        const timer = setTimeout(() => finish(best || null), ms);
        cancelListen = () => finish(null);

        try {
          subs.push(
            ExpoSpeechRecognitionModule.addListener('result', (e) => {
              const text = e.results[0]?.transcript ?? '';
              if (text) best = text;
              if (e.isFinal && best) finish(best);
            }),
            ExpoSpeechRecognitionModule.addListener('error', () => {
              // no-speech, not-allowed, network...: keep the window open so the
              // buttons still work; resolve with whatever was heard at the end.
            }),
          );
          const onDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
          ExpoSpeechRecognitionModule.start({
            lang: LOCALE[lang],
            interimResults: true,
            maxAlternatives: 1,
            continuous: false,
            requiresOnDeviceRecognition: onDevice,
            addsPunctuation: false,
            contextualStrings: hints,
            iosTaskHint: 'confirmation',
          });
        } catch {
          // Recognition unavailable: wait out the window (buttons still work).
        }
      });
    },

    cancel() {
      Speech.stop();
      cancelListen?.();
    },
  };
}

/** For Settings: which languages can be recognised fully on this phone. */
export async function onDeviceLanguages(): Promise<string[]> {
  try {
    const r = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    return r.installedLocales ?? [];
  } catch {
    return [];
  }
}

export function resetVoiceCache() {
  voiceCache = {};
}

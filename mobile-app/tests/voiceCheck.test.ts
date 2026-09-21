import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VoiceCheck, type VoiceIO } from '../lib/voice/voiceCheck.ts';

/** Scripted fake: each listen() returns the next scripted answer. */
function fake(answers: (string | null)[], opts: { listenDelay?: number } = {}) {
  const said: string[] = [];
  let cancelled = 0;
  const io: VoiceIO = {
    speak: async (text) => {
      said.push(text);
    },
    listen: async () => {
      await new Promise((r) => setTimeout(r, opts.listenDelay ?? 1));
      return answers.shift() ?? null;
    },
    cancel: () => {
      cancelled += 1;
    },
  };
  return { io, said, cancelled: () => cancelled };
}

test('"yeah I\'m fine" on the first try → ok, reassured', async () => {
  const f = fake(["yeah i'm fine"]);
  const r = await new VoiceCheck(f.io, 'en', 'Luis').run('bpm_high');
  assert.equal(r.outcome, 'ok');
  assert.equal(r.attempts, 1);
  assert.match(f.said[0]!, /^Luis, your heart rate has been unusually high\. Are you feeling okay\?/);
  assert.match(f.said[1]!, /keep an eye/);
});

test('unclear, then "no I feel dizzy" → not_ok after a second, simpler question', async () => {
  const f = fake(['what', 'no i feel dizzy']);
  const r = await new VoiceCheck(f.io, 'en', '').run('bpm_low');
  assert.deepEqual([r.outcome, r.attempts, r.urgent], ['not_ok', 2, false]);
  assert.match(f.said[1]!, /didn't catch that/);
  assert.match(f.said[2]!, /pull over/);
});

test('silence twice → no_response (treated as an emergency by the caller)', async () => {
  const f = fake([null, null]);
  const r = await new VoiceCheck(f.io, 'en', 'Joss').run('spo2_low');
  assert.equal(r.outcome, 'no_response');
  assert.match(f.said[f.said.length - 1]!, /recorded as an emergency/);
});

test('"help, call 911" → urgent', async () => {
  const f = fake(['help call 911']);
  const r = await new VoiceCheck(f.io, 'en', '').run('bpm_high');
  assert.deepEqual([r.outcome, r.urgent], ['not_ok', true]);
  assert.match(f.said[1]!, /call nine one one now/);
});

test('Spanish: "sí, estoy bien" → ok, spoken in Spanish', async () => {
  const f = fake(['sí estoy bien']);
  const r = await new VoiceCheck(f.io, 'es', 'Joss').run('bpm_high');
  assert.equal(r.outcome, 'ok');
  assert.match(f.said[0]!, /¿Te sientes bien\?/);
});

test('a button press wins immediately, even mid-listen', async () => {
  const f = fake(['yes'], { listenDelay: 200 });
  const check = new VoiceCheck(f.io, 'en', '');
  const p = check.run('bpm_high');
  setTimeout(() => check.answerByButton('not_ok'), 20);
  const r = await p;
  assert.deepEqual([r.outcome, r.channel], ['not_ok', 'button']);
  assert.ok(f.cancelled() >= 1);
});

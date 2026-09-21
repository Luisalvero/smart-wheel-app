import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SafetyController, type SafetyState } from '../lib/analysis/safetyController.ts';
import type { VoiceIO } from '../lib/voice/voiceCheck.ts';

const profile = {
  id: 'p1', custom_id: null, display_name: 'Luis Test', weight_kg: 80, age: 30, height_cm: 180, gender: 'male' as const,
  created_at: '', updated_at: '', conditions: '[]', medications: '[]', language: 'en',
};

function controller(answer: string | null) {
  const saved: unknown[] = [];
  const acks: unknown[] = [];
  const states: SafetyState[] = [];
  const io: VoiceIO = { speak: async () => {}, listen: async () => answer, cancel: () => {} };
  const c = new SafetyController({
    voiceIO: () => io,
    save: async (r) => void saved.push(r),
    saveAck: async (_p, a) => void acks.push(a),
    haptic: () => {},
    onChange: (s) => void states.push(s),
    newId: () => Math.random().toString(36).slice(2),
  });
  c.configure(profile, null, { high: null, low: null });
  return { c, saved, acks, states };
}

test('demo: fabricated high heart rate → warning flag → emergency → voice check; nothing saved or learned', async () => {
  const { c, saved, acks, states } = controller("yeah i'm fine");
  const r = await c.simulate('high_critical');
  assert.equal(r?.outcome, 'ok');
  assert.ok(states.some((s) => s.tracking !== null), 'warning flag shown');
  assert.ok(states.some((s) => s.check?.phase === 'listening'), 'voice check listened');
  assert.deepEqual([saved.length, acks.length], [0, 0]);
  assert.equal(states[states.length - 1]!.demo, null);
});

test('demo: low oxygen with silence → no response', async () => {
  const { c } = controller(null);
  const r = await c.simulate('spo2');
  assert.equal(r?.outcome, 'no_response');
});

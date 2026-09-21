import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { modelProbs, understand, fnv1a, normalise } from '../lib/voice/intent.ts';

const HASHES: Record<string, number> = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'fnv1a.json'), 'utf8'),
);
const fixture: { text: string; label: string; probs: number[] }[] = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'intent_parity.json'), 'utf8'),
);

test('featuriser matches Python (hash + normalisation)', () => {
  // Reference values from tools/intent/train.py's fnv1a().
  for (const [k, h] of Object.entries(HASHES)) assert.equal(fnv1a(k), h, k);
  assert.equal(normalise('¿Sí, ESTOY bien?'), 'si estoy bien');
  assert.equal(normalise("I’m   fine!!"), "i'm fine");
});

test('phone probabilities equal the Python ones for every held-out phrase', () => {
  for (const row of fixture) {
    const p = modelProbs(row.text);
    for (let k = 0; k < 3; k += 1) assert.ok(Math.abs(p[k]! - row.probs[k]!) < 1e-4, `${row.text}: ${p} vs ${row.probs}`);
  }
});

test('held-out phrases: never hears "not ok" as "ok"', () => {
  let correct = 0;
  for (const row of fixture) {
    const u = understand(row.text);
    const got = u.intent === 'silent' ? 'unclear' : u.intent;
    if (row.label === 'not_ok') assert.notEqual(got, 'ok', `critical: ${row.text}`);
    correct += Number(got === row.label);
  }
  assert.ok(correct / fixture.length >= 0.95, `accuracy ${correct}/${fixture.length}`);
});

test('safety rules', () => {
  const cases: [string, string, boolean][] = [
    ['help', 'not_ok', true],
    ['yes I need help', 'not_ok', true],
    ['my chest hurts', 'not_ok', true],
    ['I can\'t breathe', 'not_ok', true],
    ['no I don\'t need help', 'ok', false],
    ['no, I\'m fine', 'ok', false],
    ['I\'m not okay', 'not_ok', false],
    ['I don\'t feel so good', 'not_ok', false],
    ['not bad', 'ok', false],
    ['no estoy bien', 'not_ok', false],
    ['llama al 911', 'not_ok', true],
    ['sí, todo bien', 'ok', false],
    ['', 'silent', false],
  ];
  for (const [text, intent, urgent] of cases) {
    const u = understand(text);
    assert.equal(u.intent, intent, `${text} -> ${u.intent} (${u.reason} ${u.probs})`);
    assert.equal(u.urgent, urgent, `${text} urgent`);
  }
});

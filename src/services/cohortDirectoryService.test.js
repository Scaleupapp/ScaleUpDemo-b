const test = require('node:test');
const assert = require('node:assert');

// Pre-stub openai so requiring the canonicalizer chain doesn't fail.
{
  const openaiPath = require.resolve('../config/openai');
  if (!require.cache[openaiPath]) {
    require.cache[openaiPath] = {
      exports: { chat: { completions: { create: async () => ({ choices: [] }) } } },
      loaded: true, id: openaiPath,
    };
  }
}

const svc = require('./cohortDirectoryService');

test('generatePersonaGhosts: produces 3 stable personas with distinct offsets', () => {
  const a = svc._internal.generatePersonaGhosts('gmat');
  const b = svc._internal.generatePersonaGhosts('gmat');
  assert.equal(a.length, 3);
  assert.deepEqual(a, b, 'same cohort key must produce identical personas');
  const offsets = new Set(a.map(p => p.medianOffset));
  assert.equal(offsets.size, 3, 'three personas should have three distinct offsets');
});

test('generatePersonaGhosts: different cohort keys produce different personas', () => {
  const a = svc._internal.generatePersonaGhosts('gmat');
  const b = svc._internal.generatePersonaGhosts('product-manager');
  assert.notDeepEqual(a.map(p => p.name), b.map(p => p.name));
});

test('personaScoreForWeek: stable for (persona, weekStart)', () => {
  const persona = { name: 'Aanya', medianOffset: 8, seed: 'gmat:0' };
  const week = new Date('2026-05-11');
  const s1 = svc._internal.personaScoreForWeek(persona, week, 70);
  const s2 = svc._internal.personaScoreForWeek(persona, week, 70);
  assert.equal(s1, s2);
});

test('personaScoreForWeek: drifts across weeks within plausible band', () => {
  const persona = { name: 'Aanya', medianOffset: 8, seed: 'gmat:0' };
  const w1 = new Date('2026-05-11');
  const w2 = new Date('2026-05-18');
  const s1 = svc._internal.personaScoreForWeek(persona, w1, 70);
  const s2 = svc._internal.personaScoreForWeek(persona, w2, 70);
  assert.notEqual(s1, s2);
  assert.ok(Math.abs(s1 - s2) <= 10, `drift too large: ${s1} vs ${s2}`);
});

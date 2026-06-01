'use strict';
require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const flags = require('../../config/featureFlags');
const svc = require('../../services/readiness/targetService');

test('computeTarget (no analysis): upskilling=78, casual lower, exam higher', () => {
  assert.strictEqual(svc.computeTarget({ objectiveType: 'upskilling', specifics: {} }), 78);
  assert.strictEqual(svc.computeTarget({ objectiveType: 'casual_learning', specifics: {} }), 60); // 78-18
  assert.strictEqual(svc.computeTarget({ objectiveType: 'exam_preparation', specifics: {} }), 86); // 78+8
  // exam with a named exam -> +2
  assert.strictEqual(svc.computeTarget({ objectiveType: 'exam_preparation', specifics: { examName: 'GMAT' } }), 88);
});

test('computeTarget: named target company raises the bar (+4)', () => {
  const t = svc.computeTarget({ objectiveType: 'interview_preparation', specifics: { targetCompany: 'Google' } });
  // base 78 + interview 6 + company 4 = 88
  assert.strictEqual(t, 88);
});

test('computeTarget: weighted by competency category', () => {
  const objective = { objectiveType: 'upskilling', specifics: {}, analysis: { competencies: [
    { category: 'core', weight: 8 },      // 80
    { category: 'soft_skill', weight: 2 }, // 62
  ] } };
  // (80*8 + 62*2)/10 = 76.4 ; upskilling mod 0 -> 76
  assert.strictEqual(svc.computeTarget(objective), 76);
});

test('computeTarget clamps into [55,95]', () => {
  // casual + all soft_skill would dip low; clamp floor 55
  const low = svc.computeTarget({ objectiveType: 'casual_learning', specifics: {}, analysis: { competencies: [{ category: 'soft_skill', weight: 5 }] } });
  assert.ok(low >= 55);
  // exam + company + all core would push high; clamp ceiling 95
  const high = svc.computeTarget({ objectiveType: 'exam_preparation', specifics: { examName: 'X', targetCompany: 'Y' }, analysis: { competencies: [{ category: 'core', weight: 10 }] } });
  assert.ok(high <= 95);
});

test('targetBands returns competitive < strong < exceptional', () => {
  const b = svc.targetBands(80);
  assert.strictEqual(b.strong, 80);
  assert.ok(b.competitive < b.strong);
  assert.ok(b.exceptional > b.strong);
  assert.ok(b.exceptional <= 98);
});

test('getEffectiveTarget: flag OFF -> 80 (today behavior); flag ON -> computed', () => {
  const objective = { objectiveType: 'exam_preparation', specifics: {} };
  const prev = flags.objectiveTarget;
  flags.objectiveTarget = false;
  assert.strictEqual(svc.getEffectiveTarget(objective), 80);
  flags.objectiveTarget = true;
  assert.strictEqual(svc.getEffectiveTarget(objective), 86); // computeTarget
  // persisted target on the objective wins when present
  assert.strictEqual(svc.getEffectiveTarget({ ...objective, target: 90 }), 90);
  flags.objectiveTarget = prev;
});

test('ensureTarget: flag ON persists target + appends history; flag OFF no-op', async () => {
  const prev = flags.objectiveTarget;
  // flag off -> returns 80, never saves
  flags.objectiveTarget = false;
  let saved = false;
  const docOff = { objectiveType: 'exam_preparation', specifics: {}, save: async () => { saved = true; } };
  const tOff = await svc.ensureTarget(docOff);
  assert.strictEqual(tOff, 80);
  assert.strictEqual(saved, false);

  // flag on -> computes, sets target + history, saves
  flags.objectiveTarget = true;
  const docOn = { objectiveType: 'exam_preparation', specifics: {}, save: async function () { this._saved = true; } };
  const tOn = await svc.ensureTarget(docOn, 'first');
  assert.strictEqual(tOn, 86);
  assert.strictEqual(docOn.target, 86);
  assert.strictEqual(docOn.targetHistory.length, 1);
  assert.strictEqual(docOn.targetHistory[0].reason, 'first');
  assert.strictEqual(docOn._saved, true);
  flags.objectiveTarget = prev;
});

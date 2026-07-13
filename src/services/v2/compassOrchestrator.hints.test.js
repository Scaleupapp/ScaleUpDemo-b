'use strict';

const { test } = require('node:test');
const assert = require('assert');

const {
  buildAgentHints,
  renderDueMisconceptionChecks,
  renderInterviewProgramFocus,
  renderProofJourneyNext,
} = require('./compassOrchestrator');

const ALL_OFF = { proposalsOn: false, misconceptionsOn: false, interviewCoachOn: false, proofBuilderOn: false };

test('buildAgentHints: all off → empty string', () => {
  const hints = buildAgentHints(ALL_OFF);
  assert.strictEqual(hints, '');
});

test('buildAgentHints: proposals only → propose_plan_update present, dueMisconceptionChecks absent', () => {
  const hints = buildAgentHints({ ...ALL_OFF, proposalsOn: true });
  assert.ok(hints.includes('propose_plan_update'));
  assert.ok(!hints.includes('dueMisconceptionChecks'));
});

test('buildAgentHints: misconceptions only → dueMisconceptionChecks present, propose_plan_update absent', () => {
  const hints = buildAgentHints({ ...ALL_OFF, misconceptionsOn: true });
  assert.ok(hints.includes('dueMisconceptionChecks'));
  assert.ok(!hints.includes('propose_plan_update'));
});

test('buildAgentHints: both on → both sentinels present, proposal text first', () => {
  const hints = buildAgentHints({ ...ALL_OFF, proposalsOn: true, misconceptionsOn: true });
  assert.ok(hints.includes('propose_plan_update'));
  assert.ok(hints.includes('dueMisconceptionChecks'));
  assert.ok(hints.indexOf('propose_plan_update') < hints.indexOf('dueMisconceptionChecks'));
});

test('buildAgentHints: interviewCoach off → contributes "" and sentinel absent', () => {
  const hints = buildAgentHints(ALL_OFF);
  assert.strictEqual(hints, '');
  assert.ok(!hints.includes('interviewProgramFocus'));
});

test('buildAgentHints: interviewCoach on → sentinel present', () => {
  const hints = buildAgentHints({ ...ALL_OFF, interviewCoachOn: true });
  assert.ok(hints.includes('interviewProgramFocus'));
  assert.ok(hints.includes("weave tonight's focused session"));
});

test('buildAgentHints: proofBuilder off → contributes "" and sentinel absent', () => {
  const hints = buildAgentHints(ALL_OFF);
  assert.strictEqual(hints, '');
  assert.ok(!hints.includes('proofJourneyNext'));
});

test('buildAgentHints: proofBuilder on → sentinel present', () => {
  const hints = buildAgentHints({ ...ALL_OFF, proofBuilderOn: true });
  assert.ok(hints.includes('proofJourneyNext'));
  assert.ok(hints.includes('remind the learner of that next step'));
});

test('buildAgentHints: all four on → all sentinels present in stable order (proposals, misconceptions, interviewCoach, proofBuilder)', () => {
  const hints = buildAgentHints({
    proposalsOn: true, misconceptionsOn: true, interviewCoachOn: true, proofBuilderOn: true,
  });
  assert.ok(hints.includes('propose_plan_update'));
  assert.ok(hints.includes('dueMisconceptionChecks'));
  assert.ok(hints.includes('interviewProgramFocus'));
  assert.ok(hints.includes('proofJourneyNext'));
  const iProposal = hints.indexOf('propose_plan_update');
  const iMisconception = hints.indexOf('dueMisconceptionChecks');
  const iInterview = hints.indexOf('interviewProgramFocus');
  const iProof = hints.indexOf('proofJourneyNext');
  assert.ok(iProposal < iMisconception);
  assert.ok(iMisconception < iInterview);
  assert.ok(iInterview < iProof);
});

test('renderDueMisconceptionChecks: undefined → empty string', () => {
  assert.strictEqual(renderDueMisconceptionChecks(undefined), '');
});

test('renderDueMisconceptionChecks: empty array → empty string', () => {
  assert.strictEqual(renderDueMisconceptionChecks([]), '');
});

test('renderDueMisconceptionChecks: two items → both tags present, oldest first preserved, stage rendered', () => {
  const items = [
    { tag: 'off-by-one', recentTopic: 'arrays', reviewStage: 1 },
    { tag: 'null-check', recentTopic: 'pointers', reviewStage: 2 },
  ];
  const rendered = renderDueMisconceptionChecks(items);
  assert.ok(rendered.includes('off-by-one'));
  assert.ok(rendered.includes('null-check'));
  assert.ok(rendered.indexOf('off-by-one') < rendered.indexOf('null-check'));
  assert.ok(rendered.includes('stage 1/3'));
  assert.ok(rendered.includes('stage 2/3'));
});

test('renderInterviewProgramFocus: undefined → empty string', () => {
  assert.strictEqual(renderInterviewProgramFocus(undefined), '');
});

test('renderInterviewProgramFocus: dimension absent (baseline needed) → empty string', () => {
  assert.strictEqual(renderInterviewProgramFocus({ dimension: null, score: null, delta: null, reason: 'baseline needed' }), '');
});

test('renderInterviewProgramFocus: full item → dimension, role, reason all present', () => {
  const item = {
    dimension: 'confidence', score: 62, delta: -8, reason: 'lowest latest score',
    targetRole: 'Senior PM', driveDate: '2026-08-01',
  };
  const rendered = renderInterviewProgramFocus(item);
  assert.ok(rendered.includes('confidence'));
  assert.ok(rendered.includes('Senior PM'));
  assert.ok(rendered.includes('lowest latest score'));
});

test('renderProofJourneyNext: undefined → empty string', () => {
  assert.strictEqual(renderProofJourneyNext(undefined), '');
});

test('renderProofJourneyNext: empty object (no status) → empty string', () => {
  assert.strictEqual(renderProofJourneyNext({}), '');
});

test('renderProofJourneyNext: full item → status, next step, suggestion all present', () => {
  const item = {
    status: 'publishable',
    nextStepLabel: 'Publishing your proof',
    nextProofSuggestion: { skill: 'system design', reason: 'not yet evidenced' },
  };
  const rendered = renderProofJourneyNext(item);
  assert.ok(rendered.includes('publishable'));
  assert.ok(rendered.includes('Publishing your proof'));
  assert.ok(rendered.includes('system design'));
});

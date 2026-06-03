// src/test/employer/talentProfileService.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/talentProfileService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  // stub the projection sources
  svc._buildProofSnapshot = async () => ({
    objectiveLabel: 'Backend Engineer', score: 83, target: 80, band: 'Strong',
    competencies: [{ name: 'System Design', score: 91 }],
    evidence: { assessments: 14, capstonesGraded: 3, coveragePct: 92, hoursInvested: 40 },
  });
  svc._countInterviews = async () => 2;
  svc._getOutcomeAchieved = async () => true;
  svc._getActiveProof = async () => ({ token: 'tok123' });

  await ok('buildTalentSnapshot maps + augments', async () => {
    const snap = await svc.buildTalentSnapshot('u1', { objectiveType: 'interview_preparation', specifics: { targetCompany: 'TechCo' } });
    assert.strictEqual(snap.roleLabel, 'Backend Engineer');
    assert.strictEqual(snap.readinessBand, 'Strong');
    assert.strictEqual(snap.readinessScore, 83);
    assert.strictEqual(snap.evidence.interviews, 2);
    assert.strictEqual(snap.evidence.coveragePct, 92);
    assert.strictEqual(snap.achieved, true);
    assert.strictEqual(snap.verified, true);
    assert.strictEqual(snap.proofToken, 'tok123');
    assert.strictEqual(snap.targetCompany, 'TechCo');
  });

  await ok('no active proof -> verified false', async () => {
    svc._getActiveProof = async () => null;
    const snap = await svc.buildTalentSnapshot('u1', { objectiveType: 'interview_preparation' });
    assert.strictEqual(snap.verified, false);
    assert.strictEqual(snap.proofToken, null);
  });

  console.log(`# tests 2\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();

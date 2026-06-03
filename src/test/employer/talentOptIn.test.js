// src/test/employer/talentOptIn.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/talentProfileService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  const objective = { _id: 'obj1', objectiveType: 'interview_preparation', specifics: {} };
  svc._getPrimaryObjective = async () => objective;
  svc.buildTalentSnapshot = async () => ({
    objectiveType: 'interview_preparation', readinessBand: 'Strong', readinessScore: 83,
    evidence: { assessments: 5, capstonesGraded: 0, interviews: 0, coveragePct: 60 },
    achieved: false, verified: false, proofToken: null,
  });
  let upserted = null;
  svc._upsertProfile = async (userId, objId, patch) => { upserted = { userId, objId, patch }; return { ok: true }; };

  await ok('eligible opt-in upserts optedIn=true + snapshot', async () => {
    const r = await svc.optIn('u1', { city: 'Bangalore', workPref: 'hybrid' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(upserted.patch.optedIn, true);
    assert.strictEqual(upserted.patch.city, 'Bangalore');
    assert.strictEqual(upserted.patch.snapshot.readinessScore, 83);
  });

  await ok('no objective -> NO_OBJECTIVE', async () => {
    svc._getPrimaryObjective = async () => null;
    await assert.rejects(() => svc.optIn('u1', {}), /NO_OBJECTIVE/);
  });

  await ok('ineligible objective -> NOT_ELIGIBLE', async () => {
    svc._getPrimaryObjective = async () => ({ _id: 'o2', objectiveType: 'casual_learning', specifics: {} });
    svc.buildTalentSnapshot = async () => ({ objectiveType: 'casual_learning', evidence: { assessments: 5 } });
    await assert.rejects(() => svc.optIn('u1', {}), /NOT_ELIGIBLE/);
  });

  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();

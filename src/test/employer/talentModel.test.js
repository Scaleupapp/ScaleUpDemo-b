// src/test/employer/talentModel.test.js
'use strict';
const assert = require('assert');
const mongoose = require('mongoose');
const TalentProfile = require('../../models/TalentProfile');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('defaults', () => {
  const t = new TalentProfile({ userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId() });
  assert.strictEqual(t.optedIn, false);
  assert.strictEqual(t.status, 'active');
});
ok('snapshot shape accepts evidence + competencies', () => {
  const t = new TalentProfile({
    userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId(),
    snapshot: { roleLabel: 'Backend Engineer', readinessBand: 'Strong', readinessScore: 83,
      competencies: [{ name: 'System Design', score: 91 }],
      evidence: { assessments: 14, capstonesGraded: 3, interviews: 2, coveragePct: 92 },
      achieved: false, verified: true, proofToken: 'abc' },
  });
  assert.strictEqual(t.snapshot.competencies[0].score, 91);
  assert.strictEqual(t.snapshot.evidence.coveragePct, 92);
});
ok('status enum rejects junk', () => {
  const t = new TalentProfile({ userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId(), status: 'nope' });
  const err = t.validateSync();
  assert.ok(err && err.errors.status);
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);

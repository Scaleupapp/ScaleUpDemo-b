// src/test/employer/anonymizer.test.js
'use strict';
const assert = require('assert');
const { anonHandle, toBrowseCard, toAnonymizedProfile } = require('../../services/employer/talentAnonymizer');
const ranking = require('../../services/employer/talentRankingService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

const profile = {
  _id: '0123456789abcdef01234567', userId: 'USERSECRET', city: 'Bangalore', noticePeriod: '30 days', workPref: 'hybrid',
  snapshot: { roleLabel: 'Backend Engineer', objectiveType: 'interview_preparation', readinessBand: 'Exceptional', readinessScore: 88, target: 80,
    competencies: [{ name: 'System Design', score: 91 }, { name: 'APIs', score: 79 }],
    evidence: { assessments: 14, capstonesGraded: 3, interviews: 2, coveragePct: 92 },
    achieved: true, verified: true, proofToken: 'SECRETTOKEN', lastActiveAt: new Date() },
};

ok('anonHandle is stable + 6-digit', () => {
  const h1 = anonHandle('0123456789abcdef01234567'); const h2 = anonHandle('0123456789abcdef01234567');
  assert.strictEqual(h1, h2);
  assert.ok(/^Candidate #\d{6}$/.test(h1));
});
ok('browse card has no PII, includes profileId', () => {
  const c = toBrowseCard(profile);
  const json = JSON.stringify(c);
  assert.ok(!json.includes('USERSECRET'));
  assert.ok(!json.includes('SECRETTOKEN'));
  assert.strictEqual(c.profileId, String(profile._id));
  assert.strictEqual(c.handle, anonHandle(profile._id));
  assert.strictEqual(c.band, 'Exceptional');
  assert.strictEqual(c.score, 88);
  assert.strictEqual(c.achieved, true);
  assert.strictEqual(c.verified, true);
  assert.strictEqual(c.city, 'Bangalore');
  assert.ok(Array.isArray(c.skills) && c.skills.includes('System Design'));
  assert.ok(typeof c.whySummary === 'string' && c.whySummary.length > 0);
});
ok('anonymized profile has competencies + why, no PII/token, includes profileId', () => {
  const p = toAnonymizedProfile(profile);
  const json = JSON.stringify(p);
  assert.ok(!json.includes('USERSECRET'));
  assert.ok(!json.includes('SECRETTOKEN'));
  assert.strictEqual(p.profileId, String(profile._id));
  assert.strictEqual(p.competencies.length, 2);
  assert.strictEqual(p.evidence.assessments, 14);
  assert.ok(Array.isArray(p.why) && p.why[0].key === 'achieved');
  assert.strictEqual(p.handle, anonHandle(profile._id));
});
console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);

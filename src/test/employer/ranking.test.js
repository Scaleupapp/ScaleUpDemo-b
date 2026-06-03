// src/test/employer/ranking.test.js
'use strict';
const assert = require('assert');
const { scoreOne, rank, BAND_RANK } = require('../../services/employer/talentRankingService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

const base = { snapshot: { readinessBand: 'Strong', readinessScore: 80, achieved: false, verified: false,
  evidence: { assessments: 5, capstonesGraded: 0, interviews: 0, coveragePct: 60 }, lastActiveAt: new Date('2020-01-01') } };
function withSnap(p){ return { snapshot: { ...base.snapshot, ...p } }; }

ok('achieved dominates everything', () => {
  const achievedWeak = withSnap({ achieved: true, readinessBand: 'Competitive', readinessScore: 55 });
  const notAchievedStrong = withSnap({ achieved: false, verified: true, readinessBand: 'Exceptional', readinessScore: 95 });
  assert.ok(scoreOne(achievedWeak) > scoreOne(notAchievedStrong));
});
ok('verified beats unverified when achieved equal', () => {
  assert.ok(scoreOne(withSnap({ verified: true })) > scoreOne(withSnap({ verified: false })));
});
ok('higher band beats lower when achieved+verified equal', () => {
  assert.ok(scoreOne(withSnap({ readinessBand: 'Exceptional' })) > scoreOne(withSnap({ readinessBand: 'Strong' })));
});
ok('within same band, higher score wins', () => {
  assert.ok(scoreOne(withSnap({ readinessScore: 88 })) > scoreOne(withSnap({ readinessScore: 82 })));
});
ok('band ordering map', () => {
  assert.ok(BAND_RANK.Exceptional > BAND_RANK.Strong && BAND_RANK.Strong > BAND_RANK.Competitive && BAND_RANK.Competitive > BAND_RANK.Developing);
});
ok('rank sorts descending + is deterministic', () => {
  const a = withSnap({ achieved: true }); const b = withSnap({ verified: true }); const c = withSnap({});
  const out = rank([c, a, b]);
  assert.deepStrictEqual(out.map((x) => x === a ? 'a' : x === b ? 'b' : 'c'), ['a', 'b', 'c']);
});
console.log(`# tests 6\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);

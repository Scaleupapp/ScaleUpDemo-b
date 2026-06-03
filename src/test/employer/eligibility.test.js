// src/test/employer/eligibility.test.js
'use strict';
const assert = require('assert');
const { isEligible, CAREER_INTENT } = require('../../services/employer/talentEligibilityService');
let pass = 0, fail = 0;
function ok(d, fn){ try{ fn(); pass++; }catch(e){ fail++; console.error(d, e.message);} }

ok('career-intent + evidence -> eligible', () => assert.strictEqual(isEligible({ objectiveType: 'interview_preparation', evidenceCount: 3 }), true));
ok('career_switch counts', () => assert.strictEqual(isEligible({ objectiveType: 'career_switch', evidenceCount: 1 }), true));
ok('exam_preparation excluded', () => assert.strictEqual(isEligible({ objectiveType: 'exam_preparation', evidenceCount: 9 }), false));
ok('casual_learning excluded', () => assert.strictEqual(isEligible({ objectiveType: 'casual_learning', evidenceCount: 9 }), false));
ok('career-intent but no evidence -> not eligible', () => assert.strictEqual(isEligible({ objectiveType: 'interview_preparation', evidenceCount: 0 }), false));
ok('CAREER_INTENT has the three', () => assert.strictEqual(CAREER_INTENT.size, 3));
console.log(`# tests 6\n# pass ${pass}\n# fail ${fail}`);
process.exit(fail ? 1 : 0);

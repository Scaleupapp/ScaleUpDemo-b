'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { proveItFor } = require('../../services/readiness/proveItService');

test('prove-it maps objectiveType to the right real-world action', () => {
  assert.equal(proveItFor('interview_preparation').kind, 'interview');
  assert.equal(proveItFor('career_switch').kind, 'interview');
  assert.equal(proveItFor('exam_preparation').kind, 'exam');
  assert.equal(proveItFor('upskilling').kind, 'apply');
  assert.equal(proveItFor('academic_excellence').kind, 'apply');
  assert.equal(proveItFor('casual_learning').kind, 'proof');
  assert.equal(proveItFor('something_unknown').kind, 'proof'); // default
});
test('every action carries a label, route and the universal proof teaser', () => {
  const a = proveItFor('exam_preparation');
  assert.equal(typeof a.label, 'string');
  assert.equal(typeof a.route, 'string');
  assert.equal(a.comingSoonProof, true);
});

'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { optionsFor, labelFor } = require('../../services/readiness/outcomeService');

test('optionsFor returns objective-aware options with a label mapping', () => {
  const iv = optionsFor('interview_preparation');
  assert.ok(iv.find((o) => o.key === 'got_role'));
  assert.equal(labelFor('interview_preparation', 'got_role'), 'SUCCESS');
  assert.equal(labelFor('interview_preparation', 'still_interviewing'), 'PENDING');
  assert.equal(labelFor('exam_preparation', 'passed'), 'SUCCESS');
  assert.equal(labelFor('upskilling', 'partly'), 'PARTIAL');
  assert.equal(labelFor('something_unknown', 'achieved'), 'SUCCESS'); // default set
});
test('labelFor returns null for an unknown choice', () => {
  assert.equal(labelFor('interview_preparation', 'nonsense'), null);
});

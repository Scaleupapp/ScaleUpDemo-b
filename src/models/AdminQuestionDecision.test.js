'use strict';

const { test } = require('node:test');
const assert = require('assert');

test('AdminQuestionDecision model is registered with correct name', () => {
  const Model = require('./AdminQuestionDecision');
  assert.strictEqual(Model.modelName, 'AdminQuestionDecision');
});

test('AdminQuestionDecision schema includes required fields and action enum', () => {
  const Model = require('./AdminQuestionDecision');
  const mongoose = require('mongoose');

  const doc = new Model({
    questionId: new mongoose.Types.ObjectId(),
    adminId:    new mongoose.Types.ObjectId(),
    action:     'approve',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, 'valid doc should pass validation');

  // action enum rejects unknown values
  const bad = new Model({
    questionId: new mongoose.Types.ObjectId(),
    adminId:    new mongoose.Types.ObjectId(),
    action:     'unknown_action',
  });
  const badErr = bad.validateSync();
  assert.ok(badErr && badErr.errors.action, 'should reject invalid action');
});

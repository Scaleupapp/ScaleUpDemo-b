require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { drillGraderQueue, contentGeneratorQueue, contentValidatorQueue } = require('../../coding/workers');

test('coding worker queues — drillGraderQueue has correct name', () => {
  assert.equal(drillGraderQueue.name, 'coding-drill-grader');
});

test('coding worker queues — contentGeneratorQueue has correct name', () => {
  assert.equal(contentGeneratorQueue.name, 'coding-content-generator');
});

test('coding worker queues — contentValidatorQueue has correct name', () => {
  assert.equal(contentValidatorQueue.name, 'coding-content-validator');
});

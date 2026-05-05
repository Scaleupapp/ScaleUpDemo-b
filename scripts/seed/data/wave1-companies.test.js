const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

test('wave1-companies.json: exists and parses', () => {
  const p = path.join(__dirname, 'wave1-companies.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(Array.isArray(data));
  assert.ok(data.length >= 40, `expected >=40 profiles, got ${data.length}`);
});

test('wave1-companies.json: every profile has required fields', () => {
  const data = require('./wave1-companies.json');
  for (const c of data) {
    assert.ok(c.name);
    assert.ok(c.normalizedName);
    assert.ok(c.industry);
    assert.ok(Array.isArray(c.applicableObjectives));
    assert.ok(c.applicableObjectives.length > 0);
    assert.ok(Array.isArray(c.signatureInterviewElements));
    assert.ok(c.signatureInterviewElements.length > 0);
    assert.ok(c.examplesContext);
    assert.strictEqual(c.source, 'curated');
  }
});

test('wave1-companies.json: includes the must-have companies', () => {
  const data = require('./wave1-companies.json');
  const names = new Set(data.map(c => c.normalizedName));
  for (const required of [
    'google', 'microsoft', 'amazon', 'meta', 'apple',
    'razorpay', 'flipkart', 'zomato', 'swiggy', 'cred', 'phonepe',
    'mckinsey', 'bcg', 'bain',
    'goldman-sachs', 'jpmorgan',
    'openai', 'anthropic', 'sarvam', 'krutrim',
  ]) {
    assert.ok(names.has(required), `missing required company: ${required}`);
  }
});

test('wave1-companies.json: amazon profile has Leadership Principles signature', () => {
  const data = require('./wave1-companies.json');
  const amazon = data.find(c => c.normalizedName === 'amazon');
  const hasLP = amazon.signatureInterviewElements.some(e =>
    /leadership principles/i.test(e));
  assert.ok(hasLP, 'Amazon must call out Leadership Principles');
});

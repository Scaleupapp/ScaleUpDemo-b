const test = require('node:test');
const assert = require('node:assert');

delete require.cache[require.resolve('./CompanyProfile')];
const CompanyProfile = require('./CompanyProfile');

test('CompanyProfile: creates with required fields', () => {
  const doc = new CompanyProfile({
    name: 'Razorpay',
    normalizedName: 'razorpay',
    industry: 'Fintech',
    applicableObjectives: ['interview_preparation', 'upskilling'],
    signatureInterviewElements: ['API design depth', 'Payments domain knowledge'],
    topicWeightOverrides: new Map([['api-design', 1.5], ['system-design', 1.3]]),
    examplesContext: 'You are a backend engineer at Razorpay handling UPI flows.',
    source: 'curated',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.normalizedName, 'razorpay');
  assert.strictEqual(doc.topicWeightOverrides.get('api-design'), 1.5);
});

test('CompanyProfile: requires normalizedName', () => {
  const doc = new CompanyProfile({ name: 'X', industry: 'Tech', source: 'curated' });
  const err = doc.validateSync();
  assert.ok(err && err.errors.normalizedName);
});

test('CompanyProfile: invalid source rejected', () => {
  const doc = new CompanyProfile({
    name: 'X',
    normalizedName: 'x',
    industry: 'T',
    source: 'random_source',
  });
  const err = doc.validateSync();
  assert.ok(err && err.errors.source);
});

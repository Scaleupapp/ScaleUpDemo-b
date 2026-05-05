const test = require('node:test');
const assert = require('node:assert');

delete require.cache[require.resolve('./topicTaxonomyService')];
const svc = require('./topicTaxonomyService');

test('buildTargetKey: upskilling with targetSkill', () => {
  const key = svc.buildTargetKey('upskilling', { targetSkill: 'Product Management' });
  assert.strictEqual(key, 'upskilling::product-management');
});

test('buildTargetKey: interview_preparation with targetRole + targetCompany tier', () => {
  const key = svc.buildTargetKey('interview_preparation', {
    targetRole: 'Software Engineer',
    targetCompany: 'FAANG',
  });
  assert.strictEqual(key, 'interview_preparation::software-engineer::faang');
});

test('buildTargetKey: exam_preparation with examName', () => {
  const key = svc.buildTargetKey('exam_preparation', { examName: 'JEE Main' });
  assert.strictEqual(key, 'exam_preparation::jee-main');
});

test('buildTargetKey: career_switch with from + to domains', () => {
  const key = svc.buildTargetKey('career_switch', {
    fromDomain: 'Investment Banking',
    toDomain: 'Product Management',
  });
  assert.strictEqual(key, 'career_switch::investment-banking::product-management');
});

test('buildTargetKey: academic_excellence with board + grade + subject', () => {
  const key = svc.buildTargetKey('academic_excellence', {
    board: 'CBSE',
    grade: '12',
    subject: 'Physics',
  });
  assert.strictEqual(key, 'academic_excellence::cbse::12::physics');
});

test('buildTargetKey: casual_learning falls back to generic', () => {
  const key = svc.buildTargetKey('casual_learning', {});
  assert.strictEqual(key, 'casual_learning::general');
});

test('canonicalize: lowercases and dasherizes', () => {
  assert.strictEqual(svc.canonicalize('Product Management'), 'product-management');
  assert.strictEqual(svc.canonicalize('JEE Main'), 'jee-main');
  assert.strictEqual(svc.canonicalize('  IT  Services  '), 'it-services');
  assert.strictEqual(svc.canonicalize('A&B/C'), 'a-b-c');
  assert.strictEqual(svc.canonicalize(''), '');
});

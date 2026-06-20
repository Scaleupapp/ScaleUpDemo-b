process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const { signInstitutionToken, verifyInstitutionToken } = require('../../services/institution/institutionAuthService');

const user = { _id: 'u1', institutionId: 'i1', role: 'tpo_head', tokenVersion: 0 };

test('signs an institution-typed token and verifies it', () => {
  const decoded = verifyInstitutionToken(signInstitutionToken(user));
  assert.strictEqual(decoded.type, 'institution');
  assert.strictEqual(decoded.institutionUserId, 'u1');
  assert.strictEqual(decoded.institutionId, 'i1');
  assert.strictEqual(decoded.role, 'tpo_head');
});

test('rejects an invalid token', () => {
  assert.throws(() => verifyInstitutionToken('not.a.jwt'));
});

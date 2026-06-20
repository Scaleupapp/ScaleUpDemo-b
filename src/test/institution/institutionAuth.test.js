process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { signInstitutionToken } = require('../../services/institution/institutionAuthService');
const institutionAuth = require('../../middleware/institutionAuth');

function mockRes() { return { statusCode: 0, body: null, status(c){this.statusCode=c;return this;}, json(b){this.body=b;return this;} }; }

test('populates req.institution on a valid token', async () => {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId: 'i1', role: 'tpo_head', status: 'active', tokenVersion: 0, scope: { departmentIds: [] } });
  const token = signInstitutionToken({ _id: 'u1', institutionId: 'i1', role: 'tpo_head', tokenVersion: 0 });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes(); let called = false;
  await institutionAuth(req, res, () => { called = true; });
  assert.strictEqual(called, true);
  assert.strictEqual(req.institution.institutionId, 'i1');
  assert.strictEqual(req.institution.role, 'tpo_head');
});

test('401s when no token', async () => {
  const res = mockRes();
  await institutionAuth({ headers: {} }, res, () => {});
  assert.strictEqual(res.statusCode, 401);
});

test('401s when tokenVersion mismatches (revoked)', async () => {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId: 'i1', role: 'tpo_head', status: 'active', tokenVersion: 5, scope: {} });
  const token = signInstitutionToken({ _id: 'u1', institutionId: 'i1', role: 'tpo_head', tokenVersion: 0 });
  const res = mockRes();
  await institutionAuth({ headers: { authorization: `Bearer ${token}` } }, res, () => {});
  assert.strictEqual(res.statusCode, 401);
});

test('401s when token lacks tokenVersion field (user has tokenVersion: 0)', async () => {
  institutionAuth._loadUser = async () => ({ _id: 'u1', institutionId: 'i1', role: 'tpo_head', status: 'active', tokenVersion: 0, scope: {} });
  const token = jwt.sign(
    { type: 'institution', institutionUserId: 'u1', institutionId: 'i1', role: 'tpo_head' },
    process.env.JWT_ACCESS_SECRET
  );
  const res = mockRes();
  await institutionAuth({ headers: { authorization: `Bearer ${token}` } }, res, () => {});
  assert.strictEqual(res.statusCode, 401);
});

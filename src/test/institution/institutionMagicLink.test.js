process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const svc = require('../../services/institution/institutionAuthService');

test('_hash is stable sha256 hex and _mintToken is non-empty', () => {
  assert.strictEqual(svc._hash('abc'), svc._hash('abc'));
  assert.ok(svc._mintToken().length > 10);
});

test('requestLink sets a token + emails the user (existing), no leak for unknown', async () => {
  const sent = []; let saved = null;
  svc._sendLink = async (email, token, kind) => sent.push({ email, kind, token });
  svc._findByEmail = async (email) => email === 'a@ngit.edu' ? ({ _id: 'u1', email, status: 'active', save: async function () { saved = this; } }) : null;
  await svc.requestLink('a@ngit.edu');
  assert.strictEqual(sent.length, 1);
  assert.ok(saved.authTokenHash && saved.authTokenExpires);
  sent.length = 0;
  await svc.requestLink('nobody@x.edu'); // unknown → no email, no throw
  assert.strictEqual(sent.length, 0);
});

test('verify with a valid token activates the user and returns an institution JWT', async () => {
  const raw = svc._mintToken();
  const user = { _id: 'u1', institutionId: 'i1', role: 'institution_admin', tokenVersion: 0, status: 'invited',
    authTokenHash: svc._hash(raw), authTokenExpires: new Date(Date.now() + 60000), save: async function () {} };
  svc._findByToken = async (h) => h === svc._hash(raw) ? user : null;
  const out = await svc.verify(raw);
  assert.ok(out.token);
  assert.strictEqual(out.institutionId, 'i1');
  assert.strictEqual(user.status, 'active');
  assert.strictEqual(user.authTokenHash, null);
});

test('verify with an expired/invalid token throws TOKEN_INVALID', async () => {
  svc._findByToken = async () => null;
  await assert.rejects(() => svc.verify('nope'), /TOKEN_INVALID/);
});

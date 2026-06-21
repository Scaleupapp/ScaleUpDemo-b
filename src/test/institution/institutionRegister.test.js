// src/test/institution/institutionRegister.test.js
const test = require('node:test');
const assert = require('node:assert');
const svc = require('../../services/institution/institutionAuthService');

test('registerInstitution creates an institution + admin user and emails a verify link', async () => {
  const sent = []; const created = { inst: [], user: [] };
  const Institution = { create: async (d) => { const o = { _id: 'i1', ...d }; created.inst.push(o); return o; } };
  const InstitutionUser = { create: async (d) => { const o = { _id: 'u1', save: async () => {}, ...d }; created.user.push(o); return o; } };
  svc._sendLink = async (e, t, k) => sent.push({ e, k });
  const out = await svc.registerInstitution({ institutionName: 'Northgate IT', adminName: 'Priya', adminEmail: 'priya@ngit.edu' }, { Institution, InstitutionUser });
  assert.strictEqual(out.institutionId, 'i1');
  assert.strictEqual(created.user[0].role, 'institution_admin');
  assert.strictEqual(created.user[0].status, 'invited');
  assert.strictEqual(sent[0].k, 'verify');
});

test('inviteUser rejects a tpo_head creating an institution_admin', async () => {
  await assert.rejects(
    () => svc.inviteUser({ institutionId: 'i1', email: 'x@ngit.edu', role: 'institution_admin', invitedByRole: 'tpo_head' }, {}),
    /FORBIDDEN_ROLE/);
});

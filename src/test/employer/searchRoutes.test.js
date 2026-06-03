// src/test/employer/searchRoutes.test.js
'use strict';
const assert = require('assert');
const h = require('../../routes/employer/search');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }
function res(){ return { code:200, body:null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} }; }

(async () => {
  h._svc.search = async (filters) => ({ total: 1, results: [{ handle: 'Candidate #1234' }], echo: filters });
  await ok('search handler parses query into filters', async () => {
    const r = res();
    await h.searchHandler({ query: { bands: 'Strong,Exceptional', skills: 'System Design', city: 'Bangalore', proof: 'verified' } }, r);
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body.data.echo.bands, ['Strong', 'Exceptional']);
    assert.deepStrictEqual(r.body.data.echo.skills, ['System Design']);
    assert.strictEqual(r.body.data.echo.proof, 'verified');
    assert.strictEqual(r.body.data.results[0].handle, 'Candidate #1234');
  });

  h._svc.getCandidate = async () => ({ handle: 'Candidate #1234', why: [] });
  await ok('candidate handler 200', async () => {
    const r = res();
    await h.candidateHandler({ params: { id: 'abc' } }, r);
    assert.strictEqual(r.body.data.handle, 'Candidate #1234');
  });
  await ok('candidate 404 when null', async () => {
    h._svc.getCandidate = async () => null;
    const r = res();
    await h.candidateHandler({ params: { id: 'gone' } }, r);
    assert.strictEqual(r.code, 404);
  });
  await ok('candidate 400 on CastError (malformed id)', async () => {
    h._svc.getCandidate = async () => { const e = new Error('cast'); e.name = 'CastError'; throw e; };
    const r = res();
    await h.candidateHandler({ params: { id: 'not-a-valid-id' } }, r);
    assert.strictEqual(r.code, 400);
  });
  console.log(`# tests 4\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();

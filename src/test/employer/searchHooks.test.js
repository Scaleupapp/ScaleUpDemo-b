// src/test/employer/searchHooks.test.js
'use strict';
const assert = require('assert');
const search = require('../../services/employer/employerSearchService');
const audit = require('../../services/employer/marketplaceAuditService');
const telemetry = require('../../services/diagnosticTelemetryService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  const events = [];
  // diagnosticTelemetryService emits a single structured payload { event, props, timestamp }.
  telemetry._setEmitter((payload) => events.push(payload.event));
  let viewAudited = false;
  audit.logView = async () => { viewAudited = true; };

  await ok('getCandidate(viewer) audits a view + fires candidate_view event', async () => {
    search._findOne = async () => ({ _id: 'p1', snapshot: { roleLabel: 'BE' } });
    await search.getCandidate('p1', { employerId: 'e1' });
    assert.ok(viewAudited);
    assert.ok(events.includes('marketplace.candidate_view'));
  });
  await ok('search fires a search event', async () => {
    search._find = async () => [];
    await search.search({}, { employerId: 'e1' });
    assert.ok(events.includes('marketplace.search'));
  });
  console.log(`# tests 2\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();

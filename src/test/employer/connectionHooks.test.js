// src/test/employer/connectionHooks.test.js
'use strict';
const assert = require('assert');
const svc = require('../../services/employer/connectionService');
const audit = require('../../services/employer/marketplaceAuditService');
const notify = require('../../services/employer/marketplaceNotificationService');
const telemetry = require('../../services/diagnosticTelemetryService');
let pass = 0, fail = 0;
function ok(d, fn){ return Promise.resolve().then(fn).then(()=>{pass++;}).catch(e=>{fail++;console.error(d, e.message);}); }

(async () => {
  const events = [];
  // diagnosticTelemetryService emits a single structured payload { event, props, timestamp }.
  telemetry._setEmitter((payload) => events.push({ evt: payload.event, props: payload.props }));
  let interestNotified = false, revealAudited = false, employerNotified = false;
  audit.logInterest = async () => {}; audit.logReveal = async () => { revealAudited = true; };
  notify.notifyCandidateOfInterest = async () => { interestNotified = true; };
  notify.notifyEmployerOfApproval = async () => { employerNotified = true; };

  await ok('expressInterest fires candidate notify + interest event', async () => {
    svc._loadProfile = async () => ({ _id: 'p1', userId: 'u1', objectiveId: 'o1', optedIn: true, status: 'active' });
    svc._upsertConnection = async () => ({ _id: 'c1', candidateUserId: 'u1', objectiveId: 'o1', talentProfileId: 'p1', roleContext: 'BE', status: 'requested' });
    await svc.expressInterest('e1', 'p1', { roleContext: 'BE' });
    assert.ok(interestNotified);
    assert.ok(events.find((e) => e.evt === 'marketplace.interest_sent'));
  });

  await ok('respond approved fires reveal audit + employer notify + event', async () => {
    const conn = { _id: 'c1', candidateUserId: 'u1', employerId: 'e1', status: 'requested', save: async function(){ return this; } };
    svc._loadConnectionById = async () => conn;
    await svc.respond('c1', 'u1', 'approved');
    assert.ok(revealAudited && employerNotified);
    assert.ok(events.find((e) => e.evt === 'marketplace.connection_approved'));
  });

  await ok('respond declined fires declined event (no reveal/notify)', async () => {
    const conn = { _id: 'c2', candidateUserId: 'u1', employerId: 'e1', status: 'requested', save: async function(){ return this; } };
    svc._loadConnectionById = async () => conn;
    await svc.respond('c2', 'u1', 'declined');
    assert.ok(events.find((e) => e.evt === 'marketplace.connection_declined'));
  });
  console.log(`# tests 3\n# pass ${pass}\n# fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();

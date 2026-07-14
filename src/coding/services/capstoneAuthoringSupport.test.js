'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { requestGeneration } = require('./capstoneAuthoringSupport');

/** Fake CapstoneGenerationRequest: records exactly what create() was called with. */
function makeCapstoneGenerationRequest({ createShouldFail = false } = {}) {
  const calls = { create: [], findByIdAndUpdate: [] };
  return {
    calls,
    async create(payload) {
      calls.create.push(payload);
      if (createShouldFail) throw new Error('create failed');
      return { _id: 'req1', ...payload };
    },
    findByIdAndUpdate(id, update) {
      calls.findByIdAndUpdate.push({ id, update });
      return { catch: () => Promise.resolve() };
    },
  };
}

function makeWorker({ enqueueShouldFail = false } = {}) {
  const calls = [];
  return {
    calls,
    async enqueueGeneration(id) {
      calls.push(id);
      if (enqueueShouldFail) throw new Error('queue down');
    },
  };
}

test('D2C call (userId given): persists user_id, leaves institution fields unset', async () => {
  const CapstoneGenerationRequest = makeCapstoneGenerationRequest();
  const capstoneGenerationWorker = makeWorker();

  await requestGeneration(
    { userId: 'user1', roleTrack: 'swe', difficulty: 'medium', language: 'python' },
    { CapstoneGenerationRequest, capstoneGenerationWorker }
  );

  const payload = CapstoneGenerationRequest.calls.create[0];
  assert.strictEqual(payload.user_id, 'user1');
  assert.strictEqual(payload.institution_id, undefined);
  assert.strictEqual(payload.cohort_id, undefined);
  assert.strictEqual(payload.assessment_id, undefined);
  assert.strictEqual(payload.requested_by_institution_user, undefined);
});

test('institution call (institutionId given): persists institution fields, leaves user_id unset', async () => {
  const CapstoneGenerationRequest = makeCapstoneGenerationRequest();
  const capstoneGenerationWorker = makeWorker();

  await requestGeneration(
    {
      institutionId: 'inst1',
      cohortId: 'cohort1',
      assessmentId: 'assess1',
      requestedByInstitutionUserId: 'iu1',
      roleTrack: 'swe',
      difficulty: 'medium',
      language: 'python',
    },
    { CapstoneGenerationRequest, capstoneGenerationWorker }
  );

  const payload = CapstoneGenerationRequest.calls.create[0];
  assert.strictEqual(payload.institution_id, 'inst1');
  assert.strictEqual(payload.cohort_id, 'cohort1');
  assert.strictEqual(payload.assessment_id, 'assess1');
  assert.strictEqual(payload.requested_by_institution_user, 'iu1');
  assert.strictEqual(payload.user_id, undefined);
});

test('institution call: an InstitutionUser id (requestedByInstitutionUserId) never lands on user_id', async () => {
  // Regression guard for the original bug: assessment.createdBy (an
  // InstitutionUser id) was being passed straight through as `userId`.
  const CapstoneGenerationRequest = makeCapstoneGenerationRequest();
  const capstoneGenerationWorker = makeWorker();

  await requestGeneration(
    {
      institutionId: 'inst1',
      requestedByInstitutionUserId: 'institutionUser-not-a-real-user-id',
      roleTrack: 'swe',
      difficulty: 'medium',
      language: 'python',
    },
    { CapstoneGenerationRequest, capstoneGenerationWorker }
  );

  const payload = CapstoneGenerationRequest.calls.create[0];
  assert.notStrictEqual(payload.user_id, 'institutionUser-not-a-real-user-id');
  assert.strictEqual(payload.user_id, undefined);
  assert.strictEqual(payload.requested_by_institution_user, 'institutionUser-not-a-real-user-id');
});

test('institution call without a resolvable requestedByInstitutionUserId still enqueues (createdBy is optional)', async () => {
  const CapstoneGenerationRequest = makeCapstoneGenerationRequest();
  const capstoneGenerationWorker = makeWorker();

  const reqDoc = await requestGeneration(
    { institutionId: 'inst1', roleTrack: 'swe', difficulty: 'medium', language: 'python' },
    { CapstoneGenerationRequest, capstoneGenerationWorker }
  );

  assert.strictEqual(reqDoc._id, 'req1');
  assert.strictEqual(capstoneGenerationWorker.calls.length, 1);
  const payload = CapstoneGenerationRequest.calls.create[0];
  assert.strictEqual(payload.institution_id, 'inst1');
  assert.strictEqual(payload.requested_by_institution_user, undefined);
});

test('enqueue failure marks the request failed and re-throws (both ownership modes)', async () => {
  const CapstoneGenerationRequest = makeCapstoneGenerationRequest();
  const capstoneGenerationWorker = makeWorker({ enqueueShouldFail: true });

  await assert.rejects(
    requestGeneration(
      { institutionId: 'inst1', roleTrack: 'swe', difficulty: 'medium', language: 'python' },
      { CapstoneGenerationRequest, capstoneGenerationWorker }
    ),
    /queue down/
  );

  assert.strictEqual(CapstoneGenerationRequest.calls.findByIdAndUpdate.length, 1);
  assert.strictEqual(CapstoneGenerationRequest.calls.findByIdAndUpdate[0].update.$set.status, 'failed');
});

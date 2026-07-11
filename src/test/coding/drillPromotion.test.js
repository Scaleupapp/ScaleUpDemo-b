'use strict';
/**
 * Wave 4 block 2 — drill validated->active promotion gate (drillPromotion.js).
 *
 * Pure unit tests with everything dependency-injected: the LLM judge (llmCall),
 * ArtifactBundle, and HumanReviewQueue are all stubs, so there is no network,
 * DB, or Redis. Exercises: promote on judge pass, reject on any dimension <= 2,
 * fail-closed on judge error/unparseable, and skip for non-drill / non-validated.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const promotion = require('../../coding/services/drillPromotion');

const VALIDATED_DRILL = {
  _id: 'b1',
  type: 'drill',
  status: 'validated',
  drill_subtype: 'refactor',
  role_track: 'swe',
  language: 'javascript',
  difficulty: 'hard',
  time_budget_minutes: 15,
  brief: 'Refactor the rate limiter into a testable TokenBucket.',
  acceptance_criteria: ['TokenBucket exported'],
  rubric_anchors: [{ dimension: 'correctness', check: 'tests pass', weight: 1 }],
  visible_tests: [{ name: 't1' }],
  seeded_mistakes: [{ location: 'rateLimiter.js' }],
};

/** Build an ArtifactBundle stub that records findOneAndUpdate calls. */
function makeBundleStub(doc) {
  const updates = [];
  return {
    updates,
    findById: (id) => ({ lean: async () => (doc && doc._id === id ? doc : null) }),
    findOneAndUpdate: async (filter, update) => { updates.push({ filter, update }); return doc; },
  };
}

/** llmCall stub returning a fixed JSON body (Anthropic content shape). */
function judgeReturning(json) {
  return async () => ({ content: [{ type: 'text', text: JSON.stringify(json) }] });
}

function makeReviewStub() {
  const created = [];
  return { created, create: async (d) => { created.push(d); return d; } };
}

test('promoteBundle: judge pass ⇒ status set active with judge report + attribution', async () => {
  const ArtifactBundle = makeBundleStub({ ...VALIDATED_DRILL });
  const HumanReviewQueue = makeReviewStub();
  const out = await promotion.promoteBundle(
    { bundle_id: 'b1' },
    {
      ArtifactBundle,
      HumanReviewQueue,
      llmCall: judgeReturning({ rubric_quality: 5, task_clarity: 4, difficulty_honesty: 4, notes: 'good' }),
    }
  );
  assert.equal(out.promoted, true);
  assert.equal(ArtifactBundle.updates.length, 1);
  const { filter, update } = ArtifactBundle.updates[0];
  assert.equal(filter.status, 'validated', 'transition is guarded on the validated status');
  assert.equal(update.$set.status, 'active');
  assert.ok(update.$set['generated_by.promoted_at']);
  assert.ok(update.$set['generated_by.promotion_judge']);
  assert.deepEqual(update.$set['generated_by.promotion_judge'].scores, { rubric_quality: 5, task_clarity: 4, difficulty_honesty: 4 });
  assert.equal(HumanReviewQueue.created.length, 0, 'no human review on a pass');
});

test('promoteBundle: any dimension <= 2 ⇒ rejected, stays validated, logged to human review', async () => {
  const ArtifactBundle = makeBundleStub({ ...VALIDATED_DRILL });
  const HumanReviewQueue = makeReviewStub();
  const out = await promotion.promoteBundle(
    { bundle_id: 'b1' },
    {
      ArtifactBundle,
      HumanReviewQueue,
      llmCall: judgeReturning({ rubric_quality: 5, task_clarity: 2, difficulty_honesty: 4 }),
    }
  );
  assert.equal(out.promoted, false);
  // The only write records the judge report; status is NOT set to active.
  assert.equal(ArtifactBundle.updates.length, 1);
  assert.ok(!('status' in ArtifactBundle.updates[0].update.$set), 'must not activate a rejected drill');
  assert.ok('generated_by.promotion_judge' in ArtifactBundle.updates[0].update.$set);
  assert.equal(HumanReviewQueue.created.length, 1);
  assert.equal(HumanReviewQueue.created[0].reason, 'promotion_judge_rejected');
});

test('promoteBundle: judge error ⇒ fails closed (no promotion)', async () => {
  const ArtifactBundle = makeBundleStub({ ...VALIDATED_DRILL });
  const HumanReviewQueue = makeReviewStub();
  const out = await promotion.promoteBundle(
    { bundle_id: 'b1' },
    { ArtifactBundle, HumanReviewQueue, llmCall: async () => { throw new Error('judge down'); } }
  );
  assert.equal(out.promoted, false);
  const activated = ArtifactBundle.updates.some((u) => u.update.$set.status === 'active');
  assert.equal(activated, false, 'a judge outage must never activate a drill');
});

test('promoteBundle: unparseable judge output ⇒ fails closed', async () => {
  const ArtifactBundle = makeBundleStub({ ...VALIDATED_DRILL });
  const out = await promotion.promoteBundle(
    { bundle_id: 'b1' },
    { ArtifactBundle, HumanReviewQueue: makeReviewStub(), llmCall: async () => ({ content: [{ text: 'not json at all' }] }) }
  );
  assert.equal(out.promoted, false);
  assert.ok(!ArtifactBundle.updates.some((u) => u.update.$set.status === 'active'));
});

test('promoteBundle: non-drill bundle is skipped (never touched)', async () => {
  const ArtifactBundle = makeBundleStub({ _id: 'b1', type: 'capstone', status: 'validated' });
  let judged = false;
  const out = await promotion.promoteBundle(
    { bundle_id: 'b1' },
    { ArtifactBundle, HumanReviewQueue: makeReviewStub(), llmCall: async () => { judged = true; return {}; } }
  );
  assert.equal(out.skipped, true);
  assert.equal(judged, false, 'the judge must not run for a capstone');
  assert.equal(ArtifactBundle.updates.length, 0);
});

test('promoteBundle: non-validated (e.g. already active) drill is skipped', async () => {
  const ArtifactBundle = makeBundleStub({ ...VALIDATED_DRILL, status: 'active' });
  const out = await promotion.promoteBundle(
    { bundle_id: 'b1' },
    { ArtifactBundle, HumanReviewQueue: makeReviewStub(), llmCall: judgeReturning({ rubric_quality: 5, task_clarity: 5, difficulty_honesty: 5 }) }
  );
  assert.equal(out.skipped, true);
  assert.equal(ArtifactBundle.updates.length, 0);
});

test('runPromotionJudge: parses a Gemini "parts" response shape too', async () => {
  const res = await promotion.runPromotionJudge(VALIDATED_DRILL, {
    llmCall: async () => ({ content: { parts: [{ text: '```json\n{"rubric_quality":3,"task_clarity":3,"difficulty_honesty":3}\n```' }] } }),
  });
  assert.equal(res.pass, true);
  assert.deepEqual(res.scores, { rubric_quality: 3, task_clarity: 3, difficulty_honesty: 3 });
});

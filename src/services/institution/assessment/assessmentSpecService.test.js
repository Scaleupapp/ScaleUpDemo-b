'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { parseBrief, validateSpec } = require('./assessmentSpecService');

/** Fake aiProvider.analyzeWithClaude that returns a fixed object (or throws). */
function fakeAi(response, { throws } = {}) {
  return {
    async analyzeWithClaude() {
      if (throws) throw new Error(throws);
      return response;
    },
  };
}

// ── parseBrief: happy paths for all four engines ────────────────────────────

test('parseBrief: aptitude brief -> mcq with a clean human topic (not the whole brief)', async () => {
  const aiProvider = fakeAi({
    type: 'mcq',
    title: 'Quantitative Aptitude Test',
    mcq: {
      topic: 'Quantitative Aptitude — arithmetic, ratios, data interpretation',
      questionCount: 20,
      totalQuestions: 30,
      durationSeconds: 1800,
      assessmentType: 'mixed',
    },
  });

  const spec = await parseBrief(
    { brief: 'Give my final-year cohort a 20-question quantitative aptitude test, 30 minutes.', cohortLabel: 'CSE Final Year' },
    { aiProvider }
  );

  assert.strictEqual(spec.type, 'mcq');
  assert.strictEqual(spec.title, 'Quantitative Aptitude Test');
  assert.strictEqual(spec.config.mcq.topic, 'Quantitative Aptitude — arithmetic, ratios, data interpretation');
  assert.strictEqual(spec.config.mcq.questionCount, 20);
  assert.strictEqual(spec.config.mcq.totalQuestions, 30);
  assert.strictEqual(spec.config.mcq.durationSeconds, 1800);
  assert.strictEqual(spec.config.mcq.assessmentType, 'mixed');
  assert.ok(spec.config.mcq.topic.length < 200, 'topic must be a clean label, not a prompt-stuffed blob');
});

test('parseBrief: "build a payment service with seeded bugs" -> capstone', async () => {
  const aiProvider = fakeAi({
    type: 'capstone',
    title: 'Payment Service Capstone',
    capstone: {
      roleTrack: 'swe',
      jobDescription: 'Build a small payment service with several seeded bugs for the candidate to find and fix.',
      difficulty: 'medium',
      durationSeconds: 5400,
    },
  });

  const spec = await parseBrief({ brief: 'Build a payment service with seeded bugs for my SWE cohort' }, { aiProvider });

  assert.strictEqual(spec.type, 'capstone');
  assert.strictEqual(spec.config.capstone.roleTrack, 'swe');
  assert.match(spec.config.capstone.jobDescription, /payment service/i);
  assert.strictEqual(spec.config.capstone.difficulty, 'medium');
  assert.strictEqual(spec.config.capstone.durationSeconds, 5400);
});

test('parseBrief: "45-min technical interview for backend" -> interview', async () => {
  const aiProvider = fakeAi({
    type: 'interview',
    title: 'Backend Technical Interview',
    interview: {
      interviewType: 'placement_technical',
      targetRole: 'Backend Engineer',
      difficulty: 'moderate',
      durationSeconds: 2700,
    },
  });

  const spec = await parseBrief({ brief: 'Run a 45-min technical interview for backend roles' }, { aiProvider });

  assert.strictEqual(spec.type, 'interview');
  assert.strictEqual(spec.config.interview.interviewType, 'placement_technical');
  assert.strictEqual(spec.config.interview.targetRole, 'Backend Engineer');
  assert.strictEqual(spec.config.interview.durationSeconds, 2700);
});

test('parseBrief: "bug-hunt drill on async JS" -> drill', async () => {
  const aiProvider = fakeAi({
    type: 'drill',
    title: 'Async JS Bug Hunt',
    drill: { drillSubtype: 'verify', roleTrack: 'swe', difficulty: 'medium' },
  });

  const spec = await parseBrief({ brief: 'A bug-hunt drill on async JS for my web track students' }, { aiProvider });

  assert.strictEqual(spec.type, 'drill');
  assert.strictEqual(spec.config.drill.drillSubtype, 'verify');
  assert.strictEqual(spec.config.drill.roleTrack, 'swe');
  assert.strictEqual(spec.config.drill.difficulty, 'medium');
});

// ── parseBrief: failure paths ────────────────────────────────────────────

test('parseBrief: empty brief -> throws "could not understand the brief"', async () => {
  await assert.rejects(parseBrief({ brief: '   ' }, { aiProvider: fakeAi({}) }), /could not understand the brief/);
});

test('parseBrief: aiProvider throws (non-JSON per analyzeWithClaude contract) -> throws "could not understand the brief"', async () => {
  const aiProvider = fakeAi(null, { throws: 'analyzeWithClaude: response contained no JSON object' });
  await assert.rejects(parseBrief({ brief: 'do something' }, { aiProvider }), /could not understand the brief/);
});

test('parseBrief: model output with an unrecognizable type and no usable config -> throws', async () => {
  const aiProvider = fakeAi({ type: 'quiz', title: 'x' });
  await assert.rejects(parseBrief({ brief: 'do something' }, { aiProvider }), /could not understand the brief/);
});

// ── validateSpec: mcq repairs ────────────────────────────────────────────

test('validateSpec: mcq totalQuestions defaults to questionCount*1.5, capped at 30', () => {
  const spec = validateSpec({ type: 'mcq', title: 'T', config: { mcq: { questionCount: 25 } } });
  assert.strictEqual(spec.config.mcq.questionCount, 25);
  assert.strictEqual(spec.config.mcq.totalQuestions, 30); // ceil(25*1.5)=38, capped to 30
});

test('validateSpec: mcq totalQuestions above the cap is repaired down to 30', () => {
  const spec = validateSpec({ type: 'mcq', title: 'T', config: { mcq: { questionCount: 10, totalQuestions: 500 } } });
  assert.strictEqual(spec.config.mcq.totalQuestions, 30);
});

test('validateSpec: mcq missing topic falls back to title, not left blank', () => {
  const spec = validateSpec({ type: 'mcq', title: 'Aptitude Round', config: { mcq: {} } });
  assert.strictEqual(spec.config.mcq.topic, 'Aptitude Round');
  assert.strictEqual(spec.config.mcq.questionCount, 20);
  assert.strictEqual(spec.config.mcq.durationSeconds, 1800);
});

// ── validateSpec: capstone repairs ───────────────────────────────────────

test('validateSpec: capstone roleTrack "fullstack" is coerced to a valid enum value', () => {
  const spec = validateSpec({ type: 'capstone', title: 'T', config: { capstone: { roleTrack: 'fullstack', jobDescription: 'x' } } });
  assert.strictEqual(spec.config.capstone.roleTrack, 'swe');
});

test('validateSpec: capstone with an unrecognizable roleTrack and no jobDescription/bundleId synthesizes a jobDescription from the brief', () => {
  const spec = validateSpec({
    type: 'capstone',
    title: 'Payments Capstone',
    brief: 'Build a small payments microservice with a few seeded bugs for backend candidates.',
    config: { capstone: { roleTrack: 'space-pilot' } },
  });
  assert.strictEqual(spec.config.capstone.roleTrack, undefined);
  assert.match(spec.config.capstone.jobDescription, /payments microservice/i);
});

test('validateSpec: capstone with nothing at all (no roleTrack/jobDescription/bundleId/brief) throws', () => {
  assert.throws(
    () => validateSpec({ type: 'capstone', title: 'T', config: { capstone: {} } }),
    /could not understand the brief/
  );
});

test('validateSpec: capstone difficulty/durationSeconds default and invalid difficulty is coerced', () => {
  const spec = validateSpec({ type: 'capstone', title: 'T', config: { capstone: { roleTrack: 'ds', difficulty: 'brutal' } } });
  assert.strictEqual(spec.config.capstone.difficulty, 'medium');
  assert.strictEqual(spec.config.capstone.durationSeconds, 5400);
});

// ── validateSpec: interview repairs ──────────────────────────────────────

test('validateSpec: interview missing interviewType defaults to technical when a targetRole is present', () => {
  const spec = validateSpec({ type: 'interview', title: 'T', config: { interview: { targetRole: 'Backend Engineer' } } });
  assert.strictEqual(spec.config.interview.interviewType, 'placement_technical');
});

test('validateSpec: interview missing interviewType and targetRole defaults to HR', () => {
  const spec = validateSpec({ type: 'interview', title: 'T', config: { interview: {} } });
  assert.strictEqual(spec.config.interview.interviewType, 'placement_hr');
});

// ── validateSpec: drill repairs ───────────────────────────────────────────

test('validateSpec: drill drillSubtype missing -> throws "could not understand the brief"', () => {
  assert.throws(
    () => validateSpec({ type: 'drill', title: 'T', config: { drill: { roleTrack: 'swe' } } }),
    /could not understand the brief/
  );
});

test('validateSpec: drill drillSubtype alias ("bug-hunt") is coerced to a valid enum value', () => {
  const spec = validateSpec({ type: 'drill', title: 'T', config: { drill: { drillSubtype: 'bug-hunt' } } });
  assert.strictEqual(spec.config.drill.drillSubtype, 'verify');
});

test('validateSpec: drill roleTrack "fullstack" is coerced; unrecognizable roleTrack defaults to swe', () => {
  const s1 = validateSpec({ type: 'drill', title: 'T', config: { drill: { drillSubtype: 'refactor', roleTrack: 'fullstack' } } });
  assert.strictEqual(s1.config.drill.roleTrack, 'swe');

  const s2 = validateSpec({ type: 'drill', title: 'T', config: { drill: { drillSubtype: 'refactor', roleTrack: 'astrophysics' } } });
  assert.strictEqual(s2.config.drill.roleTrack, 'swe');
});

// ── validateSpec: type resolution ────────────────────────────────────────

test('validateSpec: unrecognizable type with no usable config block -> throws', () => {
  assert.throws(() => validateSpec({ type: 'nonsense', title: 'T', config: {} }), /could not understand the brief/);
});

test('validateSpec: missing type is inferred from whichever config block has content', () => {
  const spec = validateSpec({ title: 'T', config: { drill: { drillSubtype: 'decompose' } } });
  assert.strictEqual(spec.type, 'drill');
});

test('validateSpec: missing title falls back to a brief-derived title, then a generic default', () => {
  const withBrief = validateSpec({ type: 'drill', brief: 'A decomposition drill for my DS cohort', config: { drill: { drillSubtype: 'decompose' } } });
  assert.strictEqual(withBrief.title, 'A decomposition drill for my DS cohort');

  const withNeither = validateSpec({ type: 'drill', config: { drill: { drillSubtype: 'decompose' } } });
  assert.strictEqual(withNeither.title, 'Untitled Assessment');
});

test('validateSpec: non-object input throws', () => {
  assert.throws(() => validateSpec(null), /could not understand the brief/);
  assert.throws(() => validateSpec('mcq'), /could not understand the brief/);
});

// ── validateSpec: opensAt/closesAt window ────────────────────────────────

test('validateSpec: a valid ordered window is carried through; an inverted one is dropped', () => {
  const good = validateSpec({
    type: 'mcq',
    title: 'T',
    config: { mcq: { topic: 'x' } },
    opensAt: '2026-08-01T00:00:00Z',
    closesAt: '2026-08-02T00:00:00Z',
  });
  assert.ok(good.opensAt instanceof Date);
  assert.ok(good.closesAt instanceof Date);

  const inverted = validateSpec({
    type: 'mcq',
    title: 'T',
    config: { mcq: { topic: 'x' } },
    opensAt: '2026-08-02T00:00:00Z',
    closesAt: '2026-08-01T00:00:00Z',
  });
  assert.strictEqual(inverted.opensAt, undefined);
  assert.strictEqual(inverted.closesAt, undefined);
});

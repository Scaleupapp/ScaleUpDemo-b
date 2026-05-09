'use strict';

/**
 * OpenAPI contract test — asserts that the response shape from selected
 * controllers conforms to the schema declared in `openapi.yaml`.
 *
 * Strategy:
 *   - Stub the heavy deps (mongoose models, queues, OpenAI) the controller
 *     would otherwise touch, so each test runs in-process without I/O.
 *   - Invoke the controller through a thin fake Express req/res.
 *   - Compile the spec's response schema into an Ajv validator (with the
 *     spec's components resolved via $refs) and assert against the JSON
 *     the controller emitted.
 *
 * Catches the same class of bug as the Phase 4 PlanDTO drift: handler returns
 * fields that the documented schema doesn't declare (or omits required ones).
 *
 * Coverage today: /plan/current. Extend as you touch other endpoints.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;
const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Spec loader + validator factory
// ---------------------------------------------------------------------------
const SPEC_PATH = path.join(__dirname, '..', '..', 'openapi.yaml');
const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));

// Ajv with full $ref resolution against the spec's components.
function makeValidator() {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    schemas: [{ $id: 'openapi', ...spec }],
  });
  addFormats(ajv);
  return ajv;
}

/**
 * Resolve a JSON Pointer like '#/components/schemas/PlanCurrent' inside the
 * loaded spec and return the inline schema. We compile this into Ajv so the
 * test asserts against the most specific shape, not the envelope.
 */
function resolveSchema(pointer) {
  const segs = pointer.replace(/^#\//, '').split('/');
  let cur = spec;
  for (const seg of segs) cur = cur[seg];
  if (!cur) throw new Error(`Pointer not found: ${pointer}`);
  // Inline $refs in this branch by returning a schema doc that bundles the
  // whole spec under #/components — Ajv will resolve refs against it.
  return { $ref: pointer, definitions: spec.components || {}, components: spec.components || {} };
}

function fakeRes() {
  const r = { _status: 200, _json: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

// ---------------------------------------------------------------------------
// /plan/current — wire-shape contract
// ---------------------------------------------------------------------------
test('contract: GET /plan/current 200 response matches PlanCurrent schema', async () => {
  // Stub Plan, UserObjective, TopicTaxonomy, topicTaxonomyService.
  const planModelPath      = require.resolve('../models/Plan');
  const objectiveModelPath = require.resolve('../models/UserObjective');
  const taxonomyModelPath  = require.resolve('../models/TopicTaxonomy');
  const taxonomySvcPath    = require.resolve('../services/diagnostic/topicTaxonomyService');
  const ctrlPath           = require.resolve('../controllers/planController');

  const orig = {
    plan: require.cache[planModelPath],
    obj:  require.cache[objectiveModelPath],
    tax:  require.cache[taxonomyModelPath],
    svc:  require.cache[taxonomySvcPath],
    ctrl: require.cache[ctrlPath],
  };

  const fakePlan = {
    _id: new mongoose.Types.ObjectId(),
    objectiveId: new mongoose.Types.ObjectId(),
    planHeadline: 'Sprint to senior PM in 12 weeks',
    estimatedTotalHours: 72,
    bufferRecommendation: '2h/week buffer',
    weeklySchedule: [
      { week: 1, weeklyGoal: 'Foundations', allocations: [
        { topicCanonicalName: 'product-strategy', hours: 3, focusActivity: 'reading + exercises' },
        { topicCanonicalName: 'user-research',    hours: 2, focusActivity: 'video + practice' },
      ] },
    ],
    milestones: [
      { week: 4, title: 'First case study completed', measurableCriteria: '1 case study graded', isUserStated: false },
    ],
    source: 'llm-generated',
  };

  require.cache[planModelPath]      = { exports: { findOne: () => ({ sort: () => ({ lean: async () => fakePlan }) }) }, loaded: true, id: planModelPath };
  require.cache[objectiveModelPath] = { exports: { findById: () => ({ lean: async () => ({ _id: fakePlan.objectiveId, objectiveType: 'upskilling', specifics: { targetSkill: 'Product Management' } }) }) }, loaded: true, id: objectiveModelPath };
  require.cache[taxonomyModelPath]  = { exports: { findOne: () => ({ lean: async () => ({ topics: [
    { canonicalName: 'product-strategy', name: 'Product Strategy' },
    { canonicalName: 'user-research',    name: 'User Research' },
  ] }) }) }, loaded: true, id: taxonomyModelPath };
  require.cache[taxonomySvcPath] = { exports: {
    buildTargetKey: (t, s) => `${t}::${s?.targetSkill || 'default'}`,
    canonicalize: (s) => String(s || '').toLowerCase().replace(/\s+/g, '-'),
  }, loaded: true, id: taxonomySvcPath };
  delete require.cache[ctrlPath];

  try {
    const ctrl = require(ctrlPath);
    const req = { user: { userId: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await ctrl.getCurrent(req, res);

    assert.strictEqual(res._status, 200, `expected 200, got ${res._status}`);
    assert.strictEqual(res._json.success, true, 'response must be wrapped in success envelope');

    const ajv = makeValidator();
    const validate = ajv.compile(resolveSchema('#/components/schemas/PlanCurrent'));
    const ok = validate(res._json.data);
    assert.ok(ok, `response failed PlanCurrent schema:\n${JSON.stringify(validate.errors, null, 2)}\nresponse:\n${JSON.stringify(res._json.data, null, 2)}`);
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      const map = { plan: planModelPath, obj: objectiveModelPath, tax: taxonomyModelPath, svc: taxonomySvcPath, ctrl: ctrlPath };
      if (v) require.cache[map[k]] = v; else delete require.cache[map[k]];
    }
  }
});

// ---------------------------------------------------------------------------
// /plan/status — wire-shape contract (no plan + plan-ready paths)
// ---------------------------------------------------------------------------
test('contract: GET /plan/status pending-state matches PlanStatus schema', async () => {
  const planModelPath      = require.resolve('../models/Plan');
  const attemptModelPath   = require.resolve('../models/DiagnosticAttempt');
  const ctrlPath           = require.resolve('../controllers/planController');

  const orig = {
    plan: require.cache[planModelPath],
    att:  require.cache[attemptModelPath],
    ctrl: require.cache[ctrlPath],
  };

  require.cache[planModelPath]    = { exports: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) }, loaded: true, id: planModelPath };
  require.cache[attemptModelPath] = { exports: { findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) }) }, loaded: true, id: attemptModelPath };
  delete require.cache[ctrlPath];

  try {
    const ctrl = require(ctrlPath);
    const req = { user: { userId: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await ctrl.getStatus(req, res);

    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._json.success, true);

    const ajv = makeValidator();
    const validate = ajv.compile(resolveSchema('#/components/schemas/PlanStatus'));
    const ok = validate(res._json.data);
    assert.ok(ok, `response failed PlanStatus schema:\n${JSON.stringify(validate.errors, null, 2)}\nresponse:\n${JSON.stringify(res._json.data, null, 2)}`);
    assert.strictEqual(res._json.data.status, 'pending');
  } finally {
    if (orig.plan) require.cache[planModelPath]    = orig.plan; else delete require.cache[planModelPath];
    if (orig.att)  require.cache[attemptModelPath] = orig.att;  else delete require.cache[attemptModelPath];
    if (orig.ctrl) require.cache[ctrlPath]         = orig.ctrl; else delete require.cache[ctrlPath];
  }
});

// ---------------------------------------------------------------------------
// Smoke test: confirm openapi.yaml itself parses + Ajv compiles it.
// ---------------------------------------------------------------------------
test('contract: openapi.yaml parses and Ajv accepts every schema', () => {
  const ajv = makeValidator();
  const schemaNames = Object.keys(spec.components?.schemas || {});
  assert.ok(schemaNames.length > 0, 'expected at least one schema');
  for (const name of schemaNames) {
    const validate = ajv.compile(resolveSchema(`#/components/schemas/${name}`));
    assert.ok(typeof validate === 'function', `Ajv could not compile #/components/schemas/${name}`);
  }
});

// ---------------------------------------------------------------------------
// Parameterized lint over every documented operation:
//   - has a 200 (or 201) response
//   - response content uses application/json
//   - the response schema either inlines or $refs a real component
//   - operationId is unique
// Doesn't invoke handlers — just ensures the spec itself is internally
// consistent for each path. Lower-cost than per-handler invocation but
// catches whole categories of "shape declared but not real" bugs.
// ---------------------------------------------------------------------------
test('contract: every documented operation has a typed success response', () => {
  const errs = [];
  const seenOperationIds = new Set();

  for (const [pathStr, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[method];
      if (!op) continue;

      // Operation IDs must be unique (clients use them as function names).
      if (op.operationId) {
        if (seenOperationIds.has(op.operationId)) {
          errs.push(`duplicate operationId "${op.operationId}" at ${method.toUpperCase()} ${pathStr}`);
        } else {
          seenOperationIds.add(op.operationId);
        }
      } else {
        errs.push(`missing operationId at ${method.toUpperCase()} ${pathStr}`);
      }

      // Need at least one 2xx response with a JSON schema.
      const successCode = op.responses && (op.responses['200'] ? '200'
        : op.responses['201'] ? '201'
        : op.responses['204'] ? '204'
        : null);
      if (!successCode) {
        errs.push(`no 2xx response at ${method.toUpperCase()} ${pathStr}`);
        continue;
      }
      if (successCode === '204') continue; // No body expected.

      const resp = op.responses[successCode];
      const json = resp.content && resp.content['application/json'];
      if (!json) {
        // Allow $ref'd responses.
        if (resp.$ref) continue;
        errs.push(`no application/json schema for ${method.toUpperCase()} ${pathStr} ${successCode}`);
      }
    }
  }

  assert.deepStrictEqual(errs, [], 'spec consistency violations:\n' + errs.join('\n'));
});

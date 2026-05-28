'use strict';

/**
 * WS7 unit tests — capstone seed bundles + generator branching.
 *
 * Two suites:
 *   1. All capstone seed JSON files parse + pass bundleSchema Joi validation
 *   2. contentGenerator.generate() routes by type — capstone seeds are
 *      filtered separately from drill seeds (verified via nearestSeeds).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { validateBundle } = require('../../coding/services/bundleSchema');
const { computeContentHash } = require('../../coding/services/contentHash');

const SEED_ROOT = path.join(__dirname, '..', '..', '..', 'seed-content', 'coding', 'capstones');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

test('capstone seeds: every JSON file parses + passes bundleSchema', () => {
  const files = walk(SEED_ROOT);
  assert.ok(files.length >= 3, `expected at least 3 capstone seeds, found ${files.length}`);

  for (const file of files) {
    const rel = path.relative(SEED_ROOT, file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      assert.fail(`parse failed for ${rel}: ${e.message}`);
    }

    // The script strips status / generated_by / content_hash before
    // re-validating — mirror that here.
    delete raw.status;
    delete raw.generated_by;
    const hash = raw.content_hash;
    delete raw.content_hash;

    const reHashed = { ...raw, content_hash: computeContentHash(raw) };
    const { error } = validateBundle(reHashed);
    if (error) {
      const detail = error.details.map((d) => d.message).join('; ');
      assert.fail(`${rel} failed Joi validation: ${detail}`);
    }

    // The content_hash in the file should be present + non-empty (the
    // script overwrites it during load but humans pre-populate it so
    // file diffs are stable).
    assert.ok(hash && typeof hash === 'string', `${rel} missing content_hash`);

    // Capstones must have a starter_repo + visible_tests + hidden_tests.
    assert.equal(reHashed.type, 'capstone', `${rel} not type=capstone`);
    assert.ok(reHashed.starter_repo?.files?.length > 0, `${rel} missing starter_repo`);
    assert.ok(reHashed.visible_tests?.length > 0, `${rel} missing visible_tests`);
    assert.ok(reHashed.hidden_tests?.length > 0, `${rel} missing hidden_tests`);
    // Visible and hidden tests must be DISTINCT (spec §4.2 check 5).
    const visibleCmds = new Set(reHashed.visible_tests.map((t) => t.command));
    for (const h of reHashed.hidden_tests) {
      assert.ok(!visibleCmds.has(h.command), `${rel} test "${h.name}" leaks from hidden into visible`);
    }
  }
});

test('capstone seeds: at least one bundle per role_track', () => {
  const files = walk(SEED_ROOT);
  const byTrack = { swe: 0, ds: 0, ai_eng: 0 };
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.role_track && byTrack[raw.role_track] != null) byTrack[raw.role_track] += 1;
  }
  for (const [track, count] of Object.entries(byTrack)) {
    assert.ok(count >= 1, `no capstone seed bundles for role_track=${track}`);
  }
});

test('contentGenerator.nearestSeeds: filters by type', async () => {
  const generatorPath = require.resolve('../../coding/services/contentGenerator');
  const modelsPath = require.resolve('../../coding/models');
  const orig = { gen: require.cache[generatorPath], models: require.cache[modelsPath] };

  // Mock ArtifactBundle.find to record the filter it was called with.
  let lastFilter;
  const mockBundle = {
    find: (filter) => {
      lastFilter = filter;
      return {
        limit: () => ({
          lean: async () => [],
        }),
      };
    },
  };
  require.cache[modelsPath] = {
    exports: { ...require(modelsPath), ArtifactBundle: mockBundle },
    loaded: true,
    id: modelsPath,
  };
  delete require.cache[generatorPath];

  try {
    const { nearestSeeds } = require(generatorPath);
    await nearestSeeds({ type: 'capstone', role_track: 'swe', difficulty: 'easy' });
    assert.equal(lastFilter.type, 'capstone');
    assert.equal(lastFilter.role_track, 'swe');
    // capstone branch must NOT add drill_subtype to the filter (it'd
    // never match — capstones have no drill_subtype field).
    assert.equal(lastFilter.drill_subtype, undefined);

    await nearestSeeds({
      type: 'drill',
      role_track: 'swe',
      drill_subtype: 'prompt',
      difficulty: 'easy',
    });
    assert.equal(lastFilter.type, 'drill');
    assert.equal(lastFilter.drill_subtype, 'prompt');
  } finally {
    if (orig.gen) require.cache[generatorPath] = orig.gen;
    else delete require.cache[generatorPath];
    if (orig.models) require.cache[modelsPath] = orig.models;
    else delete require.cache[modelsPath];
  }
});

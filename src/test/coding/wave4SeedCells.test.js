'use strict';
/**
 * Wave 4 block 1 — the 6 filled hard drill seed cells.
 *
 * 1. Every cell loads + passes the SAME validation the seed loader applies
 *    (bundleSchema, with content_hash/status/generated_by injected as the
 *    script does), and content hashes are unique.
 * 2. The 3 refactor cells are self-consistent: their visible tests assert the
 *    POST-refactor structure, so the reference_solution contains the required
 *    identifiers while the (buggy) starter does not — the starter therefore
 *    FAILS and the reference PASSES. Statically checked here; additionally
 *    EXECUTED best-effort when a node/python runtime is available.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateBundle } = require('../../coding/services/bundleSchema');
const { computeContentHash } = require('../../coding/services/contentHash');

const SEED_ROOT = path.resolve(__dirname, '../../../seed-content/coding');

const CELLS = [
  { rel: 'ai_eng/hard/prompt-01.json', role: 'ai_eng', sub: 'prompt' },
  { rel: 'ai_eng/hard/refactor-01.json', role: 'ai_eng', sub: 'refactor' },
  { rel: 'ds/hard/prompt-01.json', role: 'ds', sub: 'prompt' },
  { rel: 'ds/hard/refactor-01.json', role: 'ds', sub: 'refactor' },
  { rel: 'swe/hard/prompt-01.json', role: 'swe', sub: 'prompt' },
  { rel: 'swe/hard/refactor-01.json', role: 'swe', sub: 'refactor' },
];

// Identifiers each refactor cell's visible tests probe: present in the
// reference, absent from the buggy starter (that asymmetry is what makes the
// starter fail and the reference pass).
const REFACTOR_IDENTS = {
  'swe/hard/refactor-01.json': ['TokenBucket'],
  'ds/hard/refactor-01.json': ['rolling_stats', 'detect_anomalies'],
  'ai_eng/hard/refactor-01.json': ['cosine_similarity', 'top_k'],
};

function loadRaw(rel) {
  return JSON.parse(fs.readFileSync(path.join(SEED_ROOT, rel), 'utf8'));
}

/** Reproduce the seed loader's candidate object exactly. */
function toCandidate(raw) {
  const r = { ...raw };
  delete r.status; delete r.generated_by; delete r.content_hash;
  const hash = computeContentHash(r);
  return {
    candidate: {
      ...r,
      content_hash: hash,
      status: 'active',
      generated_by: { generator_model: 'human', validator_model: 'human', validated_at: new Date(), human_reviewed: true },
    },
    hash,
  };
}

test('all 6 hard seed cells exist, validate, and are correctly classified', () => {
  const hashes = new Set();
  for (const cell of CELLS) {
    const raw = loadRaw(cell.rel);
    assert.equal(raw.type, 'drill', `${cell.rel} must be a drill`);
    assert.equal(raw.drill_subtype, cell.sub, `${cell.rel} subtype`);
    assert.equal(raw.role_track, cell.role, `${cell.rel} role_track`);
    assert.equal(raw.difficulty, 'hard', `${cell.rel} difficulty`);
    const { candidate, hash } = toCandidate(raw);
    const { error } = validateBundle(candidate);
    assert.equal(error, undefined, `${cell.rel} must pass bundleSchema: ${error && error.message}`);
    assert.ok(!hashes.has(hash), `${cell.rel} content hash must be unique`);
    hashes.add(hash);
  }
  assert.equal(hashes.size, 6);
});

test('refactor cells are statically self-consistent (starter lacks / reference has the probed identifiers)', () => {
  for (const [rel, idents] of Object.entries(REFACTOR_IDENTS)) {
    const raw = loadRaw(rel);
    assert.ok(raw.starter_repo && raw.starter_repo.files.length > 0, `${rel} needs a starter`);
    assert.ok(raw.reference_solution && raw.reference_solution.files.length > 0, `${rel} needs a reference`);
    assert.ok((raw.visible_tests || []).length >= 2, `${rel} needs >= 2 visible tests`);
    for (const t of raw.visible_tests) {
      assert.ok(t.command && t.command.length > 0, `${rel} test ${t.name} needs a command`);
      assert.equal(t.expected_exit_code, 0, `${rel} test ${t.name} expects exit 0`);
    }
    const starterSrc = raw.starter_repo.files.map((f) => f.content).join('\n');
    const refSrc = raw.reference_solution.files.map((f) => f.content).join('\n');
    for (const id of idents) {
      assert.ok(refSrc.includes(id), `${rel} reference must define ${id}`);
      assert.ok(!starterSrc.includes(id), `${rel} buggy starter must NOT define ${id} (so it fails the suite)`);
    }
    // Seeded-mistake locations must reference a real bundle file (referential
    // ground truth mirrored from contentValidator.checkSeededMistakesFail).
    const filePaths = new Set([
      ...raw.starter_repo.files.map((f) => f.path),
      ...raw.reference_solution.files.map((f) => f.path),
    ]);
    for (const m of raw.seeded_mistakes || []) {
      const loc = String(m.location);
      const isFileRef = filePaths.has(loc);
      const isCategory = /^common_/.test(loc); // narrative bucket used by prompt/decompose
      assert.ok(isFileRef || isCategory, `${rel} seeded_mistake location "${loc}" must reference a real file`);
    }
  }
});

// ── Best-effort execution: starter FAILS, reference PASSES ────────────────────

function resolveBin(name) {
  const which = spawnSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
  return which.status === 0 ? name : null;
}

function runCell(rel, bin) {
  const raw = loadRaw(rel);
  const tests = raw.visible_tests || [];
  const run = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedcell-'));
    for (const f of files) {
      const p = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
    }
    const results = tests.map((t) => {
      let cmd = t.command;
      if (bin && bin !== 'python') cmd = cmd.replace(/\bpython\b(?!3)/g, bin);
      const r = spawnSync('bash', ['-lc', cmd], { cwd: dir, encoding: 'utf8' });
      const exit = r.status === null ? 1 : r.status;
      const outOk = (t.expected_output_contains || []).every((s) => (r.stdout + r.stderr).includes(s));
      return exit === (t.expected_exit_code || 0) && outOk;
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return results;
  };
  const byPath = new Map();
  for (const f of raw.starter_repo.files) byPath.set(f.path, f);
  const refMerged = new Map(byPath);
  for (const f of raw.reference_solution.files) refMerged.set(f.path, f);
  return {
    starter: run([...byPath.values()]),
    reference: run([...refMerged.values()]),
  };
}

test('refactor cells execute correctly when a runtime is available (best-effort)', () => {
  const bins = { swe: resolveBin('node'), ds: resolveBin('python3') || resolveBin('python'), ai_eng: resolveBin('python3') || resolveBin('python') };
  let executedAny = false;
  for (const rel of Object.keys(REFACTOR_IDENTS)) {
    const role = rel.split('/')[0];
    const bin = bins[role];
    if (!bin) { continue; } // runtime unavailable on this host — static checks already covered it
    executedAny = true;
    const { starter, reference } = runCell(rel, bin);
    assert.ok(starter.some((p) => p === false), `${rel} buggy starter must FAIL at least one visible test`);
    assert.ok(reference.every((p) => p === true), `${rel} reference must PASS every visible test`);
  }
  if (!executedAny) {
    // eslint-disable-next-line no-console
    console.log('[wave4SeedCells] no node/python runtime resolved — execution skipped, static checks stand');
  }
});

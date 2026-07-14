'use strict';
/**
 * questionQaService — 3-gate quality assurance for authored MCQ items.
 *
 * This service is used EXCLUSIVELY by the institution authoring path
 * (assessmentAuthoringService.authorMcq). It never touches the D2C quiz
 * generation flow. All LLM calls are dependency-injected so tests run with
 * zero real network/DB access.
 *
 *   Gate 1 — deterministic lint (pure functions, exported individually):
 *     schema · 4-distinct-options · single-key · letter-distribution (set) ·
 *     length-bias · stem-keyword-leak · topic-echo · dedup (set, Jaccard).
 *   Gate 2 — blind solve (cross-model): send stem+options ONLY (no key, no
 *     explanation) to a DIFFERENT model family than the generator (generator =
 *     OpenAI gpt-4o; solver = Anthropic via aiProvider.analyzeWithClaude).
 *     Mismatch ⇒ REJECT. Confidence < 0.6 ⇒ flag `ambiguous`.
 *   Gate 3 — LLM-as-judge: score 1-5 on clarity / single-defensible-answer /
 *     distractor-plausibility / difficulty-honesty / topic-relevance. Any
 *     dimension ≤ 2 ⇒ REJECT.
 *
 * runQa(questions, ctx, deps) orchestrates all three gates and returns
 *   { passed[], rejected[{ question, reasons }], report }.
 * Each passed question gets a `qa` object attached for persistence:
 *   qa = { lint, solver, judge, generation }.
 */

// ── Normalization ───────────────────────────────────────────────────────────

/** Distinctive-token minimum length used by stem-leak + topic-echo heuristics. */
const KEYWORD_MIN_LEN = 7;
const TOPIC_TOKEN_MIN_LEN = 4;
const LENGTH_BIAS_RATIO = 1.4; // key > 40% longer than mean distractor fails
const LETTER_SKEW_RATIO = 0.45; // > 45% of keys on one letter fails (set-level)
const DEDUP_JACCARD = 0.8; // normalized-stem Jaccard > 0.8 ⇒ duplicate
const SOLVER_MIN_CONFIDENCE = 0.6;
const JUDGE_MIN_SCORE = 3; // any dimension ≤ 2 fails
const JUDGE_DIMENSIONS = ['clarity', 'singleAnswer', 'distractorPlausibility', 'difficultyHonesty', 'topicRelevance'];

function letterOf(i) { return String.fromCharCode(65 + i); }

/** Normalize a raw question into { stem, options:[{label,text}], keyIndex }. */
function normalizeQuestion(q) {
  const stem = String((q && (q.questionText || q.question || q.stem)) || '').trim();
  const rawOpts = (q && q.options) || [];
  const options = rawOpts.map((o, i) => {
    if (o == null) return { label: letterOf(i), text: '' };
    if (typeof o === 'string') return { label: letterOf(i), text: o };
    return {
      label: o.label || letterOf(i),
      text: o.text != null ? String(o.text) : String(o),
    };
  });
  const keyIndex = resolveKeyIndex(q, options);
  return { stem, options, keyIndex };
}

/** Resolve the correct-option index from correctAnswer (index | letter | label | text). */
function resolveKeyIndex(q, options) {
  const ca = q && q.correctAnswer;
  if (ca == null) return -1;
  if (typeof ca === 'number') return ca >= 0 && ca < options.length ? ca : -1;
  const target = String(ca).trim();
  // Exact label match first
  let idx = options.findIndex((o) => o.label === target);
  if (idx >= 0) return idx;
  // Single-letter answer (A/B/C/D)
  if (/^[A-Za-z]$/.test(target)) {
    const li = target.toUpperCase().charCodeAt(0) - 65;
    if (li >= 0 && li < options.length) return li;
  }
  // Fall back to option text
  idx = options.findIndex((o) => o.text === target);
  return idx;
}

/** Lowercase alnum word tokens of a string. */
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// ── Gate 1: per-item lint checks (each pure, each exported) ──────────────────

/** Schema: non-empty stem, options array present, resolvable key. */
function checkSchema(q) {
  const { stem, options, keyIndex } = normalizeQuestion(q);
  if (!stem) return 'missing_stem';
  if (!Array.isArray(options) || options.length === 0) return 'no_options';
  if (options.some((o) => !o.text || !o.text.trim())) return 'empty_option';
  if (keyIndex < 0) return 'unresolved_key';
  return null;
}

/** Exactly 4 distinct options. */
function checkFourDistinctOptions(q) {
  const { options } = normalizeQuestion(q);
  if (options.length !== 4) return 'not_four_options';
  const seen = new Set();
  for (const o of options) {
    const norm = o.text.trim().toLowerCase();
    if (seen.has(norm)) return 'duplicate_options';
    seen.add(norm);
  }
  return null;
}

/** Exactly one resolvable key that is not shared by another option. */
function checkSingleKey(q) {
  const { options, keyIndex } = normalizeQuestion(q);
  if (keyIndex < 0 || keyIndex >= options.length) return 'no_single_key';
  const keyText = options[keyIndex].text.trim().toLowerCase();
  const matches = options.filter((o) => o.text.trim().toLowerCase() === keyText).length;
  if (matches !== 1) return 'ambiguous_key';
  return null;
}

/** Correct option must not be > (ratio-1)*100% longer than the mean distractor. */
function checkLengthBias(q) {
  const { options, keyIndex } = normalizeQuestion(q);
  if (keyIndex < 0 || options.length < 2) return null;
  const keyLen = options[keyIndex].text.length;
  const distractors = options.filter((_, i) => i !== keyIndex);
  const meanDistractor = distractors.reduce((s, o) => s + o.text.length, 0) / distractors.length;
  if (meanDistractor <= 0) return null;
  if (keyLen > meanDistractor * LENGTH_BIAS_RATIO) return 'length_bias';
  return null;
}

/** No distinctive (≥7-char) token shared by stem AND key but absent from every distractor. */
function checkStemKeywordLeak(q) {
  const { stem, options, keyIndex } = normalizeQuestion(q);
  if (keyIndex < 0) return null;
  const stemTokens = new Set(tokenize(stem).filter((t) => t.length >= KEYWORD_MIN_LEN));
  if (stemTokens.size === 0) return null;
  const keyTokens = tokenize(options[keyIndex].text).filter((t) => t.length >= KEYWORD_MIN_LEN);
  const distractorTokens = new Set();
  options.forEach((o, i) => {
    if (i === keyIndex) return;
    tokenize(o.text).forEach((t) => distractorTokens.add(t));
  });
  for (const t of keyTokens) {
    if (stemTokens.has(t) && !distractorTokens.has(t)) return 'stem_keyword_leak';
  }
  return null;
}

/** Longest raw-token length eligible for the prefix-overlap comparison in checkTopicEcho. */
const TOPIC_PREFIX_MIN_LEN = 5;
/** Truncation length for the topic-echo stemmer (see stemToken doc comment). */
const STEM_PREFIX_LEN = 6;

/**
 * stemToken(t) — total, conservative morphological stem for a lowercase word,
 * used ONLY by checkTopicEcho's cheap "did the topic get mentioned at all"
 * heuristic (not by dedup/keyword-leak, which need exact tokens).
 *
 * Approach: truncate to the first STEM_PREFIX_LEN (6) characters for any
 * token that long or longer; shorter tokens pass through unchanged. A real
 * suffix-stripping stemmer (Porter etc.) is overkill here and has its own
 * edge cases (irregular plurals, "-ion"/"-ies" ambiguity); a fixed prefix is
 * simple, predictable, and total (never throws, no dictionary needed). It
 * collapses the exact family this bug was about: "probability" / "probabilities"
 * / "probabilistic" all truncate to "probab". It intentionally does NOT
 * guarantee every plural/suffix pair collapses (e.g. "work" vs "workers"
 * truncate to "work" vs "worker" — different) — that gap is covered by the
 * prefix-overlap check below, so the two rules together are the fix, not
 * stemToken alone.
 *
 * @param {string} t
 * @returns {string} lowercased, truncated stem; '' for nullish/empty input.
 */
function stemToken(t) {
  const s = String(t == null ? '' : t).toLowerCase();
  return s.length >= STEM_PREFIX_LEN ? s.slice(0, STEM_PREFIX_LEN) : s;
}

/**
 * Each item should name-check the requested topic domain — a CHEAP guard
 * against wildly off-topic generations, not the authoritative relevance
 * check. The authoritative gate is the LLM judge's `topicRelevance` score
 * (Gate 3, JUDGE_DIMENSIONS) — it already reads the topic, syllabus excerpt,
 * and full question, and correctly rejects genuinely off-topic items. This
 * lint exists only to save generation/QA budget on obvious misses before
 * spending an LLM call. Being strict here has no upside: it only burns
 * generation budget on false rejections (a plural, a gerund, a synonym) that
 * the judge would have passed anyway. Prod incident: topic "Probabilities"
 * rejected 52/67 good questions over "probability" vs "probabilities" alone.
 *
 * Matches (any one is sufficient — only reject when NONE hold):
 *   1. A stemmed topic token equals a stemmed haystack token.
 *   2. A topic token is a raw prefix of a haystack token, or vice versa,
 *      where the longer of the two is >= TOPIC_PREFIX_MIN_LEN chars (avoids
 *      noise matches off very short words).
 *   3. The above also runs against the question's own `concept`/`competency`
 *      metadata fields (set by the generator — see models/Quiz.js), folded
 *      into the haystack, so a correctly-tagged question is never rejected
 *      just because the stem itself phrases the topic differently.
 */
function checkTopicEcho(q, topic) {
  if (!topic) return null;
  const topicTokens = tokenize(topic).filter((t) => t.length >= TOPIC_TOKEN_MIN_LEN);
  if (topicTokens.length === 0) return null;
  const { stem, options } = normalizeQuestion(q);
  const metaText = [q && q.concept, q && q.competency].filter(Boolean).join(' ');
  const haystackTokens = tokenize(stem + ' ' + options.map((o) => o.text).join(' ') + ' ' + metaText);
  const stemmedHaystack = new Set(haystackTokens.map(stemToken));

  const anyMatch = topicTokens.some((tt) => {
    if (stemmedHaystack.has(stemToken(tt))) return true;
    return haystackTokens.some((ht) => {
      const longer = Math.max(tt.length, ht.length);
      if (longer < TOPIC_PREFIX_MIN_LEN) return false;
      return tt.length <= ht.length ? ht.startsWith(tt) : tt.startsWith(ht);
    });
  });
  return anyMatch ? null : 'topic_echo_missing';
}

/** Per-item lint: run all per-item checks. Returns { passed, failures[] }. */
function lintQuestion(q, ctx = {}) {
  const failures = [];
  const perItem = [
    checkSchema(q),
    checkFourDistinctOptions(q),
    checkSingleKey(q),
    checkLengthBias(q),
    checkStemKeywordLeak(q),
    checkTopicEcho(q, ctx.topic),
  ];
  for (const r of perItem) if (r) failures.push(r);
  return { passed: failures.length === 0, failures };
}

// ── Gate 1: set-level checks ─────────────────────────────────────────────────

/** Correct-letter distribution across a set. >45% on one letter fails. */
function checkLetterDistribution(questions) {
  const counts = {};
  let total = 0;
  for (const q of questions) {
    const { options, keyIndex } = normalizeQuestion(q);
    if (keyIndex < 0 || keyIndex >= options.length) continue;
    const letter = letterOf(keyIndex);
    counts[letter] = (counts[letter] || 0) + 1;
    total += 1;
  }
  let dominantLetter = null;
  let dominantCount = 0;
  for (const [letter, c] of Object.entries(counts)) {
    if (c > dominantCount) { dominantCount = c; dominantLetter = letter; }
  }
  const ratio = total > 0 ? dominantCount / total : 0;
  return { passed: total === 0 ? true : ratio <= LETTER_SKEW_RATIO, dominantLetter, ratio, counts, total };
}

/** Jaccard similarity of two normalized-stem token sets. */
function stemJaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Intra-set dedup: flag any later item whose normalized-stem Jaccard vs an
 * earlier item exceeds the threshold. Returns [{ index, dupOf, similarity }].
 */
function checkDedup(questions) {
  const dups = [];
  for (let i = 1; i < questions.length; i++) {
    const stemI = normalizeQuestion(questions[i]).stem;
    for (let j = 0; j < i; j++) {
      const stemJ = normalizeQuestion(questions[j]).stem;
      const sim = stemJaccard(stemI, stemJ);
      if (sim > DEDUP_JACCARD) { dups.push({ index: i, dupOf: j, similarity: sim }); break; }
    }
  }
  return dups;
}

/**
 * Gate-1 structural filter for the SHARED generation path (D2C + institution).
 *
 * Pure code, no LLM, ~ms. Drops only the unambiguous bug classes — malformed
 * (schema / not-4-distinct / no-single-key), leaky (stem-keyword-leak), and
 * intra-set duplicates — so it is behavior-preserving for D2C: valid questions
 * are never dropped. The softer heuristics (length-bias, topic-echo) and the
 * cross-model / judge gates stay in the institution authoring path only.
 *
 * Dedup is scoped to THIS quiz's set: new items are checked against `existing`
 * (already-kept items) so the caller's top-up loop refills dropped slots.
 *
 * @param {Array}  questions - newly generated candidates
 * @param {object} opts      - { existing: Array (already-kept items) }
 * @returns {{ kept: Array, dropped: Array<{question, reason}> }}
 *   `kept` = existing + accepted new items (in order).
 */
function gate1Filter(questions, opts = {}) {
  const kept = Array.isArray(opts.existing) ? opts.existing.slice() : [];
  const dropped = [];
  for (const q of (Array.isArray(questions) ? questions : [])) {
    const structural = checkSchema(q) || checkFourDistinctOptions(q) || checkSingleKey(q) || checkStemKeywordLeak(q);
    if (structural) { dropped.push({ question: q, reason: structural }); continue; }
    // Duplicate of an already-kept item in this same quiz?
    const dupes = checkDedup(kept.concat([q]));
    if (dupes.some((d) => d.index === kept.length)) { dropped.push({ question: q, reason: 'duplicate' }); continue; }
    kept.push(q);
  }
  return { kept, dropped };
}

// ── Gate 2: blind solve (cross-model) ────────────────────────────────────────

const SOLVER_SYSTEM_PROMPT =
  'You are a careful test-taker. You will be given a multiple-choice question and ' +
  'its options. Choose the single best answer using only your own knowledge. ' +
  'Respond with ONLY valid JSON: {"answer":"A|B|C|D","confidence":0.0-1.0}. ' +
  'confidence is how sure you are that exactly one option is defensibly correct.';

function shapeSolver(result, options, keyIndex) {
  const out = { answer: null, agrees: false, confidence: 0, ambiguous: true, valid: false };
  if (!result || typeof result !== 'object') return out;
  const ans = result.answer != null ? String(result.answer).trim().toUpperCase() : null;
  const conf = typeof result.confidence === 'number' ? result.confidence : Number(result.confidence);
  if (!ans || !/^[A-Z]$/.test(ans)) return out;
  out.answer = ans;
  out.confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0;
  out.valid = true;
  const ansIndex = ans.charCodeAt(0) - 65;
  out.agrees = ansIndex === keyIndex;
  out.ambiguous = out.confidence < SOLVER_MIN_CONFIDENCE;
  return out;
}

/** Blind-solve a single question. deps.analyzeWithClaude is required (DI). */
async function blindSolve(q, deps = {}) {
  const analyze = deps.analyzeWithClaude
    || (deps.aiProvider && deps.aiProvider.analyzeWithClaude.bind(deps.aiProvider))
    || require('../../../config/aiProvider').analyzeWithClaude.bind(require('../../../config/aiProvider'));
  const { stem, options, keyIndex } = normalizeQuestion(q);
  const userPrompt = JSON.stringify({
    question: stem,
    options: options.map((o) => ({ label: o.label, text: o.text })),
  });
  let result;
  try {
    result = await analyze({ systemPrompt: SOLVER_SYSTEM_PROMPT, userPrompt, temperature: 0, maxTokens: 300 });
  } catch (err) {
    return { answer: null, agrees: false, confidence: 0, ambiguous: true, valid: false, error: err.message };
  }
  return shapeSolver(result, options, keyIndex);
}

// ── Gate 3: LLM-as-judge ─────────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT =
  'You are a strict assessment quality reviewer. Score the multiple-choice ' +
  'question on five dimensions, each an INTEGER from 1 (very poor) to 5 ' +
  '(excellent):\n' +
  '- clarity: is the stem unambiguous and self-contained?\n' +
  '- singleAnswer: is exactly one option defensibly correct (the marked key)?\n' +
  '- distractorPlausibility: are the wrong options plausible, not throwaways?\n' +
  '- difficultyHonesty: does the item match its claimed difficulty label?\n' +
  '- topicRelevance: is the item on the requested topic/syllabus?\n' +
  'Respond with ONLY valid JSON: ' +
  '{"scores":{"clarity":n,"singleAnswer":n,"distractorPlausibility":n,' +
  '"difficultyHonesty":n,"topicRelevance":n},"notes":"short"}.';

function shapeJudge(result) {
  const out = { scores: {}, verdict: 'reject', valid: false, notes: '' };
  if (!result || typeof result !== 'object' || !result.scores || typeof result.scores !== 'object') {
    out.reasons = ['judge_invalid'];
    return out;
  }
  const scores = {};
  const low = [];
  for (const dim of JUDGE_DIMENSIONS) {
    const v = Number(result.scores[dim]);
    if (!Number.isFinite(v)) { out.reasons = ['judge_invalid']; return out; }
    scores[dim] = v;
    if (v < JUDGE_MIN_SCORE) low.push(dim);
  }
  out.scores = scores;
  out.notes = typeof result.notes === 'string' ? result.notes : '';
  out.valid = true;
  out.verdict = low.length === 0 ? 'accept' : 'reject';
  if (low.length) out.reasons = low.map((d) => `judge_low_${d}`);
  return out;
}

/** Judge a single question. deps.analyzeWithClaude is required (DI). */
async function judgeQuestion(q, ctx = {}, deps = {}) {
  const analyze = deps.analyzeWithClaude
    || (deps.aiProvider && deps.aiProvider.analyzeWithClaude.bind(deps.aiProvider))
    || require('../../../config/aiProvider').analyzeWithClaude.bind(require('../../../config/aiProvider'));
  const { stem, options, keyIndex } = normalizeQuestion(q);
  const userPrompt = JSON.stringify({
    topic: ctx.topic || null,
    syllabusExcerpt: ctx.syllabusExcerpt ? String(ctx.syllabusExcerpt).slice(0, 2000) : null,
    claimedDifficulty: q.difficulty || null,
    question: stem,
    options: options.map((o) => ({ label: o.label, text: o.text })),
    markedKey: keyIndex >= 0 ? letterOf(keyIndex) : null,
    explanation: q.explanation || null,
  });
  let result;
  try {
    result = await analyze({ systemPrompt: JUDGE_SYSTEM_PROMPT, userPrompt, temperature: 0, maxTokens: 500 });
  } catch (err) {
    return { scores: {}, verdict: 'reject', valid: false, notes: '', reasons: ['judge_error'] };
  }
  return shapeJudge(result);
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run all three gates over a set of questions.
 *
 * @param {Array}  questions
 * @param {object} ctx  - { topic, syllabusExcerpt, round }
 * @param {object} deps - { aiProvider, analyzeWithClaude, blindSolve, judgeQuestion }
 * @returns {Promise<{ passed:Array, rejected:Array<{question,reasons}>, report:object }>}
 */
async function runQa(questions, ctx = {}, deps = {}) {
  const list = Array.isArray(questions) ? questions : [];
  const round = ctx.round != null ? ctx.round : 0;
  const solveFn = deps.blindSolve || blindSolve;
  const judgeFn = deps.judgeQuestion || judgeQuestion;
  const llmDeps = {
    aiProvider: deps.aiProvider,
    analyzeWithClaude: deps.analyzeWithClaude,
  };

  const dedup = checkDedup(list);
  const dupIndexes = new Map(dedup.map((d) => [d.index, d]));
  const letterDistribution = checkLetterDistribution(list);

  const passed = [];
  const rejected = [];

  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    const qa = { lint: null, solver: null, judge: null, generation: round };

    // Set-level dedup
    if (dupIndexes.has(i)) {
      qa.lint = { passed: false, failures: ['duplicate'] };
      rejected.push({ question: q, reasons: ['duplicate'], qa });
      continue;
    }

    // Gate 1: per-item lint
    const lint = lintQuestion(q, ctx);
    qa.lint = lint;
    if (!lint.passed) {
      rejected.push({ question: q, reasons: lint.failures.slice(), qa });
      continue;
    }

    // Gate 2: blind solve (cross-model)
    const solver = await solveFn(q, llmDeps);
    qa.solver = solver;
    if (!solver.agrees) {
      rejected.push({ question: q, reasons: [solver.valid ? 'solver_mismatch' : 'solver_invalid'], qa });
      continue;
    }

    // Gate 3: judge
    const judge = await judgeFn(q, ctx, llmDeps);
    qa.judge = judge;
    if (judge.verdict !== 'accept') {
      rejected.push({ question: q, reasons: judge.reasons || ['judge_reject'], qa });
      continue;
    }

    // Passed all gates — attach qa for persistence
    q.qa = qa;
    passed.push(q);
  }

  const report = {
    round,
    total: list.length,
    passedCount: passed.length,
    rejectedCount: rejected.length,
    letterDistribution,
    rejections: rejected.map((r) => ({ reasons: r.reasons })),
  };

  return { passed, rejected, report };
}

module.exports = {
  runQa,
  gate1Filter,
  blindSolve,
  judgeQuestion,
  lintQuestion,
  // Gate-1 pure checks (exported individually for tests)
  checkSchema,
  checkFourDistinctOptions,
  checkSingleKey,
  checkLetterDistribution,
  checkLengthBias,
  checkStemKeywordLeak,
  checkTopicEcho,
  checkDedup,
  stemToken,
  // shape validators
  shapeSolver,
  shapeJudge,
  _helpers: { normalizeQuestion, resolveKeyIndex, tokenize, stemJaccard, letterOf },
  constants: {
    KEYWORD_MIN_LEN, TOPIC_TOKEN_MIN_LEN, LENGTH_BIAS_RATIO,
    LETTER_SKEW_RATIO, DEDUP_JACCARD, SOLVER_MIN_CONFIDENCE, JUDGE_MIN_SCORE, JUDGE_DIMENSIONS,
    TOPIC_PREFIX_MIN_LEN, STEM_PREFIX_LEN,
  },
};

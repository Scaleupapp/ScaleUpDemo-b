/**
 * Prerequisite Graph Service — BUG-8 Phase 7
 *
 * Maintains a per-concept graph of "what should be solid before X clicks"
 * and walks it backwards to find the root cause when a user is struggling
 * with a downstream concept.
 *
 * Public API:
 *   ensureExtracted(concept, domain?)
 *     — fire-and-forget: if we don't have prerequisites for this concept
 *       yet (or extraction failed), kick off a GPT extraction
 *   getRootCause(userId, strugglingConcept, profile, dueConcepts)
 *     — walks the graph backward from the struggling concept, returning
 *       the first prerequisite the user is weak at (low score or
 *       overdue for review). Null if no clear root cause.
 *
 * Production note: GPT auto-extraction is good for an initial signal but
 * not authoritative. A future curation workflow should let editors
 * promote/edit these graphs (source goes from 'gpt_auto' to 'curated').
 */

const ConceptPrerequisite = require('../models/ConceptPrerequisite');
const openai = require('../config/openai');

const T = {
  MAX_EXTRACTION_ATTEMPTS: 3,
  EXTRACTION_RETRY_BACKOFF_DAYS: 7,
  TRAVERSAL_MAX_DEPTH: 3,        // don't walk past great-grandparents
  TRAVERSAL_MIN_EDGE_WEIGHT: 0.4, // ignore weak dependencies
  WEAK_SCORE_THRESHOLD: 60,       // a prerequisite below this is "weak enough to be the cause"
};

const EXTRACTION_SYSTEM_PROMPT = `You are an educational dependency analyst. Given a concept and its domain, list the 1-4 PREREQUISITE concepts a learner needs to understand FIRST.

ABSOLUTE RULES:
1. Prerequisites are concepts that must be solid BEFORE this one will click. NOT related concepts. NOT applications. Strict prerequisites only.
2. Each prerequisite is a single short phrase, lowercase, normalized (e.g. "chain rule", "matrix multiplication", "sql joins"). NO sentences, NO explanations.
3. Each prerequisite carries a weight 0.0–1.0:
   - 1.0 = you cannot understand the concept without this
   - 0.7 = strongly helpful, learner will struggle without it
   - 0.4 = somewhat helpful adjacent foundation
   - <0.4 = don't include
4. Limit to 4 prerequisites max. Pick the most important if there are more.
5. If the concept has no real prerequisites (it IS foundational), return an empty array.

OUTPUT: strict JSON: { "prerequisites": [ { "concept": "string", "weight": number }, ... ] }`;

// ──────────────────────────────────────────────────────────────
// Extraction
// ──────────────────────────────────────────────────────────────

async function ensureExtracted(concept, domain = null) {
  const norm = (concept || '').toString().toLowerCase().trim();
  if (!norm) return null;

  const existing = await ConceptPrerequisite.findOne({ concept: norm });
  if (existing && existing.prerequisites?.length > 0) return existing;
  if (existing) {
    // Empty extraction or previous failure — backoff before retrying
    const tooManyAttempts = (existing.extractionAttempts || 0) >= T.MAX_EXTRACTION_ATTEMPTS;
    const tooSoon = existing.lastExtractedAt &&
      (Date.now() - new Date(existing.lastExtractedAt).getTime()) < T.EXTRACTION_RETRY_BACKOFF_DAYS * 86400000;
    if (tooManyAttempts || tooSoon) return existing;
  }
  if (!process.env.OPENAI_API_KEY) return null;

  // Fire the extraction
  let extracted = [];
  let success = false;
  try {
    const userMsg = domain
      ? `Concept: "${concept}"\nDomain: "${domain}"\n\nList the prerequisites.`
      : `Concept: "${concept}"\n\nList the prerequisites.`;
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 250,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content;
    const parsed = JSON.parse(raw || '{}');
    if (Array.isArray(parsed.prerequisites)) {
      extracted = parsed.prerequisites
        .filter(p => p && typeof p.concept === 'string' && typeof p.weight === 'number')
        .map(p => ({ prerequisite: p.concept.toLowerCase().trim(), weight: Math.min(1, Math.max(0, p.weight)) }))
        .filter(p => p.prerequisite && p.weight >= T.TRAVERSAL_MIN_EDGE_WEIGHT)
        .filter(p => p.prerequisite !== norm) // never list self as prerequisite
        .slice(0, 4);
      success = true;
    }
  } catch (err) {
    console.warn('[prerequisiteGraph] extraction failed:', err.message);
  }

  const update = {
    concept: norm,
    domain: domain ? domain.toLowerCase() : undefined,
    prerequisites: extracted,
    source: 'gpt_auto',
    lastExtractedAt: new Date(),
    $inc: { extractionAttempts: 1 },
  };
  // Mongoose's findOneAndUpdate doesn't allow mixing $inc with $set in one
  // object — split them.
  const { $inc, ...setFields } = update;
  await ConceptPrerequisite.findOneAndUpdate(
    { concept: norm },
    { $set: setFields, $inc },
    { upsert: true, new: true }
  );

  return ConceptPrerequisite.findOne({ concept: norm }).lean();
}

// ──────────────────────────────────────────────────────────────
// Root-cause traversal
// ──────────────────────────────────────────────────────────────

/**
 * Walk the prerequisite graph backward from a struggling concept and
 * return the weakest prerequisite the user is currently shaky on.
 *
 * @param userId   Mongo ObjectId | string
 * @param strugglingConcept  string — concept the user is doing badly at
 * @param profile  KnowledgeProfile lean object — for current scores
 * @param dueConcepts Array<{concept,...}> — from spacedRepetitionService
 * @returns { rootCause: string, weight: number, scoreAtCause: number, depth: number, path: string[] } | null
 */
async function getRootCause(userId, strugglingConcept, profile, dueConcepts) {
  const norm = (strugglingConcept || '').toString().toLowerCase().trim();
  if (!norm || !profile?.topicMastery) return null;

  const dueSet = new Set((dueConcepts || []).map(d => (d.concept || '').toLowerCase()));
  const visited = new Set();
  const queue = [{ concept: norm, depth: 0, path: [norm], weight: 1 }];

  while (queue.length) {
    const { concept, depth, path, weight } = queue.shift();
    if (visited.has(concept)) continue;
    visited.add(concept);
    if (depth >= T.TRAVERSAL_MAX_DEPTH) continue;

    const node = await ConceptPrerequisite.findOne({ concept }).lean();
    if (!node?.prerequisites?.length) continue;

    // Inspect each prerequisite
    for (const edge of node.prerequisites) {
      if (visited.has(edge.prerequisite)) continue;
      if (edge.weight < T.TRAVERSAL_MIN_EDGE_WEIGHT) continue;

      const score = _topicScore(profile, edge.prerequisite);
      const isOverdue = dueSet.has(edge.prerequisite);

      // Hit: this prerequisite is weak (or overdue)
      if ((score != null && score < T.WEAK_SCORE_THRESHOLD) || isOverdue) {
        return {
          rootCause: edge.prerequisite,
          weight: edge.weight * weight,
          scoreAtCause: score,
          isOverdue,
          depth: depth + 1,
          path: [...path, edge.prerequisite],
        };
      }
      // Otherwise, add to queue to keep walking back
      queue.push({
        concept: edge.prerequisite,
        depth: depth + 1,
        path: [...path, edge.prerequisite],
        weight: edge.weight * weight,
      });
    }
  }

  return null;
}

function _topicScore(profile, topic) {
  const t = topic.toLowerCase();
  const tm = profile.topicMastery?.find(x => (x.topic || '').toLowerCase() === t);
  return tm?.score ?? null;
}

module.exports = {
  ensureExtracted,
  getRootCause,
  _internal: { _topicScore, T, EXTRACTION_SYSTEM_PROMPT },
};

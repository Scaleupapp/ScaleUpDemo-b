const openai = require('../config/openai');
const { CANONICAL_TOPICS, topicsForObjectiveType, findBySlug } = require('../config/canonicalTopics');
const normalizeTopic = require('../utils/normalizeTopic');

const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const CACHE_MAX_ENTRIES = 5000;
const _cache = new Map(); // key → { value, expiresAt }

function _cacheKey(rawText, objectiveType) {
  return `${objectiveType}::${(rawText || '').trim().toLowerCase()}`;
}

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    if (entry) _cache.delete(key);
    return null;
  }
  return entry.value;
}

function _cacheSet(key, value) {
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    // Simple eviction: drop the oldest 10%.
    const drop = Math.floor(CACHE_MAX_ENTRIES * 0.1);
    let i = 0;
    for (const k of _cache.keys()) {
      _cache.delete(k);
      if (++i >= drop) break;
    }
  }
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _buildPrompt(rawText, objectiveType) {
  const choices = topicsForObjectiveType(objectiveType);
  const list = choices
    .map(c => `- ${c.slug}${c.aliases.length ? ` (also: ${c.aliases.join(', ')})` : ''}`)
    .join('\n');
  return `Map this user's free-text goal to ONE canonical topic slug from the list below.

User's objective type: ${objectiveType}
User's free-text goal: "${rawText}"

Allowed canonical topics for this objective type:
${list}

Rules:
- Return ONLY a JSON object: {"canonicalTopic": "<slug>", "confidence": 0.0-1.0}.
- Pick the most specific slug that fits.
- If nothing fits with confidence >= 0.5, return {"canonicalTopic": "general-learning", "confidence": 0.5}.
- Do not invent a slug that is not in the list.`;
}

/**
 * Canonicalize a user's free-text objective into a cohort key.
 *
 * @param {string} rawText - User's free-text goal (e.g., "Senior PM at FAANG").
 * @param {string} objectiveType - One of exam_preparation, interview_preparation, upskilling, career_switch.
 * @returns {Promise<{canonicalTopic: string, confidence: number, source: 'llm'|'cache'|'llm-coerced'|'fallback'|'empty'}>}
 */
async function canonicalize(rawText, objectiveType) {
  if (!rawText || !rawText.trim()) {
    return { canonicalTopic: 'general-learning', confidence: 0.5, source: 'empty' };
  }

  const cacheKey = _cacheKey(rawText, objectiveType);
  const cached = _cacheGet(cacheKey);
  if (cached) return { ...cached, source: 'cache' };

  let parsed = null;
  let llmError = null;
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.CANONICALIZATION_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You map free-text goals to canonical cohort slugs. Output only JSON.' },
        { role: 'user', content: _buildPrompt(rawText, objectiveType) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 60,
    });
    const text = resp.choices?.[0]?.message?.content || '{}';
    parsed = JSON.parse(text);
  } catch (err) {
    llmError = err;
  }

  if (llmError || !parsed || typeof parsed.canonicalTopic !== 'string') {
    const fallback = normalizeTopic(rawText) || 'general-learning';
    const result = { canonicalTopic: fallback, confidence: 0, source: 'fallback' };
    // Do NOT cache fallback — the LLM might recover next time.
    return result;
  }

  // Validate the returned slug against the allowed taxonomy for this type.
  const allowed = new Set(topicsForObjectiveType(objectiveType).map(t => t.slug));
  if (!allowed.has(parsed.canonicalTopic)) {
    const result = { canonicalTopic: 'general-learning', confidence: Number(parsed.confidence) || 0.3, source: 'llm-coerced' };
    _cacheSet(cacheKey, result);
    return result;
  }

  const result = {
    canonicalTopic: parsed.canonicalTopic,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    source: 'llm',
  };
  _cacheSet(cacheKey, result);
  return result;
}

module.exports = {
  canonicalize,
  _internal: {
    clearCache: () => _cache.clear(),
    cacheSize: () => _cache.size,
  },
};

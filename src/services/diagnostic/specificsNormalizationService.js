const { OpenAI } = require('openai');

const TIMEOUT_MS = 3000;
const MODEL = 'gpt-4o-mini';

const SCHEMA = {
  name: 'normalized_specifics',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      examName: { type: ['string', 'null'] },
      targetSkill: { type: ['string', 'null'] },
      targetRole: { type: ['string', 'null'] },
      targetCompany: { type: ['string', 'null'] },
      fromDomain: { type: ['string', 'null'] },
      toDomain: { type: ['string', 'null'] },
    },
    required: ['examName', 'targetSkill', 'targetRole', 'targetCompany', 'fromDomain', 'toDomain'],
  },
};

let _client = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

function hasAnyValue(obj) {
  return obj && Object.values(obj).some((v) => typeof v === 'string' && v.trim().length > 0);
}

function stripNulls(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

const SYSTEM_PROMPT = `You are a normalization helper for an Indian learning app.
Given a user's onboarding "specifics" (free-text fields they typed), return canonical, properly-cased forms.
Examples:
  "jee" -> "JEE Advanced"
  "goog" / "google india" -> "Google"
  "sys design" -> "System Design"
  "fe" -> "Frontend"
  "ml engineer" -> "Machine Learning Engineer"
Preserve the field semantics. Use null for fields the user did not provide.
For any field you cannot confidently normalize, return the user's input verbatim (do NOT invent values).`;

async function normalizeSpecifics({ objectiveType, specifics }) {
  const raw = specifics || {};
  if (!hasAnyValue(raw)) return {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await client().chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: SCHEMA },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({ objectiveType, specifics: raw }),
        },
      ],
    }, { signal: controller.signal });

    clearTimeout(timer);

    const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
    if (!content) {
      console.warn('[specificsNormalization] empty LLM content, falling back to raw');
      return stripNulls(raw);
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.warn('[specificsNormalization] JSON parse failed, falling back to raw:', e.message);
      return stripNulls(raw);
    }
    return stripNulls(parsed);
  } catch (err) {
    clearTimeout(timer);
    console.warn('[specificsNormalization] LLM call failed, falling back to raw:', err.message);
    return stripNulls(raw);
  }
}

module.exports = { normalizeSpecifics };

function canonicalize(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildTargetKey(objectiveType, specifics = {}) {
  const parts = [objectiveType];
  switch (objectiveType) {
    case 'upskilling':
      parts.push(canonicalize(specifics.targetSkill || 'general'));
      break;
    case 'interview_preparation':
      parts.push(canonicalize(specifics.targetRole || 'general'));
      if (specifics.targetCompany) {
        parts.push(canonicalize(specifics.targetCompany));
      }
      break;
    case 'exam_preparation':
      parts.push(canonicalize(specifics.examName || 'general'));
      break;
    case 'career_switch':
      parts.push(canonicalize(specifics.fromDomain || 'general'));
      parts.push(canonicalize(specifics.toDomain || 'general'));
      break;
    case 'academic_excellence':
      parts.push(canonicalize(specifics.board || 'general'));
      if (specifics.grade) parts.push(canonicalize(specifics.grade));
      if (specifics.subject) parts.push(canonicalize(specifics.subject));
      break;
    case 'casual_learning':
    case 'networking':
    default:
      parts.push(canonicalize(specifics.area || 'general'));
      break;
  }
  return parts.join('::');
}

const TAXONOMY_LLM_TIMEOUT_MS = 30_000;
const LLM_MODEL = 'gpt-4o';

const TAXONOMY_RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'topic_taxonomy',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['topics'],
      properties: {
        topics: {
          type: 'array',
          minItems: 4,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'canonicalName', 'description', 'baseDifficulty', 'isFutureProofing', 'sortOrder'],
            properties: {
              name: { type: 'string', minLength: 2, maxLength: 80 },
              canonicalName: { type: 'string', pattern: '^[a-z0-9-]+$' },
              description: { type: 'string', minLength: 10, maxLength: 240 },
              baseDifficulty: { type: 'string', enum: ['foundational', 'intermediate', 'advanced'] },
              isFutureProofing: { type: 'boolean' },
              sortOrder: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are an India-first curriculum architect for ScaleUp.
Given an (objectiveType, targetKey), produce 4-8 topics that comprehensively
cover what a learner needs to master for that target.

CONSTRAINTS:
- Names are concrete and pedagogically meaningful (avoid "General Knowledge" — be specific).
- canonicalName is lowercase-kebab, 2-4 words, used as a stable database key.
- description is one sentence describing what the topic covers.
- baseDifficulty matches the topic's typical learning curve, not the user's level.
- isFutureProofing: true ONLY if the topic is about emerging skills (AI literacy, etc.) for upskilling/career_switch contexts. Most topics are false.
- For Indian exam_preparation targetKeys, mirror the actual exam syllabus.
- For state board academic_excellence targetKeys, mirror the state's official curriculum.
- For interview_preparation, weight by company/role expectations.

Output STRICT JSON with the schema provided. No prose outside JSON.`;

function parseTargetKey(targetKey) {
  if (typeof targetKey !== 'string' || !targetKey.includes('::')) {
    throw new Error('invalid targetKey: ' + targetKey);
  }
  const [objectiveType, ...specifics] = targetKey.split('::');
  return { objectiveType, specifics };
}

function buildUserPrompt(targetKey) {
  const { objectiveType, specifics } = parseTargetKey(targetKey);
  return JSON.stringify({
    objectiveType,
    targetKey,
    specifics,
    instruction: 'Produce the topic taxonomy for this target.',
  }, null, 2);
}

async function callLLMForTaxonomy(targetKey) {
  const openai = require('../../config/openai');
  const completion = await Promise.race([
    openai.chat.completions.create({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(targetKey) },
      ],
      response_format: TAXONOMY_RESPONSE_SCHEMA,
      temperature: 0.3,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TAXONOMY_LLM_TIMEOUT')), TAXONOMY_LLM_TIMEOUT_MS)),
  ]);
  const raw = completion?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('TAXONOMY_LLM_EMPTY_RESPONSE');
  return JSON.parse(raw);
}

async function generateTaxonomyForTargetKey(targetKey) {
  const { objectiveType } = parseTargetKey(targetKey);  // throws on malformed key
  const TopicTaxonomy = require('../../models/TopicTaxonomy');

  // If already seeded, return as-is — don't regenerate.
  const existing = await TopicTaxonomy.findOne({ objectiveType, targetKey });
  if (existing) return existing;

  const llmResult = await callLLMForTaxonomy(targetKey);
  const doc = await TopicTaxonomy.create({
    objectiveType,
    targetKey,
    source: 'llm-generated',
    topics: llmResult.topics,
  });
  return doc;
}

module.exports = { canonicalize, buildTargetKey, generateTaxonomyForTargetKey, parseTargetKey };

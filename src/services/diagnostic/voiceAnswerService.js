const openai = require('../../config/openai');
const { OPENAI_CHAT_MODEL } = require('../../config/openaiModels');
const fetch = require('node-fetch');

const SCORING_SCHEMA = {
  name: 'voice_answer_scoring',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      structureScore: { type: 'integer', minimum: 0, maximum: 100 },
      specificityScore: { type: 'integer', minimum: 0, maximum: 100 },
      relevanceScore: { type: 'integer', minimum: 0, maximum: 100 },
      articulationScore: { type: 'integer', minimum: 0, maximum: 100 },
      overallScore: { type: 'integer', minimum: 0, maximum: 100 },
      feedback: { type: 'string' },
    },
    required: ['structureScore', 'specificityScore', 'relevanceScore', 'articulationScore', 'overallScore', 'feedback'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You are a strict interviewer scoring a candidate's verbal answer to a diagnostic question.

Score each dimension 0-100:
- Structure: STAR / CARL adherence where applicable; logical flow; clear opening + middle + close
- Specificity: concrete examples vs abstract claims; named metrics; actual situations
- Relevance: addresses the prompt directly; no tangents
- Articulation: clarity, conciseness, no filler words

Then compute overallScore = weighted average favouring structure (30%) + specificity (30%) + relevance (25%) + articulation (15%).

Provide one-sentence actionable feedback.

India context: Indian English / Hinglish phrasing is acceptable. Score for substance, not accent.`;

function scoreToBand(score) {
  if (score < 30) return 'novice';
  if (score < 55) return 'familiar';
  if (score < 80) return 'proficient';
  return 'expert';
}

async function transcribeAudio({ audioUrl, audioBuffer, opts = {} }) {
  const timeoutMs = opts.timeoutMs || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let stream;
    if (audioBuffer) {
      stream = audioBuffer;
    } else if (audioUrl) {
      const res = await fetch(audioUrl);
      stream = await res.buffer();
    } else {
      throw new Error('Either audioUrl or audioBuffer required');
    }
    const result = await openai.audio.transcriptions.create(
      { file: stream, model: 'whisper-1' },
      { signal: controller.signal }
    );
    return { text: result.text };
  } finally {
    clearTimeout(timer);
  }
}

async function scoreVoiceAnswer({ transcription, questionText, canonicalCompetency, opts = {} }) {
  const timeoutMs = opts.timeoutMs || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: OPENAI_CHAT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Topic: ${canonicalCompetency}
Question: ${questionText}
Candidate's answer: ${transcription}

Score this answer.`,
          },
        ],
        response_format: { type: 'json_schema', json_schema: SCORING_SCHEMA },
        temperature: 0.3,
        max_tokens: 600,
      },
      { signal: controller.signal }
    );
    const parsed = JSON.parse(completion.choices[0].message.content);
    return {
      ...parsed,
      band: scoreToBand(parsed.overallScore),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function processVoiceAnswer({ audioUrl, audioBuffer, questionText, canonicalCompetency }) {
  try {
    const transcription = await transcribeAudio({ audioUrl, audioBuffer });
    const scoring = await scoreVoiceAnswer({
      transcription: transcription.text,
      questionText,
      canonicalCompetency,
    });
    return {
      success: true,
      transcription: transcription.text,
      ...scoring,
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
      fallbackToTyped: true,
    };
  }
}

module.exports = { transcribeAudio, scoreVoiceAnswer, scoreToBand, processVoiceAnswer };

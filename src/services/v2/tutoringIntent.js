// src/services/v2/tutoringIntent.js
'use strict';

/**
 * Detects when a Compass user is asking to be TUTORED on a topic (vs a coding
 * drill — see compassIntent.js). Two-stage: keyword pre-filter → cheap Haiku
 * classifier. Returns a `start_tutoring` action or null. Never throws.
 */

const TUTORING_REQUEST_KEYWORDS = [
  'tutor me', 'help me get better', 'help me improve', 'teach me',
  'get better at', 'improve at', 'improve on', 'help me understand',
  'help me with', 'explain and quiz', 'work on my', 'i keep messing up',
  'i keep getting', "i'm weak", 'im weak', 'struggle with',
];

function maybeIsTutoringRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return TUTORING_REQUEST_KEYWORDS.some((kw) => lower.includes(kw));
}

async function detectTutoringRequest(userMessage) {
  if (!maybeIsTutoringRequest(userMessage)) return null;
  const system = `You are an intent classifier for a learning platform. The user is chatting with their AI tutor. Determine if they are asking to be tutored/coached on a specific topic so they can improve at it.

If they ARE asking to be tutored on a topic, return JSON:
{ "is_tutoring_request": true, "topic": "<the topic, short, lowercase>" }

If they are NOT (general chat, a content question, asking for a coding drill, vague life advice), return:
{ "is_tutoring_request": false }

Return STRICT JSON only. No prose. No markdown fences.`;
  try {
    const { llmCall } = require('../../coding/services/llmRouter');
    const res = await llmCall({ taskId: 'drill_grade_prompt', system, messages: [{ role: 'user', content: userMessage }] });
    const { parseLLMJson } = require('../../coding/services/drillGrader/parseLLMJson');
    const parsed = parseLLMJson(res.content);
    if (!parsed || !parsed.is_tutoring_request) return null;
    return { type: 'start_tutoring', topic: (parsed.topic || '').toString().trim().toLowerCase() || null, score: null };
  } catch (e) {
    console.error('[tutoringIntent.detectTutoringRequest]', e.message);
    return null;
  }
}

module.exports = { detectTutoringRequest, maybeIsTutoringRequest };

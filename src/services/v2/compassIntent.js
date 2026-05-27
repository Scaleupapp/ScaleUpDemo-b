'use strict';

/**
 * Lightweight intent detection for Compass user messages.
 *
 * Used by the Compass orchestrator to detect when a user is asking for a
 * coding practice drill mid-conversation, so it can append a `suggested_action`
 * to the response that iOS renders as a "Start drill" action card.
 *
 * Two-stage approach:
 *   1. Keyword pre-filter — O(1), eliminates ~90%+ of messages before any LLM call.
 *   2. LLM intent classifier — runs only when keywords match; cheap Haiku-class call
 *      that returns structured JSON.
 *
 * This module is deliberately self-contained so it can be unit-tested without
 * wiring up the full Compass context.
 */

const DRILL_REQUEST_KEYWORDS = [
  'drill', 'practice', 'coding exercise', 'another one', 'give me',
  'more practice', 'prompt drill', 'verify drill', 'decompose', 'bug hunt',
  'extra drill',
];

/**
 * Fast keyword pre-filter. Returns true if the message contains any drill-request
 * keyword. Case-insensitive. No LLM call.
 *
 * @param {string} text
 * @returns {boolean}
 */
function maybeIsDrillRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return DRILL_REQUEST_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Detect if the user is requesting a coding drill. Returns a structured action
 * object when intent is confirmed, or null otherwise.
 *
 * Falls back gracefully (returns null) on LLM errors — never throws.
 *
 * @param {string} userMessage
 * @returns {Promise<{ type: 'request_drill', drill_subtype: string|null, difficulty: string|null, topic_hint: string|null } | null>}
 */
async function detectDrillRequest(userMessage) {
  if (!maybeIsDrillRequest(userMessage)) return null;

  const system = `You are an intent classifier for a learning platform. The user is chatting with their AI tutor. Determine if they are asking to take a coding practice drill.

If they ARE asking for a drill, return JSON:
{
  "is_drill_request": true,
  "drill_subtype": "prompt" | "verify" | "decompose" | null,
  "difficulty": "easy" | "medium" | "hard" | null,
  "topic_hint": "<short string>" | null
}

If they are NOT asking for a drill (e.g. asking a content question, asking for explanation, expressing frustration, etc.):
{ "is_drill_request": false }

Return STRICT JSON only. No prose. No markdown fences.`;

  try {
    const { llmCall } = require('../../coding/services/llmRouter');
    const res = await llmCall({
      taskId: 'drill_grade_prompt',  // Reuse Haiku routing — fast + cheap for classification
      system,
      messages: [{ role: 'user', content: userMessage }],
    });

    const { parseLLMJson } = require('../../coding/services/drillGrader/parseLLMJson');
    const parsed = parseLLMJson(res.content);
    if (!parsed || !parsed.is_drill_request) return null;

    return {
      type: 'request_drill',
      drill_subtype: parsed.drill_subtype || null,
      difficulty: parsed.difficulty || null,
      topic_hint: parsed.topic_hint || null,
    };
  } catch (e) {
    console.error('[compassIntent.detectDrillRequest]', e.message);
    return null;
  }
}

module.exports = { detectDrillRequest, maybeIsDrillRequest };

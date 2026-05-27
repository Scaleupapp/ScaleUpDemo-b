'use strict';

/**
 * Parse a JSON response from an LLM. Strips ```json...``` or ```...``` markdown
 * fences if present, then JSON.parse. Used by all drill graders because
 * Claude (and other LLMs) sometimes wrap structured output in fences despite
 * explicit "return strict JSON" instructions.
 *
 * @param {Array} content - The Anthropic API response content array
 *                          (e.g. [{ type: 'text', text: '...' }])
 * @returns {object} parsed JSON
 * @throws if no text block, or if stripped text isn't valid JSON
 */
function parseLLMJson(content) {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('LLM response content is not an array or is empty');
  }
  const textBlock = content.find(c => c && (c.type === 'text' || typeof c.text === 'string'));
  if (!textBlock) {
    throw new Error('No text block in LLM response');
  }

  let text = textBlock.text || '';

  // Strip ```json ... ``` or ``` ... ``` fences if present.
  // Use [\s\S] to match across newlines (JS regex `.` doesn't match \n).
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1];
  }

  text = text.trim();

  if (!text) {
    throw new Error('LLM response text is empty after fence stripping');
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    // Surface the first 200 chars so debugging is easier in logs
    const snippet = text.slice(0, 200).replace(/\n/g, '\\n');
    throw new Error(`LLM response is not valid JSON: ${e.message} | snippet: "${snippet}"`);
  }
}

module.exports = { parseLLMJson };

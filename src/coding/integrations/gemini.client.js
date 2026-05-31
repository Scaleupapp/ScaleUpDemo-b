'use strict';

/**
 * Gemini integration client using @google/generative-ai SDK.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} [opts.system]
 * @param {string|Array} opts.prompt  — string prompt or messages array
 * @param {Array}  [opts.tools]
 * @returns {Promise<{content: object, usage: object}>}
 */
async function call({ model, system, prompt, tools }) {
  const cfg = { model, systemInstruction: system };
  // Gemini expects tool entries as objects (functionDeclarations / codeExecution);
  // only attach when non-empty so a stray string/empty array can't 400 the call.
  if (Array.isArray(tools) && tools.length > 0) cfg.tools = tools;
  const m = genAI.getGenerativeModel(cfg);
  const res = await m.generateContent(prompt);
  return {
    content: res.response.candidates[0].content,
    usage: res.response.usageMetadata,
  };
}

module.exports = { call };

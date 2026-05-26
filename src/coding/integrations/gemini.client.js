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
  const m = genAI.getGenerativeModel({ model, systemInstruction: system, tools });
  const res = await m.generateContent(prompt);
  return {
    content: res.response.candidates[0].content,
    usage: res.response.usageMetadata,
  };
}

module.exports = { call };

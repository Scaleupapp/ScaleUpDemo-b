'use strict';

const Joi = require('joi');

const promptSubmission = Joi.object({
  prompt_text: Joi.string().min(10).max(8000).required(),
});

const verifySubmission = Joi.object({
  bug_locations: Joi.array().items(Joi.object({
    file: Joi.string().required(),
    line: Joi.number().integer().min(0).required(),
    explanation: Joi.string().min(5).max(2000).required(),
  })).min(1).required(),
});

const decomposeSubmission = Joi.object({
  decomposition_steps: Joi.array().items(Joi.object({
    step: Joi.string().required(),
    rationale: Joi.string().required(),
  })).min(2).max(10).required(),
});

const refactorSubmission = Joi.object({
  refactored_code: Joi.object({
    files: Joi.array().items(Joi.object({
      path: Joi.string().required(),
      content: Joi.string().required(),
    })).min(1).required(),
  }).required(),
});

const subtypeSchemas = {
  prompt: promptSubmission,
  verify: verifySubmission,
  decompose: decomposeSubmission,
  refactor: refactorSubmission,
};

function validateDrillSubmission(payload) {
  const outer = Joi.object({
    drill_subtype: Joi.string().valid('prompt', 'verify', 'decompose', 'refactor').required(),
    submission: Joi.object().required(),
  }).validate(payload);
  if (outer.error) return outer;
  const inner = subtypeSchemas[payload.drill_subtype].validate(payload.submission);
  return inner;
}

function validateDrillStart(payload) {
  return Joi.object({
    role_track: Joi.string().valid('swe', 'ds', 'ai_eng').required(),
    difficulty: Joi.string().valid('easy', 'medium', 'hard').required(),
    drill_subtype: Joi.string().valid('prompt', 'verify', 'decompose', 'refactor').required(),
    is_calibration: Joi.boolean().default(false),
  }).validate(payload);
}

module.exports = { validateDrillSubmission, validateDrillStart };

const Joi = require('joi');

const requestOnDemand = Joi.object({
  topic: Joi.string().required(),
  contentIds: Joi.array().items(Joi.string()).min(1).required(),
});

const submitAnswer = Joi.object({
  questionIndex: Joi.number().integer().min(0).required(),
  selectedAnswer: Joi.string().valid('A', 'B', 'C', 'D', 'skipped').required(),
  timeTaken: Joi.number().min(0).optional(),
});

module.exports = { requestOnDemand, submitAnswer };

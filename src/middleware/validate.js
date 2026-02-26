const ApiError = require('../utils/apiError');

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    const messages = error.details.map((d) => d.message).join(', ');
    throw new ApiError(400, messages);
  }
  req.body = value;
  next();
};

module.exports = validate;

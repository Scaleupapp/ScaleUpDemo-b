const redis = require('../config/redis');
const ApiError = require('../utils/apiError');

const rateLimiter = ({ windowMs = 60000, max = 100, keyPrefix = 'rl' } = {}) => {
  return async (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}`;
    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.pexpire(key, windowMs);
      }
      if (current > max) {
        return next(new ApiError(429, 'Too many requests, please try again later'));
      }
      return next();
    } catch (err) {
      // If Redis is down or any other error, allow the request (fail-open)
      return next();
    }
  };
};

module.exports = rateLimiter;

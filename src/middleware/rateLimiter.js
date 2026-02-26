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
        throw new ApiError(429, 'Too many requests, please try again later');
      }
      next();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // If Redis is down, allow the request
      next();
    }
  };
};

module.exports = rateLimiter;

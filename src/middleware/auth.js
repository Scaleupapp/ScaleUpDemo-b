const jwt = require('jsonwebtoken');
const ApiError = require('../utils/apiError');

const auth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    throw new ApiError(401, 'Access token required');

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = { userId: decoded.userId, role: decoded.role };
    next();
  } catch (err) {
    throw new ApiError(401, 'Invalid or expired token');
  }
};

module.exports = auth;

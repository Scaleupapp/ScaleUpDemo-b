const ApiError = require('../utils/apiError');

const rbac = (...allowedRoles) => (req, res, next) => {
  if (!req.user) throw new ApiError(401, 'Authentication required');
  if (!allowedRoles.includes(req.user.role))
    throw new ApiError(403, 'Insufficient permissions');
  next();
};

module.exports = rbac;

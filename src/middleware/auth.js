const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiError = require('../utils/apiError');

// In-memory cache for user status (avoids DB hit on every request)
const statusCache = new Map(); // userId -> { isActive, isBanned, checkedAt }
const CACHE_TTL_MS = 60 * 1000; // 1 minute

const auth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return next(new ApiError(401, 'Access token required'));

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = { userId: decoded.userId, role: decoded.role };

    // Check user status (cached)
    const cached = statusCache.get(decoded.userId);
    if (cached && (Date.now() - cached.checkedAt) < CACHE_TTL_MS) {
      if (cached.isBanned) {
        return next(new ApiError(403, 'Your account has been suspended.'));
      }
      if (!cached.isActive) {
        return next(new ApiError(403, 'Account deactivated. Log in again to reactivate.'));
      }
    } else {
      const user = await User.findById(decoded.userId).select('isActive isBanned').lean();
      if (!user) return next(new ApiError(401, 'User no longer exists'));
      statusCache.set(decoded.userId, { isActive: user.isActive, isBanned: user.isBanned, checkedAt: Date.now() });
      if (user.isBanned) {
        return next(new ApiError(403, 'Your account has been suspended.'));
      }
      if (!user.isActive) {
        return next(new ApiError(403, 'Account deactivated. Log in again to reactivate.'));
      }
    }

    next();
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    return next(new ApiError(401, 'Invalid or expired token'));
  }
};

// Clear cache entry when user status changes (reactivate, deactivate, ban, unban)
auth.clearCache = (userId) => {
  statusCache.delete(userId);
};

module.exports = auth;

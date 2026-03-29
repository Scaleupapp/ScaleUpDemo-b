const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiError = require('../utils/apiError');

// In-memory cache for deactivated users (avoids DB hit on every request)
const deactivatedCache = new Map(); // userId -> { isActive, checkedAt }
const CACHE_TTL_MS = 60 * 1000; // 1 minute

const auth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return next(new ApiError(401, 'Access token required'));

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = { userId: decoded.userId, role: decoded.role };

    // Check if user is deactivated (cached)
    const cached = deactivatedCache.get(decoded.userId);
    if (cached && (Date.now() - cached.checkedAt) < CACHE_TTL_MS) {
      if (!cached.isActive) {
        return next(new ApiError(403, 'Account deactivated. Log in again to reactivate.'));
      }
    } else {
      // Lightweight DB check — only fetch isActive
      const user = await User.findById(decoded.userId).select('isActive').lean();
      if (!user) return next(new ApiError(401, 'User no longer exists'));
      deactivatedCache.set(decoded.userId, { isActive: user.isActive, checkedAt: Date.now() });
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

// Clear cache entry when user reactivates or deactivates
auth.clearCache = (userId) => {
  deactivatedCache.delete(userId);
};

module.exports = auth;
